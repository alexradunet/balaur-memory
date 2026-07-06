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
  (`registerType, createNode, propose, proposeEdit, decide, link, recall,
  search, touch, transition, setSurfacing, quarantine, forget,
  recordDerivation, putVector, rebuildIndex, deleteIndexDb`).
- `as` binds returned ids/outcomes to names later steps and expectations
  reference.
- `expect` entries are either bound-value assertions or **raw SQL against
  memory.db** — the contract is the database, so the assertions read the
  database.
- `clock` (plus optional per-step `advance`) makes time-dependent behavior
  (recency decay, review_at, staleness) deterministic.

## Coverage map (feature-complete, v0.1)

| Scenario | Invariants pinned |
|---|---|
| `I1-owner-writes-born-active` | I1 (owner half), I10 |
| `golden-I1-consent-boundary` | I1 (both halves), I10, hint kinds |
| `I2-recall-surfacing` | I2 (always/ask/never across recall) |
| `I3-neighborhood-active-only` | I3 |
| `golden-I4-audn-gate` | I4 (created / merged_pending / exists_active) |
| `golden-I5-supersede` | I5 + the I2 composition (superseded leaves ambient recall) |
| `I6-forget-cascade` | I6, I7 (content-free log probe), I8 (post-forget terminality) |
| `I8-fsm-terminality-and-guards` | I8 (guarded targets) |
| `I11-ids-and-timestamps` | I11 |
| `I12-audit-coverage` | I12, I7 |
| `I13-index-disposability` | I13 (delete → reopen → rebuild → identical recall) |

Thirteen of fourteen invariants are scenario-pinned. The remaining one:

- **I14 (single writer)** — by construction, not by scenario: one Store
  instance owns writes, WAL permits external readers. A conformance test
  cannot prove host discipline; the invariant documents it.

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
