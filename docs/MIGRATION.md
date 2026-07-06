# Migration map — Balaur → balaur-memory, piece by piece

Source of truth for what gets built, in what order, and what deliberately
stays behind. Each phase lands with its tests + conformance scenarios and
updates the status table below. The parent is
`github.com/alexradunet/balaur`; its memory layer (`internal/nodes`,
`internal/knowledge`, `internal/search`, plans 259–267, and the
`docs/superpowers/` research) is the *design source*, not a code source.

**Discipline (post-ADR-0001):** phases are TypeScript implementations of
the schema contract, **informed by** Balaur's Go code and its tests — never
mechanical ports. Balaur's golden-recall design (plan 261) enters as
conformance scenarios in Phase 3. Balaur itself keeps its in-tree Go layer,
which plans 259–267 continue to improve independently — the two projects
share a *design lineage* and, eventually, optionally, a *schema*, not code.

## Phase 0 — Go contract scaffold ✅ (superseded by 0.5)

## Phase 0.5 — language pivot + full design ✅ this PR

ADR-0001 (Bun/TS + guardrails), SCHEMA.md (the durable contract, invariants
I1–I14), DESIGN.md (sync-first, vectors-in-never-models), CODING.md,
CONFORMANCE.md, TS contract (`src/types.ts`, `src/consent.ts`,
`src/contract.ts`), Bun toolchain + CI. Go files removed.

## Phase 1 — the spine

`storage/` (adapter + bun impl + schema migrations + ulid), `spine.ts`:
nodes/edges CRUD, status FSM, type registry with props validation, write
fan-out (FTS upsert, on_day, audit), provenance-at-birth (I10). First
conformance scenarios: I1, I3, I8, I11, I12.

## Phase 2 — recall

`indexdb/fts.ts` + `indexdb/vectors.ts` + `recall.ts`: FTS maintenance +
rebuild (I13), term helpers (stopwords, proper nouns — balaur plan 260's
design), the ranking blend with pinned `RankingConfig` defaults, vector
fusion from stored vectors. Scenarios: I2, I13.

## Phase 3 — the consent gate

`consent.ts`: propose gate (I4), pending queue with conflict hints, decide
verbs including approve-superseding (I5), pending-edit envelopes. The
golden-recall personal fixture set lands as scenarios here (plan 261's
design, upgraded to conformance format).

## Phase 4 — lifecycle

`lifecycle.ts`: surfacing enforcement across every read path, quarantine
with `review_at`, the forget cascade + `ForgetReport.needsOwner` honesty
(I6, I7), terminality (I8), no_match permanence (I9).

## Phase 5 — lineage + doctor

`lineage.ts` (derivations, staleness propagation) and `doctor.ts`
(metadata-only report: acceptance rates, dead-weight/stale/duplicate
candidates, queue age — phrased as candidates, never actions).

## Phase 6 — interop, not import (reframed by ADR-0001)

Balaur does not import this library. Options that stay open by design:
- balaur (Go) mounts `memory.db` read-only over the schema contract (WAL,
  I14) for recall experiments;
- a future host app is built directly on this library;
- nothing — the projects coexist, sharing research and design.
No commitment is made here; the schema contract is what keeps every option
cheap.

## Deliberately not building

- Agent-tool wrappers (`remember`/`recall` tool shapes) — host glue.
- Recap/summary *generation* — model work; only lineage lands here.
- Balaur's knowledge context cache — an optimization to re-earn with a
  benchmark if ever needed.
- Sync/multi-device — a future layer on top of the schema, never inside the
  library.

## Status

| Phase | State |
|---|---|
| 0 Go contract | superseded 2026-07-05 |
| 0.5 pivot + design | DONE (PR #2, merged) |
| 1 spine | DONE (PR #3, merged) |
| 2 recall | DONE (PR #4, merged) |
| 3 consent gate | DONE (PR #5, merged) |
| 4 lifecycle | DONE (PR #6, merged) |
| 5 doctor | DONE (PR #7, merged) |
| hardening — review fix batch | DONE (PR #8, merged) |
| entities design doc (ENTITIES.md) | DONE (PR #9, merged) |
| entities A — names | DONE (PR #10, merged) |
| entities B — questions (v0.2.0) | DONE (PR #11, merged) |
| entities C — verdicts, I9 | DONE (PR #12, merged) |
| entities D — the peer card | in review (PR #13) |
| 6 interop | open by design |
