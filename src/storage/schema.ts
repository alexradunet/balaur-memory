/**
 * DDL and migrations for both files, verbatim from docs/SCHEMA.md — if this
 * file and SCHEMA.md disagree, SCHEMA.md wins and this file gets fixed.
 * Never edit an applied migration; append and bump SCHEMA_VERSION.
 */

import { MemoryError } from "../types.ts";
import type { SqlDb } from "./adapter.ts";
import { ulid } from "./ulid.ts";

export const SCHEMA_VERSION = 4;

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

// --- v2: identity resolution (docs/ENTITIES.md) ---
const V2_DDL = `
CREATE TABLE IF NOT EXISTS aliases (
  alias   TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  source  TEXT NOT NULL CHECK (source IN ('owner','merge')),
  created TEXT NOT NULL,
  PRIMARY KEY (alias, node_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_aliases_node ON aliases(node_id);

CREATE TABLE IF NOT EXISTS identity_pending (
  a        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  b        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  evidence TEXT NOT NULL CHECK (evidence IN ('title_match','token_subset','alias_match')),
  created  TEXT NOT NULL,
  PRIMARY KEY (a, b)
) STRICT;
`;

// --- v3: the temporal arc (docs/TEMPORAL.md) ---
// Edges gain world-time validity (NULL from = undated; NULL until = still
// true — the honest reading of every pre-v3 edge). memory_history lands in
// the same bump; its writers arrive with Phase B.
const V3_DDL = `
ALTER TABLE edges ADD COLUMN valid_from  TEXT;
ALTER TABLE edges ADD COLUMN valid_until TEXT;

CREATE TABLE IF NOT EXISTS memory_history (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  title   TEXT NOT NULL,
  body    TEXT NOT NULL,
  props   TEXT NOT NULL,
  actor   TEXT NOT NULL CHECK (actor IN ('owner','agent','system')),
  action  TEXT NOT NULL,
  origin  TEXT NOT NULL,
  at      TEXT NOT NULL,
  PRIMARY KEY (node_id, seq)
) STRICT;
`;

// --- v4: the planning arc (docs/PLANNING.md) ---
// Nodes gain an appointment with the future: when_at, the world-time
// moment a node is scheduled for / happens at (NULL = undated — most
// memories). History snapshots carry it too — a reminder's time is
// content, and "when did I move this deadline" is a history question.
const V4_DDL = `
ALTER TABLE nodes ADD COLUMN when_at TEXT;
ALTER TABLE memory_history ADD COLUMN when_at TEXT;
CREATE INDEX IF NOT EXISTS idx_nodes_when ON nodes(when_at) WHERE when_at IS NOT NULL;
`;

/** Apply the memory.db baseline + versioned deltas (idempotent). Fresh
 * stores land directly on SCHEMA_VERSION; older stores upgrade in order.
 * Never edit an applied delta — append and bump (CODING.md). */
export function migrateMemoryDb(db: SqlDb, now: () => Date): void {
  db.exec(MEMORY_DDL);
  const version = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
  if (version === null) {
    db.exec(V2_DDL);
    db.exec(V3_DDL);
    db.exec(V4_DDL);
    const at = now().toISOString();
    db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
    db.run("INSERT INTO meta (key, value) VALUES ('store_id', ?)", [ulid(now().getTime())]);
    db.run("INSERT INTO meta (key, value) VALUES ('created', ?)", [at]);
    return;
  }
  const v = Number(version.value);
  // The forward-compat guard (review-3 A3): a file from the FUTURE — a
  // newer schema than this build knows — must refuse loudly. Over decades
  // a precious file WILL meet an older binary (a rollback, a stale backup
  // tool, a second machine); running old code against an unknown schema is
  // the one silent way to corrupt the record. Upgrade the library, never
  // downgrade the file.
  if (Number.isNaN(v) || v > SCHEMA_VERSION)
    throw new MemoryError(
      "conflict",
      `memory.db is schema v${version.value}; this build supports up to v${SCHEMA_VERSION} — upgrade the library, never downgrade the file`,
    );
  if (v < 2) {
    db.exec(V2_DDL);
    db.run("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
  }
  if (v < 3) {
    db.exec(V3_DDL);
    db.run("UPDATE meta SET value = '3' WHERE key = 'schema_version'");
  }
  if (v < 4) {
    db.exec(V4_DDL);
    db.run("UPDATE meta SET value = '4' WHERE key = 'schema_version'");
  }
}

/** Apply the index.db baseline. The whole file is disposable (I13). */
export function migrateIndexDb(db: SqlDb): void {
  db.exec(INDEX_DDL);
}
