# FIELD.md — the memory-layer landscape, and where this library stands

A distilled competitive survey of memory layers for personal AI, biased
toward local-first and privacy-preserving systems. **Snapshot:
2026-07-06, against balaur-memory v0.4.0.** Figures (stars, activity,
licenses) were live-pulled from the GitHub API and primary sources on the
snapshot date; benchmark numbers are the vendors' own and are flagged as
such. Apple's on-device personal-context store is the one notable system
with no public technical documentation — noted honestly rather than
speculated about.

## The landscape

| System | Local story | Memory ops | Forgetting | Consent | License · momentum |
|---|---|---|---|---|---|
| [Mem0](https://github.com/mem0ai/mem0) | embedded lib, but self-hosted = Docker+Postgres+Qdrant; always needs an LLM | v3 (2026) is **ADD-only** — UPDATE/DELETE removed from the pipeline | `delete()` exists; no cascade or tombstone semantics | none — agent writes land directly | Apache-2.0 · 60K★, very active |
| [Zep / Graphiti](https://github.com/getzep/graphiti) | **no embedded option** — requires Neo4j/FalkorDB/Neptune (embedded Kuzu deprecated 2026: got *less* local this year) | LLM extraction; bi-temporal edges (`valid_at`/`invalid_at`), the field's reference temporal model | **cannot delete a fact** — only invalidate edges; nodes persist forever | none | Apache-2.0 · 28K★, very active |
| [Letta (MemGPT)](https://github.com/letta-ai/letta) | SQLite fallback, Postgres default; active dev moved to letta-code | self-editing memory blocks; `BlockHistory` = actor-attributed content versioning with undo | overwrite + undo; no tombstone/cascade primitive | none — the agent's tool call IS the write | Apache-2.0 · 24K★ + new repo |
| [LangMem](https://github.com/langchain-ai/langmem) | no storage of its own (delegates to LangGraph BaseStore) | semantic/episodic/procedural taxonomy; hot-path vs background formation | `enable_deletes` flag; no cascade | none | MIT · 1.5K★, steady |
| [cognee](https://github.com/topoteretes/cognee) | embedded for dev, Postgres for prod — but "local mode" still requires an LLM API key | ECL pipeline; remember/recall/forget/improve verbs | `forget()` is **dataset-granularity** — no per-memory forget | none | Apache-2.0 · 27K★, very active |
| [txtai](https://github.com/neuml/txtai) | fully embedded, SQLite-native | not a memory model — an embeddings/search index | SQL DELETE | n/a | Apache-2.0 · 13K★, mature/stable |
| [basic-memory](https://github.com/basicmachines-co/basic-memory) | genuinely local-first: Markdown as truth + disposable SQLite index | no pipeline — humans/LLMs write structured Markdown via MCP | bare file delete; no cascade, no honesty report | **none** — agents can delete notes with zero review | AGPL-3.0 · 3.4K★, active |
| [Khoj](https://github.com/khoj-ai/khoj) / [Reor](https://github.com/reorproject/reor) | Khoj: local *inference*, Postgres-required storage; Reor: truly on-device but stale since mid-2025 | RAG over notes; no memory ops | standard delete | none | AGPL-3.0 |
| [MemOS](https://github.com/MemTensor/MemOS) / [A-MEM](https://github.com/agiresearch/A-mem) / [HippoRAG 2](https://github.com/OSU-NLP-Group/HippoRAG) | research-grade local | memory scheduling / Zettelkasten auto-evolution / PPR retrieval | none | **A-MEM is the anti-pattern**: the LLM autonomously rewrites *other* memories' text; nothing asks | Apache/MIT |
| [sqlite-vec](https://github.com/asg017/sqlite-vec) + the 2026 micro-ecosystem | fully embedded | 15+ repos (mostly created 2026, several pushed daily) building SQLite+FTS5 agent memory | rare | one prior-art find: [minni](https://github.com/infektyd/minni) (2★) has propose→approve — but the gate is **delegable to an auto-consolidation pass** | mostly MIT/Apache |

Two systems out of category but worth naming: **Second-Me** (memory baked
into LoRA weights — not a queryable store; stale) and **memobase**
(LLM-built user *profiles*, not memory nodes; Postgres+Redis; quiet).

## Where this library leads (verified, not aspirational)

1. **Consent as a non-delegable data-layer invariant.** Every system
   surveyed writes (or self-edits) unconditionally. The single piece of
   prior art (minni, 2★) makes approval a configurable default an
   automated pass can assume. Here, agents can only `propose()` — the
   gate is the schema (I1/I4), not a setting.
2. **True per-memory forgetting with an honesty report.** Mem0's delete
   has no cascade; Graphiti cannot destroy a fact at all; cognee forgets
   whole datasets; basic-memory deletes files blind. Nothing else in the
   survey has `ForgetReport.needsOwner` — an honest account of what a
   forget could NOT reach (prose mentions, merged husks, prior exports).
3. **Candidates, never a winner — with permanence.** Graphiti dedupes
   entities via LLM automatically; A-MEM rewrites neighbors silently. No
   surveyed system has the anti-Apple-Photos rule: a `no_match` verdict
   that is never re-asked (I9) and cannot be reopened through any side
   door (I15's closeEdge refusal).
4. **Storage consent ≠ usage consent.** No surveyed system separates "may
   this be stored" from "may this be surfaced." The `always`/`ask`/`never`
   axis (I2), enforced across recall, hints, resolution, traversal, peer
   cards, and the agenda, has no counterpart anywhere.
5. **Content-free audit by construction (I7/I12).** Every history/audit
   mechanism found elsewhere stores content snapshots in its trail. Here
   the audit log carries ids/counts/flags only — pinned by a structural
   sentinel test — while content history is a separate, forgettable table
   with the opposite fate under `forget` (I16).
6. **A full memory model at zero model calls.** Every comparable system
   requires an LLM somewhere in its write or read path. The only zero-LLM
   systems found (txtai, sqlite-vec) are search infrastructure with no
   memory model. This is the only surveyed system that is both a complete
   memory model (consent, FSM, importance, lineage, identity, time,
   planning) and callable with zero network access and zero models.

## The steal ledger (decisions as of v0.4.0)

| Mechanism | Source | Decision | Where it landed |
|---|---|---|---|
| Bi-temporal edge validity; invalidate, don't delete | Zep/Graphiti | **ADOPTED — fixed**: dates declared, never LLM-inferred | TEMPORAL.md Phase A (PR #17), I15 |
| Actor-attributed content versioning with replay | Letta `BlockHistory` | **ADOPTED — fixed**: history dies with the tombstone | TEMPORAL.md Phase B (PR #18), I16 |
| Additive-by-default when update-vs-new is ambiguous | Mem0 | **ALREADY COVERED** — the AUDN gate creates fresh proposals rather than silently overwriting; never-covered duplicates become new cards | consent.ts (I4) |
| `redact` / `log-only` verdict outcomes | minni | **ALREADY COVERED** — `approve_edited` expresses redaction; `reject` records acknowledgment without storing | consent.ts (I5) |
| Observations/Relations prose grammar for entity content | basic-memory | **DEFERRED** to a host-integration guide — a content convention, not a schema change | future HOSTING doc |
| Episode schema (observation/thoughts/action/result) | LangMem | **DEFERRED** to the same guide — names a good shape for episodic memories | future HOSTING doc |
| `improve()` post-hoc self-correction | cognee | **REJECTED as a verb** — auto-acting conflicts with "reports, never acts"; at most a future doctor metric (reproposal-after-forget rate) | — |
| Hot-path vs background formation framing | LangMem | **COVERED in positioning** — this library is deliberately hot-path-only, for determinism | DESIGN.md doctrine |
| SQLite content store + disposable sidecar | txtai | **CITED as precedent** — external validation of the two-file split, proven over years at scale | the architecture itself |
| LLM temporal extraction hallucinating "today" (~56% on backfills, their issue tracker) | Graphiti | **CITED as the cautionary tale** — the empirical case for I15/I17: *dates in, never models* | TEMPORAL.md, PLANNING.md |

The planning arc (PLANNING.md, I17) came from the owner's own thesis — *a
task is still a memory* — not from the survey; the survey's contribution
was confirming nobody else's memory layer has a consent-gated appointment.

## Positioning

The AI-memory field in 2026 has converged hard on one axis — LLM-driven
extraction pipelines that write memory automatically and get judged on
LoCoMo/LongMemEval leaderboards — while quietly ignoring a second axis
almost entirely: whether the human who owns the memory ever gets asked.
Mem0 accumulates facts unconditionally; Graphiti invalidates but can never
truly delete; cognee, Letta, and A-MEM let agents rewrite their own or
each other's memories with no review step; and the one credible
propose-then-approve gate in the wild lets that gate be silently delegated
back to an automated pass. balaur-memory is the only system in this survey
that treats consent as a data-layer contract rather than a
prompt-engineering aspiration: agents can only propose, every write is
born either owner-authored-and-active or agent-proposed-and-queued, time
enters only as owner-declared fact, and forgetting is a real cascade that
honestly reports what it couldn't reach — all fully synchronous, with zero
runtime dependencies, never calling a model. In a landscape racing toward
bigger extraction pipelines and flashier benchmark deltas, this library
bets that the things nobody else is building — an inescapable human
decision point, and memory that can actually die — are the ones that
matter when the memory in question is a real person's.

## Maintenance

This is a snapshot, not a living scoreboard. Re-survey when: a major
system ships a consent gate or per-memory forgetting; the SQLite
micro-ecosystem consolidates around a winner; or a positioning claim above
is about to be made in public and is more than ~6 months old.
