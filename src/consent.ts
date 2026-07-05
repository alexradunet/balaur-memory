/**
 * The consent boundary as data: proposals enter through the write-time AUDN
 * gate, the owner decides, every step is audited (SCHEMA.md I1, I4, I5).
 * Hosts render the queue however they like (cards, CLI, TUI) — the ledger
 * lives here.
 *
 * Gate routing (I4), resolved BEFORE anything is written:
 *   normalized-title equality vs a PENDING proposal → merge into it
 *   normalized-title equality vs an ACTIVE node     → no-op, point at it
 *   otherwise                                       → create (born proposed)
 * A REJECTED title does not block a fresh proposal — the owner's no is
 * final for that card, not a permanent word-ban; the gate's job is
 * deduplication, not censorship. (Documented behavior, pinned by test.)
 */

import { lexicalCandidates, termsFromText } from "./recall.ts";
import {
  audit,
  type Ctx,
  insertEdge,
  insertNode,
  mustGet,
  reindexNode,
  transition,
  typeRow,
} from "./spine.ts";
import { MemoryError, type Node, type NodeId, type Props } from "./types.ts";

// --- types (the host-facing contract) ---

/** An agent-authored write awaiting the owner. */
export interface Proposal {
  readonly type: string; // must be registered with bornStatus="proposed"
  readonly title: string;
  readonly body: string;
  readonly importance?: number; // 1..5; omit when not applicable
  readonly props?: Props;
  readonly origin: string; // provenance is mandatory at birth (I10)
  readonly author?: string; // set when the content carries a third party's words
}

/** How the write-time gate routed a proposal (I4). */
export type Outcome =
  | { readonly kind: "created"; readonly node: Node }
  | { readonly kind: "merged_pending"; readonly node: Node }
  | { readonly kind: "exists_active"; readonly node: Node };

/** Advisory hint on a pending item: an active node it may duplicate or
 * contradict. The owner adjudicates; the library never auto-resolves. */
export interface Conflict {
  readonly nodeId: NodeId;
  readonly title: string;
  readonly reason: "title_match" | "lexical_overlap";
}

/** A parked, agent-proposed change to an ACTIVE node. The approved content
 * is untouched until the owner applies it. */
export interface EditEnvelope {
  readonly fields: Readonly<Record<string, string>>;
  readonly archive: boolean;
  readonly origin: string;
  readonly author: string;
  readonly created: string;
}

/** One reviewable item in the consent queue. */
export interface Pending {
  readonly node: Node;
  /** non-null: a parked edit to an active node rather than a new proposal. */
  readonly edit: EditEnvelope | null;
  readonly conflicts: readonly Conflict[];
}

/**
 * The owner's verdict. approve_superseding is compound and ordered (I5):
 * activate new → archive old → supersedes edge → audit.
 */
export type Decision =
  | { readonly kind: "approve" }
  | { readonly kind: "approve_edited"; readonly fields: Readonly<Record<string, string>> }
  | { readonly kind: "approve_superseding"; readonly supersedes: NodeId }
  | { readonly kind: "reject" };

// --- helpers ---

function normalizeTitle(s: string): string {
  return s.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function requireGatedType(ctx: Ctx, type: string): void {
  const t = typeRow(ctx, type);
  if (t.born_status !== "proposed")
    throw new MemoryError(
      "invalid_transition",
      `type ${JSON.stringify(type)} is owner-authored — it does not go through the consent queue`,
    );
}

function findByNormalizedTitle(ctx: Ctx, type: string, title: string, status: string): Node | null {
  const rows = ctx.mem.query<{ id: string }>("SELECT id FROM nodes WHERE type = ? AND status = ?", [
    type,
    status,
  ]);
  const wanted = normalizeTitle(title);
  for (const r of rows) {
    const node = mustGet(ctx, r.id as NodeId);
    if (normalizeTitle(node.title) === wanted) return node;
  }
  return null;
}

// --- the gate (I4) ---

export function propose(ctx: Ctx, p: Proposal): Outcome {
  requireGatedType(ctx, p.type);
  const title = p.title.trim();
  if (title === "") throw new MemoryError("props_invalid", "title is required");

  // 1. Merge into an existing pending proposal — latest proposal wins.
  const pending = findByNormalizedTitle(ctx, p.type, title, "proposed");
  if (pending !== null) {
    const props = { ...pending.props, ...(p.props ?? {}) };
    ctx.mem.run(
      "UPDATE nodes SET body = ?, importance = ?, props = ?, origin = ?, author = ?, updated = ? WHERE id = ?",
      [
        p.body,
        p.importance ?? pending.importance,
        JSON.stringify(props),
        p.origin,
        p.author ?? "",
        ctx.now().toISOString(),
        pending.id,
      ],
    );
    const node = mustGet(ctx, pending.id);
    audit(ctx, "agent", "consent.propose", node.id, true, { outcome: "merged_pending", type: p.type });
    return { kind: "merged_pending", node };
  }

  // 2. An active node already covers it — write nothing at all.
  const active = findByNormalizedTitle(ctx, p.type, title, "active");
  if (active !== null) {
    audit(ctx, "agent", "consent.propose", active.id, true, { outcome: "exists_active", type: p.type });
    return { kind: "exists_active", node: active };
  }

  // 3. Create, born proposed (I1 — the agent half).
  const node = insertNode(
    ctx,
    {
      type: p.type,
      title,
      body: p.body,
      origin: p.origin,
      ...(p.importance !== undefined ? { importance: p.importance } : {}),
      ...(p.props !== undefined ? { props: p.props } : {}),
      ...(p.author !== undefined ? { author: p.author } : {}),
    },
    "proposed",
    "agent",
  );
  audit(ctx, "agent", "consent.propose", node.id, true, { outcome: "created", type: p.type });
  return { kind: "created", node };
}

// --- parked edits ---

export interface EditChange {
  readonly fields?: Record<string, string>;
  readonly archive?: boolean;
  readonly origin: string;
  readonly author?: string;
}

/** Park a change to an ACTIVE consent-gated node. Latest proposal wins
 * (PK on node_id); the approved content is untouched until decide(). */
export function proposeEdit(ctx: Ctx, id: NodeId, change: EditChange): void {
  const node = mustGet(ctx, id);
  requireGatedType(ctx, node.type);
  if (node.status !== "active")
    throw new MemoryError("invalid_transition", `node ${id} is not active (status=${node.status})`);
  const fields = change.fields ?? {};
  const archive = change.archive === true;
  if (Object.keys(fields).length === 0 && !archive)
    throw new MemoryError("props_invalid", "nothing to propose — pass fields and/or archive");
  ctx.mem.run(
    `INSERT INTO pending_edits (node_id, fields, archive, origin, author, created)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET fields = excluded.fields, archive = excluded.archive,
       origin = excluded.origin, author = excluded.author, created = excluded.created`,
    [
      id,
      JSON.stringify(fields),
      archive ? 1 : 0,
      change.origin,
      change.author ?? "",
      ctx.now().toISOString(),
    ],
  );
  audit(ctx, "agent", "consent.propose_edit", id, true, { archive });
}

interface EditRow {
  node_id: string;
  fields: string;
  archive: number;
  origin: string;
  author: string;
  created: string;
}

function editEnvelopeFor(ctx: Ctx, id: NodeId): EditEnvelope | null {
  const r = ctx.mem.get<EditRow & Record<string, string | number>>(
    "SELECT node_id, fields, archive, origin, author, created FROM pending_edits WHERE node_id = ?",
    [id],
  );
  if (r === null) return null;
  return {
    fields: JSON.parse(r.fields) as Record<string, string>,
    archive: r.archive === 1,
    origin: r.origin,
    author: r.author,
    created: r.created,
  };
}

// --- the queue + conflict hints ---

/** Everything awaiting the owner: proposals oldest-first, then parked edits
 * oldest-first — each with its conflict hints. */
export function pendingQueue(ctx: Ctx): Pending[] {
  const out: Pending[] = [];
  const proposed = ctx.mem.query<{ id: string }>(
    "SELECT id FROM nodes WHERE status = 'proposed' ORDER BY created ASC",
  );
  for (const r of proposed) {
    const node = mustGet(ctx, r.id as NodeId);
    out.push({ node, edit: null, conflicts: conflictsFor(ctx, node.id) });
  }
  const edits = ctx.mem.query<{ node_id: string }>(
    `SELECT pe.node_id FROM pending_edits pe JOIN nodes n ON n.id = pe.node_id
     WHERE n.status = 'active' ORDER BY pe.created ASC`,
  );
  for (const r of edits) {
    const node = mustGet(ctx, r.node_id as NodeId);
    out.push({ node, edit: editEnvelopeFor(ctx, node.id), conflicts: conflictsFor(ctx, node.id) });
  }
  return out;
}

const CONFLICT_CAP = 2;

/** Advisory duplicates/contradictions among ACTIVE nodes of the same type:
 * exact normalized-title matches first, then bm25 lexical overlap on the
 * item's own words. Best-effort by design — hints never block a render. */
export function conflictsFor(ctx: Ctx, id: NodeId): Conflict[] {
  const node = mustGet(ctx, id);
  const out: Conflict[] = [];
  const seen = new Set<string>([id]);

  const exact = findByNormalizedTitle(ctx, node.type, node.title, "active");
  if (exact !== null && !seen.has(exact.id)) {
    seen.add(exact.id);
    out.push({ nodeId: exact.id, title: exact.title, reason: "title_match" });
  }

  const terms = termsFromText(`${node.title} ${node.body}`);
  for (const c of lexicalCandidates(ctx, terms, node.type, CONFLICT_CAP + 4)) {
    if (out.length >= CONFLICT_CAP) break;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const hit = mustGet(ctx, c.id as NodeId);
    if (hit.status !== "active") continue; // fts holds active only, but stay defensive
    out.push({ nodeId: hit.id, title: hit.title, reason: "lexical_overlap" });
  }
  return out;
}

// --- decisions (I5) ---

/** Whitelisted verdict-field application: title/body/importance are columns,
 * anything else lands in props as a string. */
function applyFields(ctx: Ctx, id: NodeId, fields: Readonly<Record<string, string>>): Node {
  const node = mustGet(ctx, id);
  let title = node.title;
  let body = node.body;
  let importance = node.importance;
  const props: Record<string, unknown> = { ...node.props };
  for (const [key, value] of Object.entries(fields)) {
    if (key === "title") {
      if (value.trim() === "") throw new MemoryError("props_invalid", "title cannot be cleared");
      title = value.trim();
    } else if (key === "body") {
      body = value;
    } else if (key === "importance") {
      const n = Number.parseInt(value, 10);
      if (Number.isNaN(n) || n < 0 || n > 5)
        throw new MemoryError("props_invalid", "importance must be an integer between 0 and 5");
      importance = n;
    } else {
      props[key] = value;
    }
  }
  ctx.mem.run("UPDATE nodes SET title = ?, body = ?, importance = ?, props = ?, updated = ? WHERE id = ?", [
    title,
    body,
    importance,
    JSON.stringify(props),
    ctx.now().toISOString(),
    id,
  ]);
  const updated = mustGet(ctx, id);
  reindexNode(ctx, updated);
  return updated;
}

function clearEdit(ctx: Ctx, id: NodeId): void {
  ctx.mem.run("DELETE FROM pending_edits WHERE node_id = ?", [id]);
}

/**
 * Apply the owner's verdict to a pending item — a proposal (status=proposed)
 * or a parked edit on an active node. Compound verdicts run their whole
 * ordered sequence, each step audited by the verb that performs it; a
 * mid-sequence failure stops and surfaces — no silent rollback of audited
 * owner actions (I5).
 */
export function decide(ctx: Ctx, id: NodeId, d: Decision): Node {
  const node = mustGet(ctx, id);

  if (node.status === "proposed") {
    let result: Node;
    switch (d.kind) {
      case "approve":
        result = transition(ctx, id, "active");
        break;
      case "approve_edited":
        applyFields(ctx, id, d.fields);
        result = transition(ctx, id, "active");
        break;
      case "approve_superseding": {
        const old = mustGet(ctx, d.supersedes);
        if (old.status !== "active")
          throw new MemoryError("invalid_transition", `supersedes target ${d.supersedes} is not active`);
        if (old.type !== node.type)
          throw new MemoryError("conflict", "supersede must stay within one node type");
        result = transition(ctx, id, "active"); // 1. activate the new
        transition(ctx, d.supersedes, "archived"); // 2. archive the old
        insertEdge(ctx, id, d.supersedes, "supersedes", "approved as replacement", "owner"); // 3. chain
        break;
      }
      case "reject":
        result = transition(ctx, id, "rejected");
        break;
    }
    audit(ctx, "owner", "consent.decide", id, true, {
      kind: d.kind,
      ...(d.kind === "approve_superseding" ? { over: d.supersedes } : {}),
    });
    return result;
  }

  // A parked edit on an active node.
  const envelope = editEnvelopeFor(ctx, id);
  if (node.status !== "active" || envelope === null)
    throw new MemoryError("not_found", `nothing pending on node ${id}`);
  let result: Node = node;
  switch (d.kind) {
    case "approve":
      result = envelope.archive ? transition(ctx, id, "archived") : applyFields(ctx, id, envelope.fields);
      break;
    case "approve_edited":
      result = applyFields(ctx, id, d.fields); // owner-corrected fields replace the envelope's
      break;
    case "approve_superseding":
      throw new MemoryError("invalid_transition", "supersede applies to proposals, not parked edits");
    case "reject":
      break; // node untouched; the envelope just clears
  }
  clearEdit(ctx, id);
  audit(ctx, "owner", "consent.decide", id, true, { kind: d.kind, edit: true });
  return result;
}
