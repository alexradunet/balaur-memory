/**
 * Lifecycle end-states (SCHEMA.md I6, I8): quarantine — suppression with a
 * conscience — and forget — honest erasure. The two are never conflated
 * (DESIGN.md "Forgetting, honestly"): quarantine hides and can change its
 * mind; forget destroys content and says exactly what it could not reach.
 */

import { deleteFts } from "./indexdb/fts.ts";
import { deleteVectorsFor } from "./indexdb/vectors.ts";
import { flagStaleBySource } from "./lineage.ts";
import { lexicalCandidates, termsFromText } from "./recall.ts";
import { audit, type Ctx, mustGet } from "./spine.ts";
import { MemoryError, type NodeId, parseStrictIso } from "./types.ts";

/**
 * Quarantine: actively suppressed everywhere — recall, search, traversal,
 * and the index all exclude it (the active-only filters ARE the ask-twice:
 * only a deliberate getNode(id) reaches it) — with an optional re-review
 * date so the record doesn't just vanish from tending. Reversible:
 * transition(id, "active") lifts it and clears the review date.
 */
export function quarantine(ctx: Ctx, id: NodeId, reviewAt?: string): void {
  const node = mustGet(ctx, id);
  if (node.status !== "active")
    throw new MemoryError("invalid_transition", `cannot quarantine ${id} from ${node.status}`);
  // Strict ISO-8601 UTC only (review #9) — the shared time rule (TEMPORAL.md).
  const review = reviewAt !== undefined ? parseStrictIso(reviewAt, "reviewAt") : null;
  ctx.mem.run("UPDATE nodes SET status = 'quarantined', review_at = ?, updated = ? WHERE id = ?", [
    review,
    ctx.now().toISOString(),
    id,
  ]);
  // Leave the FTS row's fate to the same rule as any non-active status.
  try {
    deleteFts(ctx.idx, id);
  } catch {
    audit(ctx, "system", "index.scrub", id, false);
  }
  audit(ctx, "owner", "node.quarantine", id, true, { hasReview: review !== null });
}

/** Honest account of a forget cascade (SCHEMA.md I6/I7). */
export interface ForgetReport {
  readonly tombstoned: NodeId;
  readonly edgesDropped: number;
  readonly indexScrubbed: boolean;
  readonly flaggedStale: readonly string[];
  /** What the cascade cannot honestly resolve alone — surfaced, never
   * silently claimed: possible prose mentions in other nodes
   * ("mention:<id>", best-effort lexical candidates on the forgotten
   * title's words), merged husks chained INTO this node ("husk:<id>" —
   * they still hold content and just lost their survivor), and the
   * standing truth that prior exports/backups may retain the content
   * ("external:prior-exports"). */
  readonly needsOwner: readonly string[];
}

// merged joins the set (ENTITIES.md I8 amendment): a husk still holds
// content, and content destruction must remain available for it.
const FORGETTABLE = new Set(["active", "archived", "quarantined", "merged"]);

/**
 * Forget: the honest erasure cascade (I6). Tombstones content in place
 * (row, type, and timestamps survive for referential integrity), drops the
 * node's edges, clears any parked edit, scrubs FTS + vectors, flags derived
 * artifacts stale via lineage, and writes a CONTENT-FREE audit entry (I7).
 * Terminal (I8). "Forgotten" never secretly means "suppressed" — that is
 * what quarantine is for.
 */
export function forget(ctx: Ctx, id: NodeId): ForgetReport {
  const node = mustGet(ctx, id);
  if (!FORGETTABLE.has(node.status))
    throw new MemoryError("invalid_transition", `cannot forget ${id} from ${node.status}`);

  // Best-effort mention candidates — computed BEFORE the title is destroyed.
  const needsOwner: string[] = [];
  const terms = termsFromText(node.title);
  if (terms.length > 0) {
    for (const c of lexicalCandidates(ctx, terms, undefined, 5)) {
      if (c.id !== id) needsOwner.push(`mention:${c.id}`);
    }
  }
  // Merged husks chained into this node — computed BEFORE edges drop.
  for (const r of ctx.mem.query<{ source: string }>(
    "SELECT source FROM edges WHERE target = ? AND type = 'merged_into'",
    [id],
  )) {
    needsOwner.push(`husk:${r.source}`);
  }
  needsOwner.push("external:prior-exports");

  let edgesDropped = 0;
  let flaggedStale: string[] = [];
  ctx.mem.transaction(() => {
    edgesDropped = ctx.mem.run("DELETE FROM edges WHERE source = ? OR target = ?", [id, id]).changes;
    ctx.mem.run("DELETE FROM pending_edits WHERE node_id = ?", [id]); // envelopes carry content too
    ctx.mem.run("DELETE FROM aliases WHERE node_id = ?", [id]); // aliases are content (I6 v2 amendment)
    // Open identity questions about a tombstone are moot — the cascade
    // clears every pending table it touches, this one included (review-2 F5).
    ctx.mem.run("DELETE FROM identity_pending WHERE a = ? OR b = ?", [id, id]);
    // History dies with the tombstone (I16): snapshots are content, and a
    // history table that survives forgetting would make forget a lie. The
    // content-free audit rows survive — that split is the design.
    ctx.mem.run("DELETE FROM memory_history WHERE node_id = ?", [id]);
    flaggedStale = flagStaleBySource(ctx, id);
    ctx.mem.run("DELETE FROM derivations WHERE artifact = ?", [id]); // if it WAS derived, its lineage goes with it
    ctx.mem.run(
      `UPDATE nodes SET title = '', body = '', props = '{}', origin = '', author = '',
         when_at = NULL, status = 'forgotten', review_at = NULL, updated = ? WHERE id = ?`,
      [ctx.now().toISOString(), id],
    );
    audit(ctx, "owner", "forget.cascade", id, true, {
      edgesDropped,
      flaggedStale: flaggedStale.length,
      mentionCandidates: needsOwner.length - 1,
    });
  });

  let indexScrubbed = true;
  try {
    deleteFts(ctx.idx, id);
    deleteVectorsFor(ctx.idx, id);
  } catch {
    indexScrubbed = false;
    audit(ctx, "system", "index.scrub", id, false);
  }

  return { tombstoned: id, edgesDropped, indexScrubbed, flaggedStale, needsOwner };
}
