# SCHEMA.md — the data contract

This file is the library's real API: the SQLite schema, its semantics, and
its numbered invariants. Code in any language that honors this file is a
conforming implementation. Changes here are contract changes: they bump
`meta.schema_version` and ship with a migration.

Two files:

- **`memory.db`** — the record. Source of truth, backed up, treated as
  precious.
- **`index.db`** — the sidecar. FTS + vectors, derived entirely from
  `memory.db`. **Deleting it is always safe** (I13); it rebuilds from source.

Conventions: timestamps are ISO-8601 UTC with milliseconds
(`2026-07-05T20:14:03.123Z`), stored as TEXT. IDs are lowercase ULIDs
(26 chars, Crockford base32) — time-prefixed, so lexical order is creation
order. JSON columns hold canonical JSON objects, never arrays at the top
level, `{}` when empty.

## memory.db

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
-- rows: schema_version (integer as text, currently "2"), store_id (ulid),
--       created (timestamp)

CREATE TABLE node_types (
  name          TEXT PRIMARY KEY,          -- "memory", "skill", "note", "person", ...
  born_status   TEXT NOT NULL DEFAULT 'active'
                CHECK (born_status IN ('active','proposed')),
  props_schema  TEXT NOT NULL DEFAULT '{}', -- prop key -> {type, required}
  template      TEXT NOT NULL DEFAULT '{}', -- default props/body for new nodes
  created       TEXT NOT NULL
) STRICT;

CREATE TABLE nodes (
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
  origin     TEXT NOT NULL DEFAULT '',  -- provenance: host-defined source ref
  author     TEXT NOT NULL DEFAULT '',  -- '' = owner; else third-party attribution
  use_count  INTEGER NOT NULL DEFAULT 0,
  last_used  TEXT,                      -- null until first Touch
  review_at  TEXT,                      -- quarantine re-review date, else null
  created    TEXT NOT NULL,
  updated    TEXT NOT NULL
) STRICT;
CREATE INDEX idx_nodes_type_status ON nodes(type, status);
CREATE INDEX idx_nodes_status_imp  ON nodes(status, importance DESC);

CREATE TABLE edges (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target      TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'links',
  context     TEXT NOT NULL DEFAULT '',
  created     TEXT NOT NULL,          -- transaction time: when recorded
  valid_from  TEXT,                   -- (v3) world time: NULL = undated
  valid_until TEXT,                   -- (v3) NULL = still true
  UNIQUE (source, target, type)
) STRICT;
CREATE INDEX idx_edges_target ON edges(target);

CREATE TABLE pending_edits (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  fields  TEXT NOT NULL DEFAULT '{}',  -- proposed field -> new value
  archive INTEGER NOT NULL DEFAULT 0 CHECK (archive IN (0,1)),
  origin  TEXT NOT NULL DEFAULT '',
  author  TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL
) STRICT;

CREATE TABLE derivations (          -- lineage: what was built from what
  artifact TEXT NOT NULL,           -- node id OR host ref ("host:recap:2026-07-04")
  source   TEXT NOT NULL,           -- node id OR host ref
  stale    INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0,1)),
  created  TEXT NOT NULL,
  PRIMARY KEY (artifact, source)
) STRICT;

CREATE TABLE audit_log (
  id     TEXT PRIMARY KEY,
  at     TEXT NOT NULL,
  actor  TEXT NOT NULL CHECK (actor IN ('owner','agent','system')),
  action TEXT NOT NULL,             -- "node.create", "consent.approve", "forget.cascade", ...
  ref    TEXT NOT NULL DEFAULT '',  -- node/edge id — never content
  ok     INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0,1)),
  meta   TEXT NOT NULL DEFAULT '{}' -- ids, counts, flags — never quoted text
) STRICT;
CREATE INDEX idx_audit_at ON audit_log(at);
```

### Version 2 — identity resolution (docs/ENTITIES.md)

```sql
-- Names a node also answers to. One alias may point at MANY nodes (two
-- different Anas): lookups return candidates, never a winner.
CREATE TABLE aliases (
  alias   TEXT NOT NULL,   -- normalized (lowercase, collapsed whitespace)
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  source  TEXT NOT NULL CHECK (source IN ('owner','merge')),
  created TEXT NOT NULL,
  PRIMARY KEY (alias, node_id)
) STRICT;
CREATE INDEX idx_aliases_node ON aliases(node_id);

-- Open identity questions (Phase B writes these): unordered pair, a < b.
CREATE TABLE identity_pending (
  a        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  b        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  evidence TEXT NOT NULL CHECK (evidence IN ('title_match','token_subset','alias_match')),
  created  TEXT NOT NULL,
  PRIMARY KEY (a, b)
) STRICT;

-- (v3) What a node used to say (TEMPORAL.md): append-only PRE-mutation
-- snapshots, actor-attributed. Content-bearing BY DESIGN — the complement
-- to the content-free audit log, with the opposite fate under forget (I16).
CREATE TABLE memory_history (
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
```

Aliases are content: they join the FTS `extra` column (an alias hit
surfaces the node in recall) and the forget cascade deletes them (I6).

## index.db (disposable)

```sql
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  id UNINDEXED, kind UNINDEXED, title, content, extra
);
CREATE TABLE vectors (
  id    TEXT NOT NULL,              -- node id
  model TEXT NOT NULL,              -- host-declared vector-space identity
  dim   INTEGER NOT NULL,
  vec   BLOB NOT NULL,              -- little-endian float32, length = dim*4
  PRIMARY KEY (id, model)
) STRICT;
```

## System edge types

| type | source → target | written by | meaning |
|---|---|---|---|
| `links` | any → any | host | generic association (default) |
| `on_day` | node → day node | library | episodic anchor at creation |
| `supersedes` | new → old | library (Decide) | validity chain; old is archived |
| `merged_into` | duplicate → survivor | library | entity-resolution outcome |
| `no_match` | a ↔ b | library (Decide) | owner ruled distinct — never re-propose (I9) |
| `derived_from` | artifact → source | library (recordDerivation) | lineage; cascade root |

Day anchors are keyed by the **UTC calendar day** (I11 — the library is
UTC-only). A host whose owner lives east of UTC should know a late-night
capture files under the UTC day, which may be "yesterday" locally; hosts
wanting owner-local day semantics register and link their own day-like
nodes.

## Status semantics

| status | meaning | reachable from | leaves to |
|---|---|---|---|
| proposed | agent-authored, awaiting owner | (birth) | active, rejected |
| active | part of memory | proposed, archived, quarantined | archived, quarantined, forgotten |
| archived | soft-retired; recallable only by direct query | active | active, forgotten |
| rejected | owner said no; terminal | proposed | — |
| quarantined | actively suppressed everywhere; ask-twice; optional `review_at` | active | active, forgotten |
| forgotten | content destroyed (tombstone); terminal | active, archived, quarantined, merged | — |
| merged | duplicate folded into a survivor; content-preserving husk | active | forgotten |

## Invariants (conformance fixtures reference these by number)

- **I1 — Consent boundary.** A node whose type has `born_status='proposed'`
  enters as `proposed` when `author`/agent-authored, and only an owner
  decision moves it to `active`/`rejected`. Owner-authored nodes are born
  `active`.
- **I2 — Recall filter.** Ambient recall (`recall`, `search`) returns only
  `status='active' AND surfacing='always'` nodes. `surfacing='ask'` nodes
  are returned only when the query names them — an explicit term hit on
  the title, or on the resolution surfaces (`resolveRef`) an
  exact-normalized match of the title or an alias (an alias IS a name) —
  never via broad matching. `surfacing='never'` nodes are reachable only
  by `getNode(id)`.
- **I3 — Traversal filter.** Graph reads (`neighborhood`) return active
  nodes only, exclude `surfacing='never'` neighbors (I2 composes with
  traversal — never means never), and exclude `day` anchors (plumbing,
  the same rule as ambient recall). `ask` neighbors are returned:
  traversal is an owner-facing read of a named subject, not ambient
  matching.
- **I4 — Write-time gate.** `propose` MUST route: normalized-title equality
  vs a pending proposal → merge into it (`merged_pending`); vs an active
  node of the same type → no write at all (`exists_active`); else create
  (`created`). Normalization: lowercase, collapse whitespace.
- **I5 — Adjudication is compound and ordered.** `approve_superseding`
  performs: activate new → archive old → write `supersedes` edge → audit.
  A mid-sequence failure stops and surfaces; no silent rollback of audited
  steps.
- **I6 — Tombstone semantics.** `forget` sets `status='forgotten'`,
  `title=''`, `body=''`, `props='{}'`, `origin=''`, `author=''`; clears
  `pending_edits`, (v2) the node's `aliases` and its open
  `identity_pending` questions, and (v3) its `memory_history` rows;
  deletes the node's edges; scrubs it from `nodes_fts` and `vectors`;
  marks `derivations` rows with it as `source` stale; lists merged husks
  chained into it as `husk:<id>` in the report's `needsOwner` (computed
  before the edges drop). The row, `type`, and timestamps survive.
- **I7 — Content-free forget audit.** Audit entries for forget-class actions
  carry ids and counts only. No audit row anywhere carries node title/body
  text.
- **I8 — Terminality.** `rejected` and `forgotten` have no outgoing
  transitions. `merged` is terminal for the FSM and for identity verdicts,
  with one deliberate exception: a husk still holds content, so `forget`
  may destroy it (ENTITIES.md amendment).
- **I9 — No re-litigation.** After a `no_match` edge exists between two
  nodes (either direction): (a) no candidate rule ever re-inserts the pair
  into `identity_pending`, and (b) `decideIdentity(..., "same")` on the
  pair is refused. Answered means answered — the Apple Photos lesson.
- **I10 — Provenance at birth.** Every insert into `nodes` sets `origin`
  (host-supplied; `''` only for owner-manual creations). `author` is set
  whenever content carries a third party's words.
- **I11 — Timestamps and IDs.** All times UTC ISO-8601 with ms; all ids
  lowercase ULID, monotonic within a millisecond per process — under I14's
  single writer, lexical id order IS creation order. `updated >= created`
  always.
- **I12 — Audit coverage.** Every mutation of `nodes`, `edges`,
  `pending_edits`, and every decision writes exactly one audit row
  (compound decisions: one per step plus one summary). (v3)
  `memory_history` snapshots ride inside mutations that already audit —
  they add no audit rows of their own; the history row is the record.
- **I13 — Disposable index.** Deleting `index.db` loses no information;
  `rebuildIndex()` reconstructs it from `memory.db` exactly (FTS rows for
  active nodes only; vectors are re-suppliable by the host).
- **I14 — Single writer.** One `Store` instance owns writes to a given
  `memory.db`. WAL mode permits concurrent external readers (e.g., any
  external tool mounting the file read-only).
- **I15 — Validity is declared, never inferred.** (v3) `valid_from` /
  `valid_until` are set only from explicit arguments to `link`/`closeEdge`
  (strict ISO-8601 UTC; date-only = midnight UTC; `until > from`). The
  library never derives a validity date from content, context, or clock
  heuristics. System edge types (`on_day`, `supersedes`, `merged_into`,
  `no_match`, `derived_from`) carry NULL validity always, and `closeEdge`
  refuses them — closing a `no_match` edge would reopen I9 through the
  side door. Edge-carrying reads (`neighborhood`, `entityContext`) default
  to the currently-valid world; `asOf` time-travels.
- **I16 — History dies with the tombstone.** (v3) `memory_history` rows
  are content: `forget(id)` removes every row for the node in the cascade
  transaction. Audit rows, being content-free, survive. History is
  append-only otherwise — no other verb may delete it. (Producers land
  with temporal Phase B.)

## Deliberate schema choices

- Lowercase ULIDs for every id; strict ISO-8601 UTC timestamps with
  milliseconds, everywhere.
- `importance`, `surfacing`, provenance are real columns, not `props` keys —
  they carry invariants; JSON is for host-defined data only.
- Pending edits are a table, not a `props` envelope — the queue is queryable.
- `STRICT` tables throughout.
