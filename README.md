# balaur-memory

> **A consent-gated, lineage-tracked, forgettable memory layer for personal AI.**
> One SQLite file. One TypeScript library. No services, no models, no cloud.

`balaur-memory` is the memory layer of a personal life OS — standalone,
host-agnostic, born from dedicated research into how a life's knowledge
should be stored, surfaced, and forgotten. It is the layer *above* storage —
the part no existing memory library ships:

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
   `index.db` the disposable sidecar), seventeen numbered invariants, opened
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

**Feature-complete core.** All five phases are implemented and
verified — the spine, recall (blend + vector fusion), the consent gate
(AUDN routing, queue, four verdicts incl. supersede), lifecycle end-states
(quarantine, the honest forget cascade), lineage, and the metadata-only
doctor. `Store implements StoreContract` is compiler-checked; 13 of 14
schema invariants are pinned by the conformance suite (I14 by
construction) — every invariant with a possible producer has one. The
entity arc (ENTITIES.md) is complete, all four phases: aliases,
resolution, deterministic identity questions, owner-decided merges with
no_match permanence, and the bounded `entityContext` peer card for host
prompts. The temporal arc (TEMPORAL.md) is complete too: declared
edge-validity windows with `asOf` time travel ("this was true, and then
it stopped" — dates in, never models), and owner-mutation memory history
that dies with the tombstone. And the planning arc (PLANNING.md): a task
is still a memory — `when_at` appointments, the `agenda` window, the
doctor's due lens, and day anchors make nodes that happen to be tasks,
events, and reminders first-class, with zero planning-specific machinery
and no scheduler, ever. The library is fully standalone — no parent
application, no host commitments: any host, present or future, builds on
the schema contract and the TypeScript API.

## Docs

| Doc | What it holds |
|---|---|
| [docs/SCHEMA.md](docs/SCHEMA.md) | The data contract: DDL, semantics, invariants I1–I14 |
| [docs/DESIGN.md](docs/DESIGN.md) | Architecture: sync-first, vectors-in, ranking blend, module map |
| [docs/CODING.md](docs/CODING.md) | The rules: strict TS, zero deps, SQL discipline, tests |
| [docs/CONFORMANCE.md](docs/CONFORMANCE.md) | Scenario-file suite any implementation can run |
| [docs/FIELD.md](docs/FIELD.md) | The 2026 landscape survey: where this library stands, the steal ledger |
| [docs/HISTORY.md](docs/HISTORY.md) | How the library was built — the phase log |
| [docs/adr/](docs/adr/) | Decision records (0001: Bun + TypeScript) |

## License

AGPL-3.0-or-later — with the library-adoption tradeoff documented in
[docs/DESIGN.md](docs/DESIGN.md#license).
