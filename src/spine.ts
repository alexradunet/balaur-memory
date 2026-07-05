/**
 * The spine: nodes + edges CRUD, the status FSM, the type registry, and the
 * write fan-out (FTS upsert, on_day anchor, audit). Every mutation of
 * nodes/edges flows through this module's choke points (CODING.md) — that is
 * what makes I10 (provenance at birth) and I12 (audit coverage) hold by
 * construction rather than by discipline.
 */

import { upsertFts } from "./indexdb/fts.ts";
import type { SqlDb, SqlRow } from "./storage/adapter.ts";
import { ulid } from "./storage/ulid.ts";
import {
  type Edge,
  type EdgeId,
  MemoryError,
  type Node,
  type NodeId,
  type NodeTypeSpec,
  type Props,
  type Status,
  type Surfacing,
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
  created: string;
  updated: string;
}

const NODE_COLS =
  "id, type, title, body, status, surfacing, importance, props, origin, author, use_count, last_used, review_at, created, updated";

function rowToNode(r: NodeRow): Node {
  return {
    id: r.id as NodeId, // brand boundary
    type: r.type,
    title: r.title,
    body: r.body,
    status: r.status as Status,
    surfacing: r.surfacing as Surfacing,
    importance: r.importance,
    props: JSON.parse(r.props) as Props,
    origin: r.origin,
    author: r.author,
    useCount: r.use_count,
    lastUsed: r.last_used,
    reviewAt: r.review_at,
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
 * Undeclared keys pass through — an empty schema allows any props. */
function applyTemplateAndValidate(
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
  if (importance < 0 || importance > 5)
    throw new MemoryError("props_invalid", "importance must be between 0 and 5");
  const t = typeRow(ctx, input.type);
  const { body, props } = applyTemplateAndValidate(t, input.body ?? "", input.props ?? {});
  const at = ctx.now();
  const iso = at.toISOString();
  const id = ulid(at.getTime());

  return ctx.mem.transaction(() => {
    ctx.mem.run(
      `INSERT INTO nodes (id, type, title, body, status, surfacing, importance, props, origin, author, created, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      extra: typeof node.props["when_to_use"] === "string" ? (node.props["when_to_use"] as string) : "",
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

// --- reads ---

export function mustGet(ctx: Ctx, id: NodeId): Node {
  const row = ctx.mem.get<NodeRow>(`SELECT ${NODE_COLS} FROM nodes WHERE id = ?`, [id]);
  if (row === null) throw new MemoryError("not_found", `no node ${id}`);
  return rowToNode(row);
}

/** 1-hop active-only set around a node (I3: the consent filter on traversal). */
export function neighborhood(ctx: Ctx, id: NodeId): Node[] {
  const rows = ctx.mem.query<NodeRow>(
    `SELECT DISTINCT ${NODE_COLS.split(", ")
      .map((c) => `n.${c}`)
      .join(", ")}
     FROM nodes n
     JOIN edges e ON (e.source = ? AND e.target = n.id) OR (e.target = ? AND e.source = n.id)
     WHERE n.status = 'active'`,
    [id, id],
  );
  return rows.map(rowToNode);
}

// --- update (owner edits to active, owner-authored nodes) ---

export function updateNode(
  ctx: Ctx,
  id: NodeId,
  patch: { title?: string; body?: string; props?: Props },
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

  return ctx.mem.transaction(() => {
    ctx.mem.run("UPDATE nodes SET title = ?, body = ?, props = ?, updated = ? WHERE id = ?", [
      title,
      nextBody,
      JSON.stringify(nextProps),
      ctx.now().toISOString(),
      id,
    ]);
    audit(ctx, "owner", "node.update", id, true, { type: node.type });
    const updated = mustGet(ctx, id);
    reindexNode(ctx, updated);
    return updated;
  });
}

export function reindexNode(ctx: Ctx, node: Node): void {
  try {
    upsertFts(ctx.idx, {
      id: node.id,
      kind: node.type,
      title: node.title,
      content: node.body,
      extra: typeof node.props["when_to_use"] === "string" ? (node.props["when_to_use"] as string) : "",
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
}

function rowToEdge(r: EdgeRow): Edge {
  return {
    id: r.id as EdgeId, // brand boundary
    source: r.source as NodeId,
    target: r.target as NodeId,
    type: r.type,
    context: r.context,
    created: r.created,
  };
}

/** Idempotent on (source, target, type): a duplicate returns the existing
 * edge without a second audit row. */
export function insertEdge(
  ctx: Ctx,
  source: NodeId,
  target: NodeId,
  type: string,
  context: string,
  actor: Actor,
): Edge {
  const edgeType = type.trim() === "" ? "links" : type.trim();
  const id = ulid(ctx.now().getTime());
  const res = ctx.mem.run(
    `INSERT INTO edges (id, source, target, type, context, created) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, target, type) DO NOTHING`,
    [id, source, target, edgeType, context, ctx.now().toISOString()],
  );
  if (res.changes === 0) {
    const existing = ctx.mem.get<EdgeRow>(
      "SELECT id, source, target, type, context, created FROM edges WHERE source = ? AND target = ? AND type = ?",
      [source, target, edgeType],
    );
    if (existing === null) throw new MemoryError("conflict", "edge insert raced and vanished");
    return rowToEdge(existing);
  }
  audit(ctx, actor, "edge.create", id, true, { type: edgeType });
  const row = ctx.mem.get<EdgeRow>(
    "SELECT id, source, target, type, context, created FROM edges WHERE id = ?",
    [id],
  );
  if (row === null) throw new MemoryError("conflict", "edge insert raced and vanished");
  return rowToEdge(row);
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
    ctx.mem.run("UPDATE nodes SET status = ?, updated = ? WHERE id = ?", [to, ctx.now().toISOString(), id]);
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
 * bump `updated` — usage is not a content change (divergence from balaur,
 * documented): the "(as of …)" freshness signal stays honest. */
export function touch(ctx: Ctx, id: NodeId): void {
  const node = mustGet(ctx, id);
  ctx.mem.run("UPDATE nodes SET use_count = use_count + 1, last_used = ? WHERE id = ?", [
    ctx.now().toISOString(),
    id,
  ]);
  audit(ctx, "system", "node.touch", id, true, { useCount: node.useCount + 1 });
}
