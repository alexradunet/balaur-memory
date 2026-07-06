/**
 * The spine: nodes + edges CRUD, the status FSM, the type registry, and the
 * write fan-out (FTS upsert, on_day anchor, audit). Every mutation of
 * nodes/edges flows through this module's choke points (CODING.md) — that is
 * what makes I10 (provenance at birth) and I12 (audit coverage) hold by
 * construction rather than by discipline.
 */

import { aliasTextFor, upsertFts } from "./indexdb/fts.ts";
import type { SqlDb, SqlRow } from "./storage/adapter.ts";
import { ulid } from "./storage/ulid.ts";
import {
  type Edge,
  type EdgeId,
  MemoryError,
  type Node,
  type NodeId,
  type NodeTypeSpec,
  normalizeText,
  type Props,
  parseProps,
  parseStrictIso,
  type Status,
  type Surfacing,
  SYSTEM_EDGE_TYPES,
} from "./types.ts";

/** Shared handle the Store façade threads through every spine call. */
export interface Ctx {
  readonly mem: SqlDb;
  readonly idx: SqlDb;
  readonly now: () => Date;
}

/** The owner-driven FSM (SCHEMA.md "Status semantics"). forgotten and merged
 * are reachable only through their dedicated verbs (forget(), decide()) —
 * never through a bare transition. */
const TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  proposed: ["active", "rejected"],
  active: ["archived", "quarantined"],
  archived: ["active"],
  quarantined: ["active"],
  rejected: [],
  forgotten: [],
  merged: [],
};

// --- audit (content-free by construction: I7/I12) ---

export type Actor = "owner" | "agent" | "system";

export function audit(
  ctx: Ctx,
  actor: Actor,
  action: string,
  ref: string,
  ok: boolean,
  meta: Readonly<Record<string, string | number | boolean>> = {},
): void {
  ctx.mem.run("INSERT INTO audit_log (id, at, actor, action, ref, ok, meta) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    ulid(ctx.now().getTime()),
    ctx.now().toISOString(),
    actor,
    action,
    ref,
    ok ? 1 : 0,
    JSON.stringify(meta),
  ]);
}

// --- row mapping (the one sanctioned brand/JSON boundary) ---

interface NodeRow extends SqlRow {
  id: string;
  type: string;
  title: string;
  body: string;
  status: string;
  surfacing: string;
  importance: number;
  props: string;
  origin: string;
  author: string;
  use_count: number;
  last_used: string | null;
  review_at: string | null;
  when_at: string | null;
  created: string;
  updated: string;
}

const NODE_COLS =
  "id, type, title, body, status, surfacing, importance, props, origin, author, use_count, last_used, review_at, when_at, created, updated";

function rowToNode(r: NodeRow): Node {
  return {
    id: r.id as NodeId, // brand boundary
    type: r.type,
    title: r.title,
    body: r.body,
    status: r.status as Status,
    surfacing: r.surfacing as Surfacing,
    importance: r.importance,
    props: parseProps(r.props),
    origin: r.origin,
    author: r.author,
    useCount: r.use_count,
    lastUsed: r.last_used,
    reviewAt: r.review_at,
    when: r.when_at,
    created: r.created,
    updated: r.updated,
  };
}

// --- type registry ---

interface TypeRow extends SqlRow {
  name: string;
  born_status: string;
  props_schema: string;
  template: string;
}

export function registerType(ctx: Ctx, spec: NodeTypeSpec): void {
  const name = spec.name.trim();
  if (name === "") throw new MemoryError("props_invalid", "type name is required");
  // Refuse born_status flips once nodes of the type exist — flipping the
  // consent split on a live type would let the gate be bypassed (review #10).
  const existing = ctx.mem.get<{ born_status: string }>("SELECT born_status FROM node_types WHERE name = ?", [
    name,
  ]);
  if (existing !== null && existing.born_status !== spec.bornStatus) {
    const inUse = ctx.mem.get<{ c: number }>("SELECT COUNT(*) AS c FROM nodes WHERE type = ?", [name]);
    if ((inUse?.c ?? 0) > 0)
      throw new MemoryError(
        "conflict",
        `cannot change born_status of type ${JSON.stringify(name)} while ${inUse?.c} node(s) of it exist`,
      );
  }
  ctx.mem.run(
    `INSERT INTO node_types (name, born_status, props_schema, template, created) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET born_status = excluded.born_status,
       props_schema = excluded.props_schema, template = excluded.template`,
    [
      name,
      spec.bornStatus,
      JSON.stringify(spec.propsSchema ?? {}),
      JSON.stringify(spec.template ?? {}),
      ctx.now().toISOString(),
    ],
  );
  audit(ctx, "owner", "type.register", name, true, { bornStatus: spec.bornStatus });
}

export function typeRow(ctx: Ctx, name: string): TypeRow {
  const row = ctx.mem.get<TypeRow>(
    "SELECT name, born_status, props_schema, template FROM node_types WHERE name = ?",
    [name],
  );
  if (row === null)
    throw new MemoryError("type_unknown", `node type ${JSON.stringify(name)} is not registered`);
  return row;
}

/** Apply the type's template (fill empty body / missing prop keys), then
 * validate declared props: required present, primitives type-checked.
 * Undeclared keys pass through — an empty schema allows any props.
 * Exported: the consent decide path runs the same validation (review-2 F3). */
export function applyTemplateAndValidate(
  t: TypeRow,
  body: string,
  props: Props,
): { body: string; props: Record<string, unknown> } {
  const template = JSON.parse(t.template) as { body?: string; props?: Record<string, unknown> };
  const schema = JSON.parse(t.props_schema) as Record<
    string,
    { type: "string" | "number" | "boolean"; required?: boolean }
  >;
  const merged: Record<string, unknown> = { ...(template.props ?? {}), ...props };
  const outBody = body !== "" ? body : (template.body ?? "");
  for (const [key, def] of Object.entries(schema)) {
    const v = merged[key];
    if (v === undefined) {
      if (def.required === true)
        throw new MemoryError("props_invalid", `prop ${JSON.stringify(key)} is required for this type`);
      continue;
    }
    if (typeof v !== def.type)
      throw new MemoryError("props_invalid", `prop ${JSON.stringify(key)} must be a ${def.type}`);
  }
  return { body: outBody, props: merged };
}

// --- create (the birth choke point: I1, I10, I12) ---

export interface CreateInput {
  readonly type: string;
  readonly title: string;
  readonly body?: string;
  readonly props?: Props;
  readonly importance?: number;
  readonly surfacing?: Surfacing;
  /** The scheduled moment (PLANNING.md) — strict ISO, declared never inferred (I17). */
  readonly when?: string;
  readonly origin: string;
  readonly author?: string;
}

/**
 * Insert a node at a given status and run the fan-out. Internal: the public
 * owner path is createNode (born active); the consent module births
 * proposed nodes through this same choke point in Phase 3.
 */
export function insertNode(ctx: Ctx, input: CreateInput, status: Status, actor: Actor): Node {
  const title = input.title.trim();
  if (title === "") throw new MemoryError("props_invalid", "title is required");
  const importance = input.importance ?? 0;
  if (!Number.isInteger(importance) || importance < 0 || importance > 5)
    throw new MemoryError("props_invalid", "importance must be an integer between 0 and 5");
  const t = typeRow(ctx, input.type);
  const { body, props } = applyTemplateAndValidate(t, input.body ?? "", input.props ?? {});
  const whenAt = input.when !== undefined ? parseStrictIso(input.when, "when") : null; // I17
  const at = ctx.now();
  const iso = at.toISOString();
  const id = ulid(at.getTime());

  return ctx.mem.transaction(() => {
    ctx.mem.run(
      `INSERT INTO nodes (id, type, title, body, status, surfacing, importance, props, origin, author, when_at, created, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.type,
        title,
        body,
        status,
        input.surfacing ?? "always",
        importance,
        JSON.stringify(props),
        input.origin,
        input.author ?? "",
        whenAt,
        iso,
        iso,
      ],
    );
    audit(ctx, actor, "node.create", id, true, { type: input.type, status });
    const node = mustGet(ctx, id as NodeId);
    fanOut(ctx, node);
    return node;
  });
}

/** Owner-authored write — born active (I1). The host is the authenticator:
 * route agent turns through propose(), owner actions through here. */
export function createNode(ctx: Ctx, input: CreateInput): Node {
  return insertNode(ctx, input, "active", "owner");
}

/** After-write side effects. Index failures must never fail the record
 * write (index.db is disposable, I13) — they are audited, not thrown. */
function fanOut(ctx: Ctx, node: Node): void {
  try {
    upsertFts(ctx.idx, {
      id: node.id,
      kind: node.type,
      title: node.title,
      content: node.body,
      extra: extraText(ctx, node),
      status: node.status,
    });
  } catch {
    audit(ctx, "system", "index.upsert", node.id, false);
  }
  if (node.type !== "day") linkOnDay(ctx, node); // recursion guard: a day has no creation day
}

// --- day anchors (episodic spine: the on_day system edge) ---

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Resolve or create the type=day node for the given date (UTC). */
export function ensureDayNode(ctx: Ctx, d: Date): Node {
  const key = dayKey(d);
  const row = ctx.mem.get<NodeRow>(
    `SELECT ${NODE_COLS} FROM nodes WHERE type = 'day' AND status = 'active' AND json_extract(props, '$.date') = ? LIMIT 1`,
    [key],
  );
  if (row !== null) return rowToNode(row);
  return insertNode(
    ctx,
    { type: "day", title: key, props: { date: key }, origin: "system:day" },
    "active",
    "system",
  );
}

function linkOnDay(ctx: Ctx, node: Node): void {
  const day = ensureDayNode(ctx, ctx.now());
  insertEdge(ctx, node.id, day.id, "on_day", "", "system");
}

/** The public day-anchor verb (PLANNING.md): get-or-create the day node
 * for a UTC date — the same node the creation anchor uses. Idempotent.
 * Scheduling onto it is the host's explicit act:
 * `link(task.id, day.id, "scheduled_on")` — a host edge type; `on_day`
 * remains the system's creation anchor only. */
export function dayAnchor(ctx: Ctx, date: string): Node {
  const iso = parseStrictIso(date, "date");
  return ensureDayNode(ctx, new Date(Date.parse(iso)));
}

// --- reads ---

export function mustGet(ctx: Ctx, id: NodeId): Node {
  const row = ctx.mem.get<NodeRow>(`SELECT ${NODE_COLS} FROM nodes WHERE id = ?`, [id]);
  if (row === null) throw new MemoryError("not_found", `no node ${id}`);
  return rowToNode(row);
}

/** 1-hop set around a node: ACTIVE only (I3), `never`-surfaced excluded
 * (I2 composes with traversal — never means never, reachable only by
 * getNode; review-2 F2), `day` anchors excluded as plumbing (the
 * ambient-recall rule). `ask` neighbors ARE returned: traversal is an
 * owner-facing read of a named subject, not ambient matching. The world
 * defaults to NOW (TEMPORAL.md): closed edges drop out of the present;
 * `asOf` travels — a neighbor counts when some edge is valid at t. */
export function neighborhood(ctx: Ctx, id: NodeId, asOf?: string): Node[] {
  const t = asOf !== undefined ? parseStrictIso(asOf, "asOf") : ctx.now().toISOString();
  const rows = ctx.mem.query<NodeRow>(
    `SELECT DISTINCT ${NODE_COLS.split(", ")
      .map((c) => `n.${c}`)
      .join(", ")}
     FROM nodes n
     JOIN edges e ON (e.source = ? AND e.target = n.id) OR (e.target = ? AND e.source = n.id)
     WHERE n.status = 'active' AND n.surfacing != 'never' AND n.type != 'day'
       AND (e.valid_from IS NULL OR e.valid_from <= ?)
       AND (e.valid_until IS NULL OR e.valid_until > ?)`,
    [id, id, t, t],
  );
  return rows.map(rowToNode);
}

// --- update (owner edits to active, owner-authored nodes) ---

export function updateNode(
  ctx: Ctx,
  id: NodeId,
  patch: { title?: string; body?: string; props?: Props; when?: string | null },
): Node {
  const node = mustGet(ctx, id);
  const t = typeRow(ctx, node.type);
  if (t.born_status === "proposed")
    throw new MemoryError(
      "invalid_transition",
      `type ${JSON.stringify(node.type)} is consent-gated — changes go through the consent queue`,
    );
  if (node.status !== "active")
    throw new MemoryError("invalid_transition", `node ${id} is not active (status=${node.status})`);
  const title = patch.title !== undefined ? patch.title.trim() : node.title;
  if (title === "") throw new MemoryError("props_invalid", "title cannot be cleared");
  const nextBody = patch.body ?? node.body;
  const nextProps =
    patch.props !== undefined
      ? applyTemplateAndValidate(t, nextBody, patch.props).props
      : (node.props as Record<string, unknown>);
  // when: undefined = unchanged; null = clear; string = validated set (I17).
  const nextWhen =
    patch.when === undefined ? node.when : patch.when === null ? null : parseStrictIso(patch.when, "when");

  return ctx.mem.transaction(() => {
    // A retitle that lands on one of the node's own aliases makes that
    // alias the noise addAlias refuses — reconcile by dropping it, so the
    // "no alias equals the title" rule survives the back door (review-2 F7).
    if (patch.title !== undefined) {
      ctx.mem.run("DELETE FROM aliases WHERE node_id = ? AND alias = ?", [id, normalizeText(title)]);
    }
    snapshotHistory(ctx, node, "node.update", ""); // capture moment 1 of 3 (I16)
    ctx.mem.run("UPDATE nodes SET title = ?, body = ?, props = ?, when_at = ?, updated = ? WHERE id = ?", [
      title,
      nextBody,
      JSON.stringify(nextProps),
      nextWhen,
      ctx.now().toISOString(),
      id,
    ]);
    audit(ctx, "owner", "node.update", id, true, { type: node.type });
    const updated = mustGet(ctx, id);
    reindexNode(ctx, updated);
    return updated;
  });
}

/** when_to_use + aliases — the two blessed extra-column conventions. */
function extraText(ctx: Ctx, node: Node): string {
  const hint = typeof node.props["when_to_use"] === "string" ? (node.props["when_to_use"] as string) : "";
  const als = aliasTextFor(ctx.mem, node.id);
  return [hint, als].filter((x) => x !== "").join(" ");
}

export function reindexNode(ctx: Ctx, node: Node): void {
  try {
    upsertFts(ctx.idx, {
      id: node.id,
      kind: node.type,
      title: node.title,
      content: node.body,
      extra: extraText(ctx, node),
      status: node.status,
    });
  } catch {
    audit(ctx, "system", "index.upsert", node.id, false);
  }
}

// --- edges ---

interface EdgeRow extends SqlRow {
  id: string;
  source: string;
  target: string;
  type: string;
  context: string;
  created: string;
  valid_from: string | null;
  valid_until: string | null;
}

const EDGE_COLS = "id, source, target, type, context, created, valid_from, valid_until";

function rowToEdge(r: EdgeRow): Edge {
  return {
    id: r.id as EdgeId, // brand boundary
    source: r.source as NodeId,
    target: r.target as NodeId,
    type: r.type,
    context: r.context,
    created: r.created,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
  };
}

/** World-time validity window on a host edge (TEMPORAL.md). */
export interface Validity {
  readonly from?: string;
  readonly until?: string;
}

// --- memory history (TEMPORAL.md Phase B; I16) ---

/** One PRE-mutation content snapshot: what the node said before an
 * owner-authority change, and which verb changed it. */
export interface HistorySnapshot {
  readonly seq: number;
  readonly title: string;
  readonly body: string;
  readonly props: Props;
  readonly when: string | null; // the pre-change scheduled moment (PLANNING.md)
  readonly actor: "owner" | "agent" | "system";
  readonly action: string;
  readonly origin: string;
  readonly at: string;
}

/** Append the pre-change snapshot. Rides INSIDE mutations that already
 * audit — no audit row of its own (I12); content-bearing BY DESIGN, the
 * complement to the content-free audit log, scrubbed by the forget
 * cascade (I16). All three capture moments are owner-authority acts. */
export function snapshotHistory(ctx: Ctx, node: Node, action: string, origin: string): void {
  const seq =
    ctx.mem.get<{ s: number }>(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM memory_history WHERE node_id = ?",
      [node.id],
    )?.s ?? 1;
  ctx.mem.run(
    `INSERT INTO memory_history (node_id, seq, title, body, props, when_at, actor, action, origin, at)
     VALUES (?, ?, ?, ?, ?, ?, 'owner', ?, ?, ?)`,
    [
      node.id,
      seq,
      node.title,
      node.body,
      JSON.stringify(node.props),
      node.when,
      action,
      origin,
      ctx.now().toISOString(),
    ],
  );
}

/** What the node used to say, oldest first — replaying the list is
 * replaying the node's life. Id-gated like getNode (I2's strongest
 * naming); a forgotten node's history is EMPTY because forget scrubbed
 * it (I16). Read-only: history is evidence, not an undo stack. */
export function history(ctx: Ctx, id: NodeId): HistorySnapshot[] {
  mustGet(ctx, id);
  return ctx.mem
    .query<{
      seq: number;
      title: string;
      body: string;
      props: string;
      when_at: string | null;
      actor: string;
      action: string;
      origin: string;
      at: string;
    }>(
      `SELECT seq, title, body, props, when_at, actor, action, origin, at
       FROM memory_history WHERE node_id = ? ORDER BY seq ASC`,
      [id],
    )
    .map((r) => ({
      seq: r.seq,
      title: r.title,
      body: r.body,
      props: parseProps(r.props),
      when: r.when_at,
      actor: r.actor as "owner" | "agent" | "system",
      action: r.action,
      origin: r.origin,
      at: r.at,
    }));
}

/** Idempotent on (source, target, type): a duplicate returns the existing
 * edge without a second audit row — the existing edge's validity wins;
 * closeEdge is the verb for changing it. Validity is declared, never
 * inferred (I15): strict ISO only, and system edge types refuse it. */
export function insertEdge(
  ctx: Ctx,
  source: NodeId,
  target: NodeId,
  type: string,
  context: string,
  actor: Actor,
  validity?: Validity,
): Edge {
  const edgeType = type.trim() === "" ? "links" : type.trim();
  let from: string | null = null;
  let until: string | null = null;
  if (validity?.from !== undefined) from = parseStrictIso(validity.from, "validity.from");
  if (validity?.until !== undefined) until = parseStrictIso(validity.until, "validity.until");
  if (from !== null && until !== null && until <= from)
    throw new MemoryError("props_invalid", "validity.until must be after validity.from");
  if ((from !== null || until !== null) && (SYSTEM_EDGE_TYPES as readonly string[]).includes(edgeType))
    throw new MemoryError("conflict", `system edge type ${JSON.stringify(edgeType)} is timeless (I15)`);
  const id = ulid(ctx.now().getTime());
  const res = ctx.mem.run(
    `INSERT INTO edges (id, source, target, type, context, created, valid_from, valid_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, target, type) DO NOTHING`,
    [id, source, target, edgeType, context, ctx.now().toISOString(), from, until],
  );
  if (res.changes === 0) {
    const existing = ctx.mem.get<EdgeRow>(
      `SELECT ${EDGE_COLS} FROM edges WHERE source = ? AND target = ? AND type = ?`,
      [source, target, edgeType],
    );
    if (existing === null) throw new MemoryError("conflict", "edge insert raced and vanished");
    return rowToEdge(existing);
  }
  audit(ctx, actor, "edge.create", id, true, { type: edgeType });
  const row = ctx.mem.get<EdgeRow>(`SELECT ${EDGE_COLS} FROM edges WHERE id = ?`, [id]);
  if (row === null) throw new MemoryError("conflict", "edge insert raced and vanished");
  return rowToEdge(row);
}

/**
 * This fact stopped being true (TEMPORAL.md): sets valid_until (default:
 * the store clock's now) and KEEPS the row — "what was true last spring?"
 * stays a plain query. Refuses system edge types (I15 — closing a no_match
 * would reopen I9 through the side door), an already-closed edge (loud:
 * closing twice is a host bug worth hearing about), and an `until` at or
 * before valid_from. Audited content-free.
 */
export function closeEdge(ctx: Ctx, id: EdgeId, until?: string): Edge {
  const row = ctx.mem.get<EdgeRow>(`SELECT ${EDGE_COLS} FROM edges WHERE id = ?`, [id]);
  if (row === null) throw new MemoryError("not_found", `no edge ${id}`);
  if ((SYSTEM_EDGE_TYPES as readonly string[]).includes(row.type))
    throw new MemoryError("conflict", `system edge type ${JSON.stringify(row.type)} is timeless (I15)`);
  if (row.valid_until !== null) throw new MemoryError("conflict", `edge ${id} is already closed`);
  const at = until !== undefined ? parseStrictIso(until, "until") : ctx.now().toISOString();
  if (row.valid_from !== null && at <= row.valid_from)
    throw new MemoryError("props_invalid", "until must be after valid_from");
  ctx.mem.run("UPDATE edges SET valid_until = ? WHERE id = ?", [at, id]);
  audit(ctx, "owner", "edge.close", id, true, {});
  return rowToEdge({ ...row, valid_until: at });
}

// --- lifecycle primitives owned by the spine ---

export function transition(ctx: Ctx, id: NodeId, to: Status): Node {
  const node = mustGet(ctx, id);
  const allowed = TRANSITIONS[node.status];
  if (!allowed.includes(to)) {
    audit(ctx, "owner", "node.transition", id, false, { from: node.status, to });
    throw new MemoryError("invalid_transition", `cannot move ${id} from ${node.status} to ${to}`);
  }
  return ctx.mem.transaction(() => {
    // Leaving active orphans any parked edit — clear it with the move (review #13).
    if (node.status === "active" && to !== "active") {
      ctx.mem.run("DELETE FROM pending_edits WHERE node_id = ?", [id]);
    }
    // Leaving quarantine clears the re-review date; the state carries it, not the node.
    ctx.mem.run(
      "UPDATE nodes SET status = ?, review_at = CASE WHEN ? = 'quarantined' THEN review_at ELSE NULL END, updated = ? WHERE id = ?",
      [to, to, ctx.now().toISOString(), id],
    );
    audit(ctx, "owner", "node.transition", id, true, { from: node.status, to });
    const updated = mustGet(ctx, id);
    reindexNode(ctx, updated); // status gates index membership
    return updated;
  });
}

export function setSurfacing(ctx: Ctx, id: NodeId, s: Surfacing): void {
  const node = mustGet(ctx, id);
  ctx.mem.run("UPDATE nodes SET surfacing = ?, updated = ? WHERE id = ?", [s, ctx.now().toISOString(), id]);
  audit(ctx, "owner", "node.surfacing", id, true, { from: node.surfacing, to: s });
}

/** Record that recalled knowledge was actually used. Deliberately does NOT
 * bump `updated` — usage is not a content change: the "(as of …)"
 * freshness signal stays honest. */
export function touch(ctx: Ctx, id: NodeId): void {
  const node = mustGet(ctx, id);
  if (node.status !== "active")
    throw new MemoryError(
      "invalid_transition",
      `cannot touch ${id} (status=${node.status}) — usage is an active-node signal`,
    );
  ctx.mem.run("UPDATE nodes SET use_count = use_count + 1, last_used = ? WHERE id = ?", [
    ctx.now().toISOString(),
    id,
  ]);
  audit(ctx, "system", "node.touch", id, true, { useCount: node.useCount + 1 });
}
