# TEMPORAL.md — time as truth: edge validity + memory history (design)

- **Status:** ARC COMPLETE — the owner confirmed all five open questions
  (primitive `closeEdge` only; no auto-close on supersede; the three
  capture moments; `asOf` defaults to the currently-valid world; no undo
  verb). Phase A (validity, PR #17, schema v3 + v0.3.0); Phase B
  (history, PR #18, v0.3.1). Both invariants producer-backed: I15 and
  I16 are conformance-pinned.
- **Ships as:** **schema_version 3** and **v0.3.0**. No API-breaking
  changes: two new columns, one new table, two new verbs, optional
  parameters on three existing reads.
- **Pins:** two new invariants (I15 declared validity, I16 forgettable
  history) plus amendments to I6 and I12.
- **Research basis:** the 2026 field survey. Zep/Graphiti's bi-temporal
  edge model (`valid_at`/`invalid_at`, facts invalidated never deleted) is
  the reference architecture — and its bug tracker is the cautionary tale:
  LLM-driven temporal extraction hallucinates "today" as the validity date
  in ~56% of historical backfills (graphiti issue #1492). Letta's
  `BlockHistory` (append-only, actor-attributed content snapshots) is the
  best content-versioning prior art — and, like every history mechanism in
  the survey, it never asks what happens when the owner says *forget*.
  This arc steals both mechanisms and fixes both blind spots.

## The problem

The library can replace a whole node (`approve_superseding`), destroy one
(`forget`), and suppress one (`quarantine`) — but it cannot say the one
thing a life says constantly: **"this was true, and then it stopped."**

- *Ana works at Siemens* is a `works_at` edge. Ana changes jobs. Today the
  host either deletes the edge (the past is lost) or leaves it (the graph
  lies). There is no third option, and the third option is the true one.
- The owner corrects a memory through `approve_edited` and the old wording
  is simply gone. The audit log proves *that* a change happened — it is
  content-free by design (I7) — but "what did this say before, and who
  changed it?" is unanswerable. For a memory system that promises
  provenance, silent self-overwriting is a gap.

Two mechanisms, one arc, because they are the same idea applied to the two
kinds of truth the store holds: **edges get validity windows** (world-truth
has a time span) and **nodes get content history** (recorded-truth has
versions).

## Design principles (inherited, not invented)

1. **Declared, never inferred.** Validity timestamps come from the host or
   the owner as explicit arguments — the library never guesses, extends,
   shortens, or defaults them from context. The field's reference
   implementation shows exactly how LLM-inferred `valid_at` fails; we do
   not have that failure mode because we do not have that pathway.
   *Vectors in, never models* already implies *dates in, never models*.
2. **Nothing true is destroyed by becoming false.** Closing an edge sets
   `valid_until` and keeps the row — "what was true last spring?" stays a
   plain query. Forgetting remains a separate, explicit act (I6), and it
   is the ONLY thing that destroys.
3. **History is content; audit is not.** `memory_history` deliberately
   stores text — it is the content-preserving complement to the
   content-free audit log, a different table with a different fate:
   **forget scrubs history and keeps audit.** The split is the design,
   not an accident (I16).
4. **Time is bi-temporal and honest about which clock is which.** Every
   edge already records transaction time (`created` — when the library
   learned it). Validity adds world time (`valid_from`/`valid_until` —
   when it was true). The two never masquerade as each other.

## Schema (version 3)

```sql
-- Edges gain world-time validity. NULL valid_from = "since before anyone
-- recorded it"; NULL valid_until = "still true". Both NULL (the migration
-- default for every existing edge) = the honest reading of an undated fact.
ALTER TABLE edges ADD COLUMN valid_from  TEXT;  -- ISO-8601 UTC
ALTER TABLE edges ADD COLUMN valid_until TEXT;  -- ISO-8601 UTC
-- Enforced in the library (STRICT tables predate the columns; the write
-- choke points validate): valid_until > valid_from when both present;
-- strict ISO only (the quarantine reviewAt rule); system edge types carry
-- no validity at all (I15).

-- What a node used to say. Append-only; seq is 1-based and monotonic per
-- node. Rows store the PRE-mutation content — reading history(id) oldest-
-- first replays the node's life. Content-bearing BY DESIGN (see I16).
CREATE TABLE memory_history (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  title   TEXT NOT NULL,
  body    TEXT NOT NULL,
  props   TEXT NOT NULL,             -- JSON, same shape as nodes.props
  actor   TEXT NOT NULL CHECK (actor IN ('owner','agent','system')),
  action  TEXT NOT NULL,             -- the verb that took the snapshot
  origin  TEXT NOT NULL,             -- the change's provenance ('' = direct owner edit)
  at      TEXT NOT NULL,
  PRIMARY KEY (node_id, seq)
) STRICT;
```

Migration: `ALTER TABLE` twice, `CREATE TABLE` once, `schema_version → 3`.
Existing edges read as "undated, still true" — no backfill, no guessing.

## Part 1 — edge validity

### API

```ts
// link() gains an optional validity window (strict ISO; date-only accepted
// as midnight UTC — the reviewAt rule). Omitted = undated, still true.
link(source: NodeId, target: NodeId, type?: string, context?: string,
     validity?: { from?: string; until?: string }): Edge;

// The new verb: this fact stopped being true. Sets valid_until (default:
// the store clock's now), keeps the row, audits content-free. Refuses:
// system edge types (I15), an already-closed edge (loud, not idempotent —
// closing twice is a host bug worth hearing about), until <= valid_from.
closeEdge(id: EdgeId, until?: string): Edge;

// Time-travel on the edge-carrying reads. Omitted asOf = "currently valid"
// — the present is the default world. A closed edge (and a peer connected
// only by closed edges) drops out of the present and reappears under an
// asOf inside its window.
neighborhood(id: NodeId, asOf?: string): Node[];
entityContext(id: NodeId, limit?: number, asOf?: string): EntityContext;
```

The validity predicate, everywhere it applies:
`(valid_from IS NULL OR valid_from <= t) AND (valid_until IS NULL OR valid_until > t)`.

`Edge` (the type) gains `validFrom: string | null` and
`validUntil: string | null` — so the peer card's carried edges let a host
render "worked at Siemens **2021–2026**" without another query.

### Semantics, precisely

- **"Supersede" is composition, not a verb.** Ana's new job =
  `closeEdge(oldEdge)` + `link(ana, newCo, "works_at", "", { from })`. A
  compound `supersedeEdge()` was considered and rejected: closing a fact
  does not require a replacement (Ana might simply quit), and two audited
  primitives compose more honestly than one verb that sometimes half-runs.
  (Open question 1 offers the compound anyway if the owner wants it.)
- **System edge types are timeless (I15).** `on_day` (a point-in-time
  anchor), `supersedes`, `merged_into`, `derived_from` (lineage records),
  and above all `no_match` (a permanent verdict, I9) carry no validity and
  `closeEdge` refuses them — otherwise closing a `no_match` edge would
  reopen a question the owner answered, through the side door. Identity
  and lineage assertions are about the RECORD, not about the world;
  validity is for world-facts in host vocabulary.
- **The merge respects validity.** `decideIdentity`'s rewire moves
  validity columns with the edge (an edge is not an anonymous
  (source,target,type) triple — the hardening-2 lesson); on collision the
  survivor's OWN edge wins, its validity included.
- **Recall of nodes is unchanged.** Validity is an edge property; node
  recall (`recall`/`search`) already has its own recency model. The two
  compose at the peer card, not inside the ranking blend.
- **Forget composes.** Forgetting a node still drops all its edges,
  validity or not — destruction outranks history (I6).

## Part 2 — memory history

### API

```ts
interface HistorySnapshot {
  readonly seq: number;
  readonly title: string;
  readonly body: string;
  readonly props: Props;
  readonly actor: "owner" | "agent" | "system";
  readonly action: string;   // e.g. "node.update", "consent.approve_edited"
  readonly origin: string;   // the change's provenance ('' = direct owner edit)
  readonly at: string;
}

// Oldest-first: replaying the list is replaying the node's life. Readable
// for any existing node (id-gated like getNode — I2's strongest naming);
// a forgotten node's history is EMPTY, because forget scrubbed it (I16).
history(id: NodeId): HistorySnapshot[];
```

### Capture moments (exhaustive, v1)

A snapshot of the PRE-change content is appended exactly when node content
changes under owner authority:

| Moment | actor | action | origin |
|---|---|---|---|
| `updateNode` | owner | `node.update` | `''` |
| `decide` → `approve_edited` (proposal or parked edit) | owner | `consent.approve_edited` | `''` |
| `decide` → `approve` applying a parked-edit envelope | owner | `consent.edit_applied` | the envelope's origin |

Deliberately NOT capture moments: node birth (a creation is not a change),
status transitions and surfacing changes (metadata, already audited),
`touch` (usage), the merge (both nodes' content is preserved in place —
the husk IS the history), and `forget` (a snapshot at destruction time
would defeat destruction).

### The forget rule (I16 — the fix the field misses)

Every content-versioning mechanism in the survey keeps its snapshots
forever. Here, `forget(id)` deletes the node's `memory_history` rows in
the same cascade transaction that tombstones the node — a history table
that survives forgetting would make `forget` a lie. The content-free audit
rows survive, as they always did: *that* things happened remains provable;
*what* was said is gone. `ForgetReport` needs no new field — history is
fully reachable, so there is nothing to confess to `needsOwner`.

No undo verb in v1 — stated, not implied: history is read-only evidence.
Mechanical undo shares unmerge's ambiguity (the index, edges, and
downstream derivations have moved on); the owner restores deliberately via
`updateNode` with the snapshot open in front of them. Revisit with demand.

## Amendments to existing invariants

- **I6** — the forget cascade additionally deletes the node's
  `memory_history` rows (history is content).
- **I12** — `closeEdge` writes one audit row (edge id + flags, content-free).
  History snapshots do NOT write their own audit rows — they ride inside
  mutations that already audit; the history row itself is the record.

## New invariants

- **I15 — Validity is declared, never inferred.** `valid_from`/`valid_until`
  are set only from explicit arguments to `link`/`closeEdge`. The library
  never derives a validity date from content, context, clock heuristics, or
  any other source. System edge types (`on_day`, `supersedes`,
  `merged_into`, `no_match`, `derived_from`) carry NULL validity always,
  and `closeEdge` refuses them.
- **I16 — History dies with the tombstone.** `memory_history` rows are
  content: `forget(id)` removes every row for the node in the cascade
  transaction. Audit rows, being content-free, survive. No other verb may
  delete history (append-only otherwise).

## What stays out (and why)

- **LLM temporal extraction** — hosts may propose dated facts however they
  like; by the time the library sees a date it is an argument, not an
  inference (I15).
- **Node-level validity windows** — a node's lifecycle is the status FSM;
  adding a second time axis to nodes would create two competing lifecycle
  vocabularies. Nodes change via supersede chains and history; edges get
  windows. One mechanism each.
- **Re-opening a closed triple** — an edge's `(source, target, type)` is
  unique, so "left and later returned" cannot reuse the closed edge; since
  the perpetuity batch, `link` on a closed triple REFUSES loudly instead
  of silently returning the stale closed edge. Multi-interval validity
  (a history of windows per triple) is the honest future design if real
  use demands it — deferred, stated.
- **Edge history / edge versioning** — closing + relinking already
  preserves every state; versioning rows-about-rows adds a meta-level with
  no user question behind it.
- **Retention policies / history caps** — unbounded at personal scale;
  if a store measures a problem, the doctor reports it first (a future
  `historyRows` metric), and the owner decides. Reports, never acts.
- **Undo** — see above; read-only evidence in v1.

## Phases

| Phase | Delivers | Pins |
|---|---|---|
| **A — validity** | schema v3 migration (both structures land in one bump; history table sits unused until B), `link` validity param, `closeEdge` with the system-type refusal, the validity predicate in `neighborhood` + `entityContext` with `asOf`, Edge type gains the two fields | **I15**; the golden "Siemens years" scenario (close a job edge, open the next, `asOf` shows the old world, the present shows the new) |
| **B — history** | snapshot capture at the three moments, `history(id)`, the forget-cascade amendment | **I16**; scenario: edit twice → history replays; forget → history empty + audit survives |

Each phase lands with the standing discipline: unit tests + conformance
scenarios in the same PR, the verify loop green, SCHEMA.md updated in the
same change as the migration.

## Open questions for the owner (ratify before Phase A)

1. **`closeEdge` only, or also a compound `supersedeEdge`?** Design
   recommends the primitive alone — close + link compose, and not every
   ending has a successor. Say the word and Phase A adds the compound
   (ordered + audited like I5) anyway.
2. **Should `approve_superseding` stamp validity automatically?** When a
   node is superseded, the design does NOT auto-close its outgoing edges —
   node replacement and fact endings are different events (the archived
   "Lives in Brasov" node's edges say nothing about when the living
   stopped). Recommend: no auto-close; the owner closes facts explicitly.
   Confirm.
3. **History capture set** — the three moments in the table above, births
   excluded. Confirm, or name additional moments.
4. **`asOf` defaults** — `neighborhood`/`entityContext` default to
   "currently valid" (closed edges invisible in the present). This subtly
   changes traversal for hosts that start closing edges — the honest
   default, but it IS a default. Confirm.
5. **No undo verb in v1.** Confirm.
