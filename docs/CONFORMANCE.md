# CONFORMANCE.md — proving an implementation honors the contract

The conformance suite tests the **schema contract** (SCHEMA.md), not this
codebase's internals. Any implementation — this TypeScript one, a future
Node port, a Go reader — passes the same suite or it is not balaur-memory.

## Shape

`test/conformance/*.scenario.json` — declarative scenarios executed by a
thin runner (`test/conformance/runner.test.ts` here; ~150 lines any language
can reimplement):

```jsonc
{
  "name": "I4-dedup-gate-routes-duplicate-title",
  "invariants": ["I4"],           // SCHEMA.md invariant numbers this pins
  "clock": "2026-07-05T12:00:00.000Z",
  "steps": [
    { "op": "registerType", "name": "memory", "bornStatus": "proposed" },
    { "op": "propose", "as": "p1",
      "proposal": { "type": "memory", "title": "Lives in Brasov",
                     "body": "Moved 2019", "importance": 4,
                     "origin": "turn:t1" } },
    { "op": "decide", "ref": "p1", "decision": { "kind": "approve" } },
    { "op": "propose", "as": "p2",
      "proposal": { "type": "memory", "title": "lives in  BRASOV",
                     "body": "dup", "importance": 3, "origin": "turn:t2" } }
  ],
  "expect": [
    { "outcome": "p2", "equals": "exists_active" },
    { "sql": "SELECT COUNT(*) FROM nodes WHERE status='proposed'", "equals": 0 },
    { "sql": "SELECT COUNT(*) FROM nodes WHERE status='active'",  "equals": 1 }
  ]
}
```

- `steps` use a small op vocabulary mapping 1:1 to the public API
  (`registerType, createNode, updateNode, link, closeEdge, transition,
  touch, setSurfacing, propose, proposeEdit, decide, addAlias,
  suggestIdentities, decideIdentity, putVector, quarantine, forget,
  recordDerivation, rebuildIndex, reopenWithoutIndex`). `link` takes an
  optional edge `type`, `context`, and `validity` window, and binds its
  Edge via `as` (so `closeEdge` can reference `@e.id`); `registerType`
  takes an optional `propsSchema`; a step with `expectError` asserts the
  op throws.
- `as` binds returned nodes/outcomes/reports to names later steps and
  expectations reference (`@name` / `@name.id`).
- `expect` entries assert bound values (`bound`), ranked reads (`recall`,
  `entityContext`), gate outcomes (`outcome`), hint sets (`conflicts`),
  forget reports (`report`), traversals (`neighborhood`) — or **raw SQL
  against memory.db / index.db** (`sql` / `sqlIndex`): the contract is the
  database, so the assertions read the database. `neighborhood` and
  `entityContext` take an optional `asOf` (TEMPORAL.md time travel);
  `history` asserts snapshot replays (length / bodiesInOrder / actions /
  origins).
- `clock` (plus optional per-step `advanceMs`) makes time-dependent
  behavior (recency decay, review_at, staleness) deterministic.

## Coverage map

| Scenario | Invariants pinned |
|---|---|
| `I1-owner-writes-born-active` | I1 (owner half), I10 |
| `golden-I1-consent-boundary` | I1 (both halves), I10, hint kinds |
| `I2-recall-surfacing` | I2 (always/ask/never across recall) |
| `I2-consent-surfaces` | I2 on the gate + hints (no exists_active oracle for `never`) |
| `I3-neighborhood-active-only` | I3 + I2 on traversal (never/day excluded, ask included) |
| `golden-I4-audn-gate` | I4 (created / merged_pending / exists_active) |
| `golden-I5-supersede` | I5 + the I2 composition (superseded leaves ambient recall) |
| `I6-forget-cascade` | I6 incl. identity_pending completeness, I7 (content-free log probe), I8 |
| `I8-fsm-terminality-and-guards` | I8 (guarded targets) |
| `I9-apple-photos` | I9, both halves: never re-proposed; merge refused either order |
| `I11-ids-and-timestamps` | I11 |
| `I12-audit-coverage` | I12, I7 |
| `I13-index-disposability` | I13 (delete → reopen → rebuild → identical recall, byte-exact `extra`) |
| `entities-questions` | R1–R3 evidence priority, exclusions, idempotent re-runs (I2) |
| `golden-two-anas-merge` | the compound merge: rewire/fold/chain/husk, I7 through it, I2 recall |
| `entity-context-peer-card` | the bounded peer card: I2/I3 filtering, recency order, edges included |
| `merge-adversarial-edges` | **I9 under merge**: no_match never transplants; self-loops die; chains flatten |
| `consent-schema-enforcement` | the decide path coerces + validates props against the type schema (I5) |
| `update-node` | retitle reconciles a now-equal alias; props replace wholesale; audited (I12) |
| `temporal-siemens-years` | **I15**: declared validity, closeEdge + system-type refusals, asOf time travel |
| `I16-history-forget` | **I16**: the three capture moments replayed; history dies with the tombstone; audit survives |

Fifteen of sixteen invariants are scenario-pinned. The remaining one:

- **I14 (single writer)** — by construction, not by scenario: one Store
  instance owns writes, WAL permits external readers. A conformance test
  cannot prove host discipline; the invariant documents it.

Every invariant with a possible producer has one.

The `doctor()` report is covered by unit tests (`src/doctor.test.ts`)
rather than scenarios — it reads state and never mutates, so there is no
invariant to pin, only math and wording to keep honest.

## Rules

- A behavior change without its scenario change in the same commit is wrong
  by definition — reviewers reject it.
- Scenario files never contain real personal data; fixtures are fictional.
- The runner may not import from `src/` internals — public API + raw SQLite
  reads only. That is what keeps the suite portable to other
  implementations.
