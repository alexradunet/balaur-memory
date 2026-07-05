# balaur-memory — design

The memory layer of a personal life OS, as a standalone TypeScript library on
Bun. This file records the architecture and decided tradeoffs. If code and
prose disagree, code wins and this file gets fixed. The durable contract
lives one level down, in [SCHEMA.md](SCHEMA.md) — this file describes the
reference implementation of it.

## The bet

Memory quality does not live in the storage engine. It lives in the write
path (adjudication), lineage, ranking, lifecycle, and consent — the layers
above storage. Storage stays deliberately boring (SQLite, two files), and
the *schema* — not this code — is the 40-year contract
([ADR-0001](adr/0001-bun-typescript.md)).

## Architecture

```
host app (a life-OS UI, a CLI, an agent runtime — hosts own models & pixels)
  │  renders the consent queue · embeds text into vectors · schedules jobs
  ▼
balaur-memory (this library — synchronous, deterministic, model-free)
  ├── spine      nodes + edges + status FSM + type registry + fan-out
  ├── consent    propose gate (I4) · pending queue · decide verbs (I5)
  ├── recall     FTS + ranking blend + vector fusion (vectors in, never models)
  ├── lineage    derived_from · staleness propagation
  ├── lifecycle  surfacing · quarantine · forget cascade (I6/I7)
  └── doctor     metadata-only health report (reports, never acts)
  ▼
memory.db (the record)          index.db (disposable — I13)
```

### Synchronous by design

`bun:sqlite` is synchronous, and at personal scale every operation is
sub-millisecond to low-millisecond. The library embraces this: **every API
is synchronous**. No promises, no callbacks, no internal concurrency, no
event emitters. The one thing that is genuinely async in a memory system —
embedding text with a model — is pushed out of the library entirely:

### Vectors in, never models

The library never calls a model and never holds an embedder. Hosts embed
content and queries themselves (async, outside, with whatever local model
they run) and hand in `Float32Array`s:

- `putVector(nodeId, model, vec)` — maintain the vector sidecar
- `recall(terms, { queryVector?, model? })` — fuse lexical bm25 with cosine
  over stored vectors of that model, reciprocal-rank style

No vector, no fusion — the lexical path alone is the deterministic default,
and it is not a degraded mode. Vector spaces are keyed by a host-declared
`model` identity; vectors from different identities never mix.

### Ranking blend (the deterministic core of recall)

```
score(node) = bm25 × recency × importanceBoost × reinforcement
  recency        = exp(-λ · daysSince(last_used ?? updated)),  λ dampened by importance
  importanceBoost= 1 + importance/5
  reinforcement  = 1 + 0.2·ln(1 + use_count)
```

(The implementation floors recency at 0.05 so a perfect lexical match is demoted by age, never erased.) With a query vector present: RRF fusion, `Σ 1/(60 + rank_i)` across the
lexical and cosine rankings. Constants live in one exported `RankingConfig`
with these defaults; hosts may tune, conformance pins the defaults.

### Storage adapter — the Bun containment seam

Only `src/storage/bun.ts` imports `bun:sqlite`. It implements a minimal
interface (`open`, `close`, `exec`, `prepare→{all,get,run}`, `transaction`)
consumed by everything else. Porting to `node:sqlite` or better-sqlite3 is
one file plus the conformance run.

### Concurrency & ownership

One `Store` instance is the single writer (I14); `memory.db` runs WAL so
external processes may read concurrently (a Go balaur mounting the file
read-only is the designed-for case). The library does not lock across
processes — hosts that want multi-process writers are out of scope by design.

### Errors and outcomes

Domain routing is **data, not exceptions**: `propose` returns an `Outcome`,
`decide` returns the resulting node, `forget` returns a `ForgetReport` with
a `needsOwner` list — expected forks in the road are return values.
Exceptions are for broken invariants and programmer error only: a single
`MemoryError extends Error` with a `code` literal union
(`"not_found" | "invalid_transition" | "type_unknown" | "props_invalid" |
"store_closed" | "conflict"`), so hosts can switch on `code` without string
matching.

### Module map

```
src/
  index.ts        public exports, version
  store.ts        Store: open/close, migrations, transactions (the façade)
  types.ts        domain types: branded ids, Status, Surfacing, Node, Edge, ...
  consent.ts      Proposal/Outcome/Pending/Decision + gate + queue + decide
  spine.ts        node/edge CRUD, FSM, type registry, write fan-out
  recall.ts       terms, blend, fusion, search
  lineage.ts      derivations, staleness
  lifecycle.ts    surfacing, quarantine, forget cascade
  doctor.ts       the report
  storage/
    adapter.ts    the minimal SQL interface (the seam)
    bun.ts        bun:sqlite implementation — the ONLY file importing it
    schema.ts     DDL from SCHEMA.md + the migration runner
    ulid.ts       zero-dep lowercase ULID
  indexdb/
    fts.ts        FTS maintenance + rebuild (I13)
    vectors.ts    Float32Array codec, cosine, RRF
```

### Performance envelope (why no ANN, no graph engine)

At the design ceiling of 100k nodes: brute-force cosine over 10k vectors ×
768 dims is ~8M multiply-adds — well under 50 ms in Bun with typed arrays,
and typical stores are 10× smaller. FTS5 handles lexical at any personal
scale. 1-hop traversals are indexed lookups. If a measured workload ever
breaks this, the answer is a benchmark first and an index second — never a
new database.

## Non-goals

- No server, daemon, scheduler, or network I/O of any kind.
- No model calls, no embedder interface — vectors in, never models.
- No multi-tenant, no multi-process writers, no sync protocol (a future
  layer may add sync ON TOP of the schema; the library stays local).
- No ORM, no query builder, no runtime dependencies. SQL is written by hand
  next to the code that owns each table.
- No opaque state: both files open in any SQLite tool.

## License

AGPL-3.0-or-later, matching the parent project, while the sole author
retains trivial relicensing freedom. Decide deliberately before accepting
external contributions (library copyleft reaches consumers; Apache-2.0 is
the conventional adoption-maximizing switch and must happen while the
contributor set can consent).
