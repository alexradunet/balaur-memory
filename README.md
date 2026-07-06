# balaur-memory

> **A consent-gated, lineage-tracked, forgettable memory layer for personal AI.**
> One SQLite file. One TypeScript library. No services, no models, no cloud.

`balaur-memory` is the memory layer of a personal life OS, designed from
[Balaur](https://github.com/alexradunet/balaur)'s memory layer and the
research behind it. It is the layer *above* storage — the part no existing
memory library ships:

- **Consent-gated writes** — an agent proposes; the owner decides. The
  proposal/adjudication queue is a data-layer contract, not prompt wording.
  Hosts render it however they like (cards, CLI, TUI).
- **Write-time adjudication** — duplicate and conflicting memories are
  routed at the moment of writing (create / merge-into-pending / no-op /
  supersede), not left for a model to untangle at recall time — the failure
  mode the benchmarks say matters most.
- **Provenance and lineage** — every memory knows where it came from; every
  derived artifact knows its sources. "Where did this come from?" and "what
  must change if this goes away?" are queries, not archaeology.
- **A real lifecycle** — supersede chains, surfacing policy
  (always / ask / never), quarantine for the painful cases, and true
  forgetting with honest cascade semantics. "Forgotten" never secretly means
  "suppressed".
- **Self-measurement** — a doctor computing quality signals from metadata it
  already keeps. It reports candidates; it never acts.
- **Recall as fusion** — FTS5 relevance × recency × importance ×
  reinforcement, optionally fused with cosine over **host-supplied**
  vectors. Brute-force and exact, because at personal scale that is
  milliseconds.

## The two contracts

1. **The schema** ([docs/SCHEMA.md](docs/SCHEMA.md)) — the durable,
   language-neutral contract: two SQLite files (`memory.db` the record,
   `index.db` the disposable sidecar), fourteen numbered invariants, opened
   by any tool, any language, for decades. This is where the 40-year bet
   lives.
2. **The TypeScript API** ([src/contract.ts](src/contract.ts)) — the
   reference implementation's surface: fully synchronous, zero runtime
   dependencies, `bun:sqlite` contained behind a one-file adapter
   ([ADR-0001](docs/adr/0001-bun-typescript.md)).

The library never calls a model. Hosts bring intelligence (and embeddings —
*vectors in, never models*); the library brings a deterministic, auditable
place for a life to land.

## Status

**Feature-complete core (v0.1).** All five phases are implemented and
verified — the spine, recall (blend + vector fusion), the consent gate
(AUDN routing, queue, four verdicts incl. supersede), lifecycle end-states
(quarantine, the honest forget cascade), lineage, and the metadata-only
doctor. `Store implements StoreContract` is compiler-checked; 13 of 14
schema invariants are pinned by the conformance suite (I14 by
construction) — every invariant with a possible producer has one. The
entity arc (ENTITIES.md) is complete: aliases, resolution, deterministic
identity questions, and owner-decided merges with no_match permanence. Balaur remains the design source
and keeps its own in-tree Go memory layer; the projects share lineage and
(optionally, later) a schema — not code.

## Docs

| Doc | What it holds |
|---|---|
| [docs/SCHEMA.md](docs/SCHEMA.md) | The data contract: DDL, semantics, invariants I1–I14 |
| [docs/DESIGN.md](docs/DESIGN.md) | Architecture: sync-first, vectors-in, ranking blend, module map |
| [docs/CODING.md](docs/CODING.md) | The rules: strict TS, zero deps, SQL discipline, tests |
| [docs/CONFORMANCE.md](docs/CONFORMANCE.md) | Scenario-file suite any implementation can run |
| [docs/MIGRATION.md](docs/MIGRATION.md) | Phase map and status |
| [docs/adr/](docs/adr/) | Decision records (0001: Bun + TypeScript) |

## License

AGPL-3.0-or-later, matching the parent project — with the library-adoption
tradeoff documented in [docs/DESIGN.md](docs/DESIGN.md#license).
