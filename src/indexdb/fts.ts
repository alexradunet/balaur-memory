/**
 * FTS sidecar maintenance (index.db). Phase 1 owns writes + rebuild;
 * Phase 2 adds querying/ranking. Only ACTIVE nodes belong in the index —
 * the consent filter (I2) starts at write time. Losing index.db is always
 * safe (I13): rebuildFts reconstructs it exactly from memory.db.
 *
 * The `extra` column carries one blessed convention: a node's
 * `props.when_to_use` string, when present — a recall hint indexed
 * alongside title/body. (Phase 2 may refine this; the column is part of the
 * schema either way.)
 */

import type { SqlDb } from "../storage/adapter.ts";

export interface FtsDoc {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly content: string;
  readonly extra: string;
  readonly status: string;
}

function extraOf(props: Record<string, unknown>): string {
  const v = props["when_to_use"];
  return typeof v === "string" ? v : "";
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

/** Drop and refill from the source of truth. Idempotent; safe any time. */
export function rebuildFts(idx: SqlDb, mem: SqlDb): void {
  idx.transaction(() => {
    idx.run("DELETE FROM nodes_fts");
    const rows = mem.query<{ id: string; type: string; title: string; body: string; props: string }>(
      "SELECT id, type, title, body, props FROM nodes WHERE status = 'active'",
    );
    for (const r of rows) {
      const props = JSON.parse(r.props) as Record<string, unknown>;
      idx.run("INSERT INTO nodes_fts (id, kind, title, content, extra) VALUES (?, ?, ?, ?, ?)", [
        r.id,
        r.type,
        r.title,
        r.body,
        extraOf(props),
      ]);
    }
  });
}
