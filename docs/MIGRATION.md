# Migration map — Balaur → balaur-memory, piece by piece

Source of truth for what moves, in what order, and what deliberately stays
behind. Each phase lands with its tests and updates this file's status line.
The parent repo is `github.com/alexradunet/balaur` (its memory layer:
`internal/nodes`, `internal/knowledge`, `internal/search`, plus plans
259–267 and the `docs/superpowers/` research this design is built on).

**Migration discipline:** phases are redesigns informed by Balaur's code,
not mechanical ports — Balaur's versions carry `app.App` wiring, PocketBase-
era naming, and UI assumptions that must not cross. Behavior parity is
proven by porting the relevant tests alongside, and Balaur's golden recall
harness (plan 261) becomes this library's conformance suite in Phase 3.

## Phase 0 — contract (this repo, now)  ✅ scaffolded

Draft API (`contract.go`, `types.go`, `consent.go`), design + this map, CI.
Breaking the draft is free until Phase 1 ships; criticize it hard now.

## Phase 1 — the spine

From `internal/nodes` (nodes.go, schema.go, types.go, links.go, query.go,
day.go) + `internal/store` (audit.go, scan/time helpers):
- nodes + edges tables, status FSM, type registry with templates/validation
- write choke points with fan-out (index upsert, on_day, wikilinks)
- content-free audit sink (the forget-compatible discipline from day one)
- `Provenance` recorded at create time (the parent's plan-227 lesson:
  retrofitting provenance is the expensive path — new code writes it always)

Replaces the `Store` interface with the concrete type. Port the nodes tests.

## Phase 2 — recall

From `internal/search` (index.go) + `internal/knowledge` (search.go,
context-cache lessons):
- disposable `index.db` FTS5 sidecar, rebuild-from-source, upsert/delete
- ranking blend: bm25 × recency-decay × importance × log(1+use_count)
  (parent plan 260/A2 math; reinforcement dampens decay)
- term-extraction helpers (stopwords, proper nouns, carryover) as OPTIONAL
  utilities — hosts may bring their own query terms

## Phase 3 — the consent gate

From `internal/knowledge` (knowledge.go, edit.go) + parent plans 262/263:
- Propose with the write-time adjudication gate (created / merged_pending /
  exists_active), conflict hints, pending-edit envelopes
- Decide verbs incl. approve-superseding (compound commit + `supersedes`
  edge)
- golden conformance suite lands here (port + extend plan 261 fixtures)

## Phase 4 — lifecycle

New, library-first (parent research: forgetting + surfacing tracks):
- surfacing axis enforcement in every read path
- quarantine with review dates
- `Forget` cascade + `ForgetReport` (tombstones, index scrub, stale flags,
  NeedsOwner honesty)

## Phase 5 — lineage + doctor

New, library-first (parent research: lineage + self-measurement tracks):
- `derived_from` lineage (`RecordDerivation`, `StaleDerivations`)
- `Doctor` metadata-only report (decision rates, dead-weight/stale/duplicate
  candidates, queue age) — trailing-baseline framing is the host's job

## Phase 6 — Balaur consumes

Balaur swaps `internal/nodes` + `internal/knowledge` + `internal/search`
for this module behind its golden harness; in-tree copies are deleted the
same day parity is green. Balaur keeps (not library concerns): cards/UI,
turn pipeline, context assembly policy, recap generation, reflection and
briefing jobs, heads, extensions.

## Deliberately not migrating

- `remember`/`recall`/`search` agent-tool wrappers — tool surfaces are host
  glue.
- Recap/summary GENERATION — model calls; only their lineage lands here.
- The knowledge context cache — an optimization to re-earn with a benchmark,
  not to inherit.
- Two-driver split (modernc + ncruces) — this library standardizes on
  ncruces for both files.

## Status

| Phase | State |
|---|---|
| 0 contract | scaffolded 2026-07-05 |
| 1 spine | not started |
| 2 recall | not started |
| 3 consent gate | not started |
| 4 lifecycle | not started |
| 5 lineage + doctor | not started |
| 6 balaur consumes | not started |
