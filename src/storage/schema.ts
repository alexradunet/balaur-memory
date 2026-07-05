/**
 * DDL and migrations for both files, verbatim from docs/SCHEMA.md — if this
 * file and SCHEMA.md disagree, SCHEMA.md wins and this file gets fixed.
 * Never edit an applied migration; append and bump SCHEMA_VERSION.
 */

import type { SqlDb } from "./adapter.ts";
import { ulid } from "./ulid.ts";

export const SCHEMA_VERSION = 1;

const MEMORY_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS node_types (
  name          TEXT PRIMARY KEY,
  born_status   TEXT NOT NULL DEFAULT 'active'
                CHECK (born_status IN ('active','proposed')),
  props_schema  TEXT NOT NULL DEFAULT '{}',
  template      TEXT NOT NULL DEFAULT '{}',
  created       TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS nodes (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL REFERENCES node_types(name),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL
             CHECK (status IN ('proposed','active','archived','rejected',
                               'quarantined','forgotten','merged')),
  surfacing  TEXT NOT NULL DEFAULT 'always'
             CHECK (surfacing IN ('always','ask','never')),
  importance INTEGER NOT NULL DEFAULT 0 CHECK (importance BETWEEN 0 AND 5),
  props      TEXT NOT NULL DEFAULT '{}',
  origin     TEXT NOT NULL DEFAULT '',
  author     TEXT NOT NULL DEFAULT '',
  use_count  INTEGER NOT NULL DEFAULT 0,
  last_used  TEXT,
  review_at  TEXT,
  created    TEXT NOT NULL,
  updated    TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_nodes_type_status ON nodes(type, status);
CREATE INDEX IF NOT EXISTS idx_nodes_status_imp  ON nodes(status, importance DESC);

CREATE TABLE IF NOT EXISTS edges (
  id      TEXT PRIMARY KEY,
  source  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target  TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type    TEXT NOT NULL DEFAULT 'links',
  context TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  UNIQUE (source, target, type)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);

CREATE TABLE IF NOT EXISTS pending_edits (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  fields  TEXT NOT NULL DEFAULT '{}',
  archive INTEGER NOT NULL DEFAULT 0 CHECK (archive IN (0,1)),
  origin  TEXT NOT NULL DEFAULT '',
  author  TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS derivations (
  artifact TEXT NOT NULL,
  source   TEXT NOT NULL,
  stale    INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0,1)),
  created  TEXT NOT NULL,
  PRIMARY KEY (artifact, source)
) STRICT;

CREATE TABLE IF NOT EXISTS audit_log (
  id     TEXT PRIMARY KEY,
  at     TEXT NOT NULL,
  actor  TEXT NOT NULL CHECK (actor IN ('owner','agent','system')),
  action TEXT NOT NULL,
  ref    TEXT NOT NULL DEFAULT '',
  ok     INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0,1)),
  meta   TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
`;

const INDEX_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  id UNINDEXED, kind UNINDEXED, title, content, extra
);
CREATE TABLE IF NOT EXISTS vectors (
  id    TEXT NOT NULL,
  model TEXT NOT NULL,
  dim   INTEGER NOT NULL,
  vec   BLOB NOT NULL,
  PRIMARY KEY (id, model)
) STRICT;
`;

/** Apply the memory.db baseline (idempotent) and record meta rows. */
export function migrateMemoryDb(db: SqlDb, now: () => Date): void {
  db.exec(MEMORY_DDL);
  const version = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
  if (version === null) {
    const at = now().toISOString();
    db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
    db.run("INSERT INTO meta (key, value) VALUES ('store_id', ?)", [ulid(now().getTime())]);
    db.run("INSERT INTO meta (key, value) VALUES ('created', ?)", [at]);
    return;
  }
  // Future versions: switch on Number(version.value) and apply deltas here.
}

/** Apply the index.db baseline. The whole file is disposable (I13). */
export function migrateIndexDb(db: SqlDb): void {
  db.exec(INDEX_DDL);
}
