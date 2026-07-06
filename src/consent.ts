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

import { type IdentityEvidence, identityPending } from "./entities.ts";
import { lexicalCandidates, termsFromText, titleNamed } from "./recall.ts";
import {
  applyTemplateAndValidate,
  audit,
  type Ctx,
  insertEdge,
  insertNode,
  mustGet,
  reindexNode,
  snapshotHistory,
  transition,
  typeRow,
} from "./spine.ts";
import { MemoryError, type Node, type NodeId, normalizeText, type Props } from "./types.ts";

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

/**
 * One reviewable item in the consent queue — the single place a host
 * renders "everything awaiting the owner" (v0.2.0: a tagged union; the
 * identity kind is pair-keyed and decided via decideIdentity, Phase C).
 */
export type Pending =
  | { readonly kind: "proposal"; readonly node: Node; readonly conflicts: readonly Conflict[] }
  | {
      readonly kind: "edit";
      readonly node: Node;
      readonly edit: EditEnvelope;
      readonly conflicts: readonly Conflict[];
    }
  | {
      readonly kind: "identity";
      readonly a: Node;
      readonly b: Node;
      readonly evidence: IdentityEvidence;
      readonly created: string;
    };

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

function requireGatedType(ctx: Ctx, type: string): void {
  const t = typeRow(ctx, type);
  if (t.born_status !== "proposed")
    throw new MemoryError(
      "invalid_transition",
      `type ${JSON.stringify(type)} is owner-authored — it does not go through the consent queue`,
    );
}

/**
 * visibility: "any" sees every row (owner-side mechanics); "named" applies
 * the I2 rule to what this lookup may REVEAL — surfacing='never' rows are
 * invisible to it, while 'ask'/'always' are fair game because a normalized-
 * title match means the caller literally named the title (review #1/#2).
 */
function findByNormalizedTitle(
  ctx: Ctx,
  type: string,
  title: string,
  status: string,
  visibility: "any" | "named" = "any",
): Node | null {
  const rows = ctx.mem.query<{ id: string }>("SELECT id FROM nodes WHERE type = ? AND status = ?", [
    type,
    status,
  ]);
  const wanted = normalizeText(title);
  for (const r of rows) {
    const node = mustGet(ctx, r.id as NodeId);
    if (normalizeText(node.title) !== wanted) continue;
    if (visibility === "named" && node.surfacing === "never") continue;
    return node;
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

  // 2. An active node already covers it — write nothing at all. A
  // surfacing='never' cover is NOT revealed (I2 on the propose surface):
  // the duplicate proposal is created instead, and the owner-side queue and
  // doctor.duplicateCandidates carry the resolution (review #2).
  const active = findByNormalizedTitle(ctx, p.type, title, "active", "named");
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

/** Everything awaiting the owner: proposals, then parked edits, then
 * identity questions — each kind oldest-first (ENTITIES.md ordering). */
export function pendingQueue(ctx: Ctx): Pending[] {
  const out: Pending[] = [];
  const proposed = ctx.mem.query<{ id: string }>(
    "SELECT id FROM nodes WHERE status = 'proposed' ORDER BY created ASC, id ASC",
  );
  for (const r of proposed) {
    const node = mustGet(ctx, r.id as NodeId);
    out.push({ kind: "proposal", node, conflicts: conflictsFor(ctx, node.id) });
  }
  const edits = ctx.mem.query<{ node_id: string }>(
    `SELECT pe.node_id FROM pending_edits pe JOIN nodes n ON n.id = pe.node_id
     WHERE n.status = 'active' ORDER BY pe.created ASC, pe.node_id ASC`,
  );
  for (const r of edits) {
    const node = mustGet(ctx, r.node_id as NodeId);
    const edit = editEnvelopeFor(ctx, node.id);
    if (edit === null) continue; // raced away; defensive
    out.push({ kind: "edit", node, edit, conflicts: conflictsFor(ctx, node.id) });
  }
  for (const q of identityPending(ctx)) {
    out.push({ kind: "identity", a: q.a, b: q.b, evidence: q.evidence, created: q.created });
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

  // Hints obey I2 (review #1): never-surfaced nodes are invisible here — a
  // hint IS unprompted surfacing; ask nodes appear only when the pending
  // item's own words name their title (titleNamed, the recall rule).
  const exact = findByNormalizedTitle(ctx, node.type, node.title, "active", "named");
  if (exact !== null && !seen.has(exact.id)) {
    seen.add(exact.id);
    out.push({ nodeId: exact.id, title: exact.title, reason: "title_match" });
  }

  const terms = termsFromText(`${node.title} ${node.body}`);
  const lowered = terms.map((t) => t.toLowerCase());
  for (const c of lexicalCandidates(ctx, terms, node.type, CONFLICT_CAP + 4)) {
    if (out.length >= CONFLICT_CAP) break;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const hit = mustGet(ctx, c.id as NodeId);
    if (hit.status !== "active") continue; // fts holds active only, but stay defensive
    if (hit.surfacing === "never") continue; // I2
    if (hit.surfacing === "ask" && !titleNamed(hit.title, lowered)) continue; // I2
    out.push({ nodeId: hit.id, title: hit.title, reason: "lexical_overlap" });
  }
  return out;
}

// --- decisions (I5) ---

/** Whitelisted verdict-field application: title/body/importance are columns,
 * anything else lands in props. Verdict fields arrive as strings, so props
 * DECLARED in the type's schema are coerced to their declared primitive
 * (number/boolean) — undeclared keys stay strings — and the assembled props
 * then pass the same schema validation every other write path runs
 * (review-2 F3: the consent boundary must not be the one write that can
 * mint a schema-violating node). */
function applyFields(
  ctx: Ctx,
  id: NodeId,
  fields: Readonly<Record<string, string>>,
  historyAction: string,
  historyOrigin: string,
): Node {
  const node = mustGet(ctx, id);
  const t = typeRow(ctx, node.type);
  const schema = JSON.parse(t.props_schema) as Record<
    string,
    { type: "string" | "number" | "boolean"; required?: boolean }
  >;
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
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 5)
        throw new MemoryError("props_invalid", "importance must be an integer between 0 and 5");
      importance = n;
    } else {
      const def = schema[key];
      if (def === undefined || def.type === "string") {
        props[key] = value;
      } else if (def.type === "number") {
        const n = Number(value);
        if (value.trim() === "" || !Number.isFinite(n))
          throw new MemoryError("props_invalid", `prop ${JSON.stringify(key)} must be a number`);
        props[key] = n;
      } else {
        if (value !== "true" && value !== "false")
          throw new MemoryError("props_invalid", `prop ${JSON.stringify(key)} must be a boolean`);
        props[key] = value === "true";
      }
    }
  }
  // Same validator as birth and updateNode; template body-fill stays a
  // birth-only semantic — the edited body is used as-is.
  const checked = applyTemplateAndValidate(t, body, props);
  // Capture moments 2 and 3 of 3 (I16): the pre-change content, attributed
  // to the verdict that changed it — after validation, so a refused edit
  // snapshots nothing (nothing changed).
  snapshotHistory(ctx, node, historyAction, historyOrigin);
  ctx.mem.run("UPDATE nodes SET title = ?, body = ?, importance = ?, props = ?, updated = ? WHERE id = ?", [
    title,
    body,
    importance,
    JSON.stringify(checked.props),
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
        applyFields(ctx, id, d.fields, "consent.approve_edited", "");
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
  if (node.status !== "active" || envelope === null) {
    // The node may still be awaiting a PAIR-keyed verdict — say so instead
    // of the misleading "nothing pending" (review-2 F9).
    const question = ctx.mem.get<{ a: string }>(
      "SELECT a FROM identity_pending WHERE a = ? OR b = ? LIMIT 1",
      [id, id],
    );
    if (question !== null)
      throw new MemoryError(
        "conflict",
        `node ${id} is awaiting an identity verdict — use decideIdentity(keep, other, verdict)`,
      );
    throw new MemoryError("not_found", `nothing pending on node ${id}`);
  }
  let result: Node = node;
  switch (d.kind) {
    case "approve":
      result = envelope.archive
        ? transition(ctx, id, "archived")
        : applyFields(ctx, id, envelope.fields, "consent.edit_applied", envelope.origin);
      break;
    case "approve_edited":
      // owner-corrected fields replace the envelope's
      result = applyFields(ctx, id, d.fields, "consent.approve_edited", "");
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
