/**
 * FTS sidecar maintenance (index.db). Phase 1 owns writes + rebuild;
 * Phase 2 adds querying/ranking. Only ACTIVE nodes belong in the index —
 * the consent filter (I2) starts at write time. Losing index.db is always
 * safe (I13): rebuildFts reconstructs it exactly from memory.db.
 *
 * The `extra` column carries two blessed conventions: a node's
 * `props.when_to_use` string, and (schema v2) the node's aliases — so an
 * alias hit surfaces the node in recall (ENTITIES.md, owner-confirmed).
 */

import type { SqlDb } from "../storage/adapter.ts";
import { parseProps } from "../types.ts";

export interface FtsDoc {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly content: string;
  readonly extra: string;
  readonly status: string;
}

function extraOf(props: Record<string, unknown>, aliasText = ""): string {
  const v = props["when_to_use"];
  const hint = typeof v === "string" ? v : "";
  return [hint, aliasText].filter((x) => x !== "").join(" ");
}

/** Space-joined aliases of a node, for the extra column. */
export function aliasTextFor(mem: SqlDb, id: string): string {
  return mem
    .query<{ alias: string }>("SELECT alias FROM aliases WHERE node_id = ? ORDER BY alias", [id])
    .map((r) => r.alias)
    .join(" ");
}

/** Delete-then-insert so upsert is idempotent; non-active docs just delete. */
export function upsertFts(idx: SqlDb, doc: FtsDoc): void {
  idx.run("DELETE FROM nodes_fts WHERE id = ?", [doc.id]);
  if (doc.status !== "active") return;
  idx.run("INSERT INTO nodes_fts (id, kind, title, content, extra) VALUES (?, ?, ?, ?, ?)", [
    doc.id,
    doc.kind,
    doc.title,
    doc.content,
    doc.extra,
  ]);
}

export function deleteFts(idx: SqlDb, id: string): void {
  idx.run("DELETE FROM nodes_fts WHERE id = ?", [id]);
}

/** Drop and refill from the source of truth. Idempotent; safe any time.
 * Alias text is ORDER BY alias to match aliasTextFor exactly — I13 says
 * "reconstructs exactly", and GROUP_CONCAT without ORDER BY is arbitrary
 * (review-2 F6). */
export function rebuildFts(idx: SqlDb, mem: SqlDb): void {
  idx.transaction(() => {
    idx.run("DELETE FROM nodes_fts");
    const rows = mem.query<{
      id: string;
      type: string;
      title: string;
      body: string;
      props: string;
      als: string;
    }>(
      `SELECT n.id, n.type, n.title, n.body, n.props,
              COALESCE(GROUP_CONCAT(a.alias, ' ' ORDER BY a.alias), '') AS als
       FROM nodes n LEFT JOIN aliases a ON a.node_id = n.id
       WHERE n.status = 'active' GROUP BY n.id`,
    );
    for (const r of rows) {
      const props = parseProps(r.props) as Record<string, unknown>;
      idx.run("INSERT INTO nodes_fts (id, kind, title, content, extra) VALUES (?, ?, ?, ?, ?)", [
        r.id,
        r.type,
        r.title,
        r.body,
        extraOf(props, r.als),
      ]);
    }
  });
}
