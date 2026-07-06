# HISTORY.md — how this library was built

The build log: what landed, in what order, behind which PR. The library is
standalone — no parent application, no host commitments. Everything below
is its own history.

**The standing discipline:** every phase is designed against the schema
contract (SCHEMA.md) first; lands with unit tests + conformance scenarios
in the same PR; passes `bun test` + `tsc --noEmit` (strict) + `biome`
before push; and updates its docs in the same change. The merge is the
ratification.

## Phase log

| Phase | Delivered | State |
|---|---|---|
| 0 — Go scaffold | a Go contract draft | superseded by 0.5 (ADR-0001) |
| 0.5 — language pivot + full design | ADR-0001 (Bun/TS + the guardrails), SCHEMA.md (invariants I1–I14), DESIGN.md, CODING.md, CONFORMANCE.md, the TS contract | DONE (PR #2) |
| 1 — the spine | storage adapter + migrations + ulid; nodes/edges CRUD, the status FSM, the type registry, write fan-out (FTS, on_day, audit), provenance at birth (I10) | DONE (PR #3) |
| 2 — recall | FTS maintenance + rebuild (I13), term helpers, the ranking blend with pinned defaults, vector storage + cosine + RRF fusion | DONE (PR #4) |
| 3 — the consent gate | propose with the write-time AUDN gate (I4), the pending queue + conflict hints, decide incl. approve_superseding (I5), edit envelopes, the golden personal fixtures | DONE (PR #5) |
| 4 — lifecycle | quarantine + review_at, the honest forget cascade + needsOwner (I6/I7), terminality (I8) | DONE (PR #6) |
| 5 — lineage + doctor | derivations + staleness; the metadata-only health report | DONE (PR #7) |
| hardening — cold-review fix batch | consent-surface privacy seals, corrupt-index recovery, the guard set, parseProps, the audit-leak sentinel | DONE (PR #8) |
| entities — design doc | ENTITIES.md: consent-gated identity resolution | DONE (PR #9) |
| entities A — names | schema v2 (aliases + identity_pending), addAlias/removeAlias/aliasesOf, resolveRef, survivorOf, alias FTS indexing + forget amendments | DONE (PR #10) |
| entities B — questions | deterministic rules R1–R3, suggestIdentities, the Pending tagged union (v0.2.0) | DONE (PR #11) |
| entities C — verdicts | decideIdentity: the compound merge + no_match permanence (I9, both halves), merged joins the forgettable set (I8) | DONE (PR #12) |
| entities D — the peer card | entityContext: the bounded, edge-carrying disambiguation primitive | DONE (PR #13) |
| standalone | every parent-app reference removed; MIGRATION.md → HISTORY.md | DONE (PR #14) |
| hardening 2 — cold-review fix batch | 12 findings: no_match transplant (I9), neighborhood surfacing (I2/I3), consent schema enforcement, merge self-loops, forget completeness, I13 byte-exactness, monotonic ULIDs, doc reconciliations | DONE (PR #15, merged; tagged v0.2.3) |
| temporal — design doc (TEMPORAL.md) | bi-temporal edge validity + forget-aware memory history; I15/I16 | DONE (PR #16, merged) |
| temporal A — validity | schema v3, link validity windows, closeEdge (I15), asOf time travel on traversal + the peer card | DONE (PR #17, merged) |
| temporal B — history | the three capture moments, history(id), the forget-cascade amendment (I16) | DONE (PR #18, merged) |
| planning — design doc (PLANNING.md) | when_at, agenda, dueCandidates, dayAnchor; tasks as memories; I17 | DONE (PR #19, merged) |
| planning A — the appointment | schema v4, when through the write paths, agenda, the due lens, dayAnchor (I17) | DONE (PR #20, merged; tagged v0.4.0) |
| field survey (FIELD.md) | the 2026 landscape, where we lead, the steal ledger, positioning | DONE (PR #21, merged) |
| hardening 3 — the perpetuity batch | forget clears when_at (I6), closed-triple loud refusal, the future-file guard, day reserved, backup() via VACUUM INTO, doctor integrityOk | DONE (PR #22, merged) |
| ergonomics — the life-layer batch | propsPatch, episode window, children dashboard read, the owner fast path on gated types | DONE (PR #24, merged; #23 superseded) |
| hosting guide (HOSTING.md) | the ten probe-validated life patterns, capture vocabulary, the daily tick, backup procedure | DONE (PR #25, merged) |
| publishability — Bun-only | exports map to raw TS (no build, by design), files allowlist, engines pin; INTEGRATIONS.md sketch (MCP + pi.dev + skills over process boundaries) | in review (PR #26) |

13 of 14 invariants are conformance-pinned (I14, single writer, holds by
construction). `Store implements StoreContract` is compiler-checked.

## Deliberately out of scope

- **Agent-tool wrappers** (`remember`/`recall` tool shapes) — host glue.
- **Recap/summary generation** — model work; only lineage lands here
  (vectors in, never models).
- **Caching layers** — optimizations to re-earn with a benchmark if a
  measured workload ever demands one.
- **Sync/multi-device** — a future layer on top of the schema, never
  inside the library.

## What's next

A host application, built from scratch on this library — and nothing here
depends on it existing. The schema contract (SCHEMA.md) is what keeps
every future direction cheap: any process, any language, any decade can
open `memory.db` and be told the truth.
