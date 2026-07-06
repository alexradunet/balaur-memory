/**
 * Identity resolution, Phase A — names (docs/ENTITIES.md). Aliases record
 * what a node also answers to; resolveRef answers "who is 'Ana'?" with
 * CANDIDATES, never a winner; survivorOf walks merged_into chains so hosts
 * never reimplement chain-walking wrong. Candidates and questions (Phase B)
 * and the merge itself (Phase C) build on these names.
 *
 * I2 applies to resolution: `never`-surfaced nodes are invisible to
 * resolveRef; `ask` nodes resolve — the text IS their name. Audit rows for
 * alias verbs carry the node id and the source only, never the alias text
 * (I7: an alias is content — usually a person's name).
 */

import { audit, type Ctx, insertEdge, mustGet, reindexNode } from "./spine.ts";
import { type Edge, type EdgeId, MemoryError, type Node, type NodeId, normalizeText } from "./types.ts";

/** Owner verb: record a name the node also answers to. Idempotent; the
 * node must be active; an alias equal to the node's own title is refused
 * as noise. Reindexes the node so alias hits surface in recall (the FTS
 * `extra` column). */
export function addAlias(ctx: Ctx, id: NodeId, alias: string): void {
  const node = mustGet(ctx, id);
  if (node.status !== "active")
    throw new MemoryError("invalid_transition", `cannot alias ${id} (status=${node.status})`);
  const norm = normalizeText(alias);
  if (norm === "") throw new MemoryError("props_invalid", "alias is required");
  if (norm === normalizeText(node.title))
    throw new MemoryError("props_invalid", "alias equals the node's own title");
  const res = ctx.mem.run(
    `INSERT INTO aliases (alias, node_id, source, created) VALUES (?, ?, 'owner', ?)
     ON CONFLICT(alias, node_id) DO NOTHING`,
    [norm, id, ctx.now().toISOString()],
  );
  if (res.changes === 0) return; // idempotent no-op: no audit row, no reindex
  audit(ctx, "owner", "alias.add", id, true, { source: "owner" });
  reindexNode(ctx, mustGet(ctx, id));
}

/** Owner verb: remove an alias. No-op when absent. */
export function removeAlias(ctx: Ctx, id: NodeId, alias: string): void {
  mustGet(ctx, id); // not_found for ghosts, any status otherwise (cleanup is allowed)
  const res = ctx.mem.run("DELETE FROM aliases WHERE node_id = ? AND alias = ?", [id, normalizeText(alias)]);
  if (res.changes === 0) return;
  audit(ctx, "owner", "alias.remove", id, true, {});
  reindexNode(ctx, mustGet(ctx, id));
}

/** All names the node answers to (normalized), alphabetical. */
export function aliasesOf(ctx: Ctx, id: NodeId): string[] {
  mustGet(ctx, id);
  return ctx.mem
    .query<{ alias: string }>("SELECT alias FROM aliases WHERE node_id = ? ORDER BY alias", [id])
    .map((r) => r.alias);
}

/**
 * Who is "Ana"? Exact-normalized match on titles and aliases within one
 * type, ACTIVE nodes only, candidates ordered oldest-first — the caller
 * (owner or host UI) picks; the library never does. I2: `never` is
 * invisible; `ask` resolves (the text is its name).
 */
export function resolveRef(ctx: Ctx, type: string, text: string): Node[] {
  const wanted = normalizeText(text);
  if (wanted === "") return [];
  const ids = new Set<string>();
  // alias hits (indexed lookup)
  for (const r of ctx.mem.query<{ node_id: string }>("SELECT node_id FROM aliases WHERE alias = ?", [
    wanted,
  ])) {
    ids.add(r.node_id);
  }
  // title hits (normalized in JS — same rule as the gate)
  for (const r of ctx.mem.query<{ id: string; title: string }>(
    "SELECT id, title FROM nodes WHERE type = ? AND status = 'active'",
    [type],
  )) {
    if (normalizeText(r.title) === wanted) ids.add(r.id);
  }
  const out: Node[] = [];
  for (const id of ids) {
    const node = mustGet(ctx, id as NodeId);
    if (node.type !== type || node.status !== "active") continue;
    if (node.surfacing === "never") continue; // I2
    out.push(node);
  }
  out.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
  return out;
}

const CHAIN_CAP = 32;

/** Walk merged_into chains to the living end. A non-merged node returns
 * itself; a corrupt cycle stops at the cap and returns the last node seen
 * (cycles are damaged data — the walk must never hang). */
export function survivorOf(ctx: Ctx, id: NodeId): Node {
  let node = mustGet(ctx, id);
  const seen = new Set<string>([node.id]);
  for (let hops = 0; hops < CHAIN_CAP && node.status === "merged"; hops++) {
    const next = ctx.mem.get<{ target: string }>(
      "SELECT target FROM edges WHERE source = ? AND type = 'merged_into' LIMIT 1",
      [node.id],
    );
    if (next === null || seen.has(next.target)) break;
    seen.add(next.target);
    node = mustGet(ctx, next.target as NodeId);
  }
  return node;
}

// --- Phase B: questions (docs/ENTITIES.md) ---

export type IdentityEvidence = "title_match" | "token_subset" | "alias_match";

/** R2 material: the title's tokens ≥2 chars, or null when none qualify. */
function tokenSet(title: string): Set<string> | null {
  const toks = normalizeText(title)
    .split(" ")
    .filter((t) => t.length >= 2);
  return toks.length === 0 ? null : new Set(toks);
}

function strictSubset(a: Set<string>, b: Set<string>): boolean {
  if (a.size >= b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

/** A pair is closed to questions when a no_match (I9) or merged_into edge
 * exists between the two in either direction, or the question is already
 * pending. */
function pairClosed(ctx: Ctx, a: string, b: string): boolean {
  const pending = ctx.mem.get<{ a: string }>("SELECT a FROM identity_pending WHERE a = ? AND b = ?", [a, b]);
  if (pending !== null) return true;
  const edge = ctx.mem.get<{ id: string }>(
    `SELECT id FROM edges WHERE type IN ('no_match', 'merged_into')
       AND ((source = ? AND target = ?) OR (source = ? AND target = ?)) LIMIT 1`,
    [a, b, b, a],
  );
  return edge !== null;
}

/**
 * Deterministic candidate generation — owner- or host-scheduled, never
 * ambient (owner-confirmed). Scans active, non-never nodes of one type with
 * rules R1 (title_match) > R2 (token_subset) > R3 (alias_match) — highest
 * evidence wins per pair — and writes NEW questions to identity_pending.
 * Skips pairs already pending, no_match pairs (I9), and merged_into pairs.
 * Returns the number of questions added (≤ cap). Audited content-free.
 */
export function suggestIdentities(ctx: Ctx, type: string, cap = 20): number {
  const rows = ctx.mem.query<{ id: string; title: string }>(
    "SELECT id, title FROM nodes WHERE type = ? AND status = 'active' AND surfacing != 'never' ORDER BY id",
    [type],
  );
  const aliasRows = ctx.mem.query<{ alias: string; node_id: string }>(
    "SELECT a.alias, a.node_id FROM aliases a JOIN nodes n ON n.id = a.node_id WHERE n.type = ?",
    [type],
  );
  const aliasesBy = new Map<string, Set<string>>();
  for (const r of aliasRows) {
    const set = aliasesBy.get(r.node_id) ?? new Set<string>();
    set.add(r.alias);
    aliasesBy.set(r.node_id, set);
  }

  const norm = rows.map((r) => ({
    id: r.id,
    title: normalizeText(r.title),
    tokens: tokenSet(r.title),
    aliases: aliasesBy.get(r.id) ?? new Set<string>(),
  }));

  let added = 0;
  const at = ctx.now().toISOString();
  for (let i = 0; i < norm.length && added < cap; i++) {
    for (let j = i + 1; j < norm.length && added < cap; j++) {
      const x = norm[i];
      const y = norm[j];
      if (x === undefined || y === undefined) continue;
      let evidence: IdentityEvidence | null = null;
      if (x.title === y.title) {
        evidence = "title_match"; // R1
      } else if (
        x.tokens !== null &&
        y.tokens !== null &&
        (strictSubset(x.tokens, y.tokens) || strictSubset(y.tokens, x.tokens))
      ) {
        evidence = "token_subset"; // R2
      } else if (
        x.aliases.has(y.title) ||
        y.aliases.has(x.title) ||
        [...x.aliases].some((al) => y.aliases.has(al))
      ) {
        evidence = "alias_match"; // R3
      }
      if (evidence === null) continue;
      if (pairClosed(ctx, x.id, y.id)) continue;
      ctx.mem.run("INSERT INTO identity_pending (a, b, evidence, created) VALUES (?, ?, ?, ?)", [
        x.id, // rows are id-ordered, so a < b holds
        y.id,
        evidence,
        at,
      ]);
      added++;
    }
  }
  if (added > 0) audit(ctx, "system", "identity.suggest", "", true, { type, added });
  return added;
}

/** Open identity questions for the queue: both sides still active and
 * non-never (I2 holds even when surfacing changed after the suggestion),
 * oldest first. */
export function identityPending(
  ctx: Ctx,
): { a: Node; b: Node; evidence: IdentityEvidence; created: string }[] {
  const rows = ctx.mem.query<{ a: string; b: string; evidence: string; created: string }>(
    "SELECT a, b, evidence, created FROM identity_pending ORDER BY created ASC, a ASC",
  );
  const out: { a: Node; b: Node; evidence: IdentityEvidence; created: string }[] = [];
  for (const r of rows) {
    const a = mustGet(ctx, r.a as NodeId);
    const b = mustGet(ctx, r.b as NodeId);
    if (a.status !== "active" || b.status !== "active") continue;
    if (a.surfacing === "never" || b.surfacing === "never") continue;
    out.push({ a, b, evidence: r.evidence as IdentityEvidence, created: r.created });
  }
  return out;
}

// --- Phase C: verdicts (docs/ENTITIES.md) ---

/** A no_match or merged_into edge in either direction closes the pair. */
function closureEdge(ctx: Ctx, a: string, b: string, type: string): boolean {
  const edge = ctx.mem.get<{ id: string }>(
    `SELECT id FROM edges WHERE type = ?
       AND ((source = ? AND target = ?) OR (source = ? AND target = ?)) LIMIT 1`,
    [type, a, b, b, a],
  );
  return edge !== null;
}

function dropQuestion(ctx: Ctx, a: string, b: string): void {
  ctx.mem.run("DELETE FROM identity_pending WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)", [a, b, b, a]);
}

/**
 * The owner's identity verdict (ENTITIES.md, Phase C). "same" runs the
 * compound merge — survivor chosen BY THE OWNER via argument order, never a
 * heuristic: rewire edges (keep's win on conflict; self-loops drop), fold
 * other's title + aliases into keep (source='merge'), chain other →
 * merged_into → keep and retire it as a content-preserving husk out of
 * every surface. "different" writes the permanent no_match edge (I9).
 * Like approve_superseding (I5), the sequence is ordered and audited step
 * by step — a mid-sequence failure stops and surfaces, never silently
 * rolls back audited owner actions.
 */
export function decideIdentity(ctx: Ctx, keep: NodeId, other: NodeId, verdict: "same" | "different"): Node {
  if (keep === other) throw new MemoryError("conflict", "a node cannot be merged with itself");
  const keeper = mustGet(ctx, keep);
  const dup = mustGet(ctx, other);
  if (keeper.status !== "active" || dup.status !== "active")
    throw new MemoryError("invalid_transition", "identity verdicts apply to two ACTIVE nodes");
  if (keeper.type !== dup.type) throw new MemoryError("conflict", "identity stays within one node type");
  if (keeper.surfacing === "never" || dup.surfacing === "never")
    throw new MemoryError("conflict", "never-surfaced nodes do not take identity verdicts (I2)");
  if (closureEdge(ctx, keep, other, "no_match"))
    throw new MemoryError("conflict", "the owner already ruled these distinct (no_match, I9)");

  if (verdict === "different") {
    insertEdge(ctx, keep, other, "no_match", "owner ruled distinct", "owner");
    dropQuestion(ctx, keep, other);
    audit(ctx, "owner", "identity.decide", keep, true, { verdict: "different", other });
    return mustGet(ctx, keep);
  }

  // --- the compound merge, in order (each step audited) ---

  // 1. Edges that must not survive the rewire drop outright: the pair's
  //    own edges (would become self-loops), the dup's self-loops (would
  //    become manufactured keep→keep loops), and every no_match edge
  //    incident to the dup — a non-relation of the dup is NOT a
  //    non-relation of the survivor; transplanting one would permanently
  //    poison a pair the owner never ruled on (I9, review-2 F1). Identity
  //    assertions retire with the node that carried them.
  const dropped = ctx.mem.run(
    `DELETE FROM edges WHERE (source = ? AND target = ?) OR (source = ? AND target = ?)
       OR (source = ? AND target = ?)
       OR (type = 'no_match' AND (source = ? OR target = ?))`,
    [keep, other, other, keep, other, other, other, other],
  ).changes;

  // 2. Rewire: keep's existing edges win (UPDATE OR IGNORE skips unique
  //    collisions); leftovers still pointing at the dup are collisions — drop.
  const rewiredSrc = ctx.mem.run("UPDATE OR IGNORE edges SET source = ? WHERE source = ?", [
    keep,
    other,
  ]).changes;
  const rewiredTgt = ctx.mem.run("UPDATE OR IGNORE edges SET target = ? WHERE target = ?", [
    keep,
    other,
  ]).changes;
  const collisions = ctx.mem.run("DELETE FROM edges WHERE source = ? OR target = ?", [other, other]).changes;
  audit(ctx, "owner", "identity.merge_rewire", keep, true, {
    rewired: rewiredSrc + rewiredTgt,
    dropped: dropped + collisions,
  });

  // 3. Fold names: dup's title + aliases become keep's aliases (source
  //    'merge'), except any name equal to keep's own title. Dup's alias
  //    rows go with it — the survivor holds the names now.
  const keeperTitle = normalizeText(keeper.title);
  const at = ctx.now().toISOString();
  let folded = 0;
  const names = [normalizeText(dup.title), ...aliasesOf(ctx, other)];
  for (const name of names) {
    if (name === "" || name === keeperTitle) continue;
    const res = ctx.mem.run(
      `INSERT INTO aliases (alias, node_id, source, created) VALUES (?, ?, 'merge', ?)
       ON CONFLICT(alias, node_id) DO NOTHING`,
      [name, keep, at],
    );
    folded += res.changes;
  }
  ctx.mem.run("DELETE FROM aliases WHERE node_id = ?", [other]);

  // 4. Retire the dup: content-preserving husk, chained to its survivor,
  //    out of every queue and surface.
  ctx.mem.run("UPDATE nodes SET status = 'merged', review_at = NULL, updated = ? WHERE id = ?", [at, other]);
  audit(ctx, "owner", "node.transition", other, true, { from: "active", to: "merged" });
  insertEdge(ctx, other, keep, "merged_into", "identity verdict", "owner");
  ctx.mem.run("DELETE FROM pending_edits WHERE node_id = ?", [other]);
  ctx.mem.run("DELETE FROM identity_pending WHERE a = ? OR b = ?", [other, other]);
  dropQuestion(ctx, keep, other);

  // 5. Index: the husk leaves FTS and vectors; the survivor reindexes with
  //    its folded names.
  reindexNode(ctx, mustGet(ctx, other));
  try {
    ctx.idx.run("DELETE FROM vectors WHERE id = ?", [other]);
  } catch {
    audit(ctx, "system", "index.scrub", other, false);
  }
  reindexNode(ctx, mustGet(ctx, keep));

  audit(ctx, "owner", "identity.merge", keep, true, {
    over: other,
    rewired: rewiredSrc + rewiredTgt,
    dropped: dropped + collisions,
    folded,
  });
  return mustGet(ctx, keep);
}

// --- Phase D: the peer card (docs/ENTITIES.md) ---

/** One neighbor on a peer card: the node plus the raw edges connecting it
 * to the subject — source/target preserved, so direction and the edge
 * `context` string survive into the host's prompt block. */
export interface Peer {
  readonly node: Node;
  readonly edges: readonly Edge[];
}

/** The bounded disambiguation block for one referent ("this Ana is the
 * sister, not the coworker"): the node, its names, and its capped 1-hop
 * neighborhood. Hosts compose it into prompts; the library never injects. */
export interface EntityContext {
  readonly node: Node;
  readonly aliases: readonly string[];
  readonly peers: readonly Peer[];
}

/** The same recency anchor the recall blend decays on. */
function recencyAnchor(n: Node): string {
  return n.lastUsed ?? n.updated;
}

/**
 * The bounded peer card (ENTITIES.md, Phase D). Subject: ACTIVE only — a
 * merged husk is refused with a pointer at survivorOf(); `never` is refused
 * (I2 — never means never), `ask` is allowed (an id is the strongest form
 * of literal naming). Peers: the 1-hop ACTIVE set (I3), `always`-surfaced
 * only — the card names its subject, not its peers, so `ask` stays out
 * (I2); `day` anchors are plumbing (same exclusion as ambient recall);
 * `no_match` edges never appear, and a neighbor connected ONLY by no_match
 * is not a peer — that edge asserts a NON-relation. Ranked by recency
 * (last_used ?? updated) descending, id ascending on ties; hard-capped at
 * `limit`. A pure read: nothing is audited, touched, or written.
 */
export function entityContext(ctx: Ctx, id: NodeId, limit = 6): EntityContext {
  if (!Number.isInteger(limit) || limit < 0)
    throw new MemoryError("props_invalid", "limit must be a non-negative integer");
  const node = mustGet(ctx, id);
  if (node.status === "merged")
    throw new MemoryError(
      "invalid_transition",
      `node ${id} is a merged husk — survivorOf() walks to its living end`,
    );
  if (node.status !== "active")
    throw new MemoryError("invalid_transition", `peer cards describe ACTIVE nodes (status=${node.status})`);
  if (node.surfacing === "never")
    throw new MemoryError("conflict", "never-surfaced nodes do not take peer cards (I2)");

  const rows = ctx.mem.query<{
    id: string;
    source: string;
    target: string;
    type: string;
    context: string;
    created: string;
  }>(
    `SELECT id, source, target, type, context, created FROM edges
     WHERE (source = ? OR target = ?) AND type != 'no_match'
     ORDER BY created ASC, id ASC`,
    [id, id],
  );
  const bySide = new Map<string, Edge[]>();
  for (const r of rows) {
    const peerId = r.source === id ? r.target : r.source;
    if (peerId === id) continue; // a self-loop carries no peer
    const edge: Edge = {
      id: r.id as EdgeId, // brand boundary
      source: r.source as NodeId,
      target: r.target as NodeId,
      type: r.type,
      context: r.context,
      created: r.created,
    };
    const list = bySide.get(peerId);
    if (list === undefined) bySide.set(peerId, [edge]);
    else list.push(edge);
  }

  const peers: { node: Node; edges: Edge[] }[] = [];
  for (const [peerId, edges] of bySide) {
    const peer = mustGet(ctx, peerId as NodeId);
    if (peer.status !== "active") continue; // the 1-hop ACTIVE set (I3)
    if (peer.surfacing !== "always") continue; // the card names its subject, not its peers (I2)
    if (peer.type === "day") continue; // anchor plumbing, same rule as ambient recall
    peers.push({ node: peer, edges });
  }
  peers.sort((a, b) => {
    const ra = recencyAnchor(a.node);
    const rb = recencyAnchor(b.node);
    if (ra !== rb) return ra < rb ? 1 : -1; // recency DESC (ISO-8601 compares lexically)
    return a.node.id < b.node.id ? -1 : 1; // deterministic tie-break
  });
  return { node, aliases: aliasesOf(ctx, id), peers: peers.slice(0, limit) };
}
