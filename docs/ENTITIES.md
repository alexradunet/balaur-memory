# ENTITIES.md — consent-gated identity resolution (design)

- **Status:** ARC COMPLETE — all four phases. Phase A (names, PR #10),
  Phase B (questions + the Pending union, PR #11), Phase C (verdicts + I9,
  PR #12), Phase D (the peer card, PR #13, v0.2.2). Owner confirmed the
  three open questions.
- **Pins:** I9 (`no_match` permanence) finally gets its producer. Ships as
  **schema_version 2** and **v0.2.0** (one deliberate breaking change:
  `Pending` becomes a tagged union).
- **Research basis:** the Kinship brief (entity resolution for personal
  knowledge graphs): Fellegi–Sunter blocking with the auto-merge zone
  deleted; Google Contacts' suggest/confirm/undo UX; Apple Photos'
  silent-re-merge failure as the canonical anti-pattern; Honcho's bounded
  peer cards; person-memory organized by relationships (Jolly et al. 2023).

## The problem

A life's most memory-dense keys are referents — people first, then places
and projects. Today "Ana", "my sister", and "Ana Popescu" are three unlinked
titles: recall splits their facts, hints can't connect them, and nothing in
the store knows they are one person. The field's default fix — an LLM
deciding `is_duplicate: true` and merging silently — is exactly what this
library exists to refuse: identity is an owner decision.

## Design principles (inherited, not invented)

1. **Deterministic candidates, owner adjudication, no auto-merge zone.**
   The classical three-zone threshold loses its auto-merge zone entirely;
   everything above the floor goes to the queue. Models may (in hosts)
   annotate a card with a rationale — they never decide.
2. **Answered means answered (I9).** A "different" verdict writes a
   permanent `no_match` edge; no candidate rule may ever resurrect the pair,
   and a merge across a `no_match` edge is refused. This single rule is the
   entire Apple Photos lesson.
3. **Nothing is destroyed by a merge.** The duplicate becomes a `merged`
   husk — content intact, out of every surface, chained to its survivor.
   Forgetting remains a separate, explicit act.
4. **Type-generic, person-motivated.** The library resolves *same-referent
   within one node type* — `person` examples throughout, zero
   person-specific code. Places, projects, and pets ride free.
5. **I2 everywhere, again.** Resolution and candidate surfaces obey the
   surfacing axis: `never` referents are invisible to resolution;
   `ask` referents resolve only on their exact name (which resolution, by
   definition, supplies).

## Schema (version 2)

```sql
-- Names a node also answers to. One alias may point at MANY nodes
-- (two different Anas): lookups return candidates, never a winner.
CREATE TABLE aliases (
  alias   TEXT NOT NULL,   -- normalized (lowercase, collapsed whitespace)
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  source  TEXT NOT NULL CHECK (source IN ('owner','merge')),
  created TEXT NOT NULL,
  PRIMARY KEY (alias, node_id)
) STRICT;

-- Open identity questions: an unordered pair awaiting the owner.
-- (a, b) stored with a < b (ULID order) so the pair has one row.
CREATE TABLE identity_pending (
  a        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  b        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  evidence TEXT NOT NULL CHECK (evidence IN ('title_match','token_subset','alias_match')),
  created  TEXT NOT NULL,
  PRIMARY KEY (a, b)
) STRICT;
```

Existing machinery reused: `merged_into` and `no_match` are already
declared system edge types; `merged` is already a terminal status in the
FSM. This arc makes both real.

**Amendments to existing invariants:**
- **I6** — the forget cascade additionally deletes the node's `aliases`
  rows (aliases are content) and lists `merged` husks chained to the target
  as `husk:<id>` entries in `needsOwner` (computed before edges drop).
- **I8** — `merged` joins the forgettable-from set: a husk still holds
  content, and content destruction must remain available for it. Status
  table row: forgotten reachable from active/archived/quarantined/merged.
- **I9** (now precise): after a `no_match` edge exists between two nodes in
  either direction, (a) no candidate rule ever re-inserts the pair into
  `identity_pending`, and (b) `decideIdentity(..., "same")` on the pair is
  refused with `conflict`. Both halves get conformance scenarios.

## API additions (contract v0.2.0)

```ts
// --- aliases ---
addAlias(id: NodeId, alias: string): void;      // owner verb; audited (I7: meta carries source only, never the alias text)
removeAlias(id: NodeId, alias: string): void;
aliasesOf(id: NodeId): string[];

// --- resolution (host asks: who is "Ana"?) ---
// Exact-normalized match on titles and aliases within one type.
// I2 applies: never-surfaced nodes are invisible; ask nodes resolve
// (the text IS their name). Returns candidates — never picks a winner.
resolveRef(type: string, text: string): Node[];

// --- deterministic candidate generation (owner- or host-scheduled; never ambient) ---
// Scans active same-type pairs with rules R1–R3 below; inserts new pairs
// into identity_pending; skips no_match pairs (I9), existing pending pairs,
// and any pair involving a never-surfaced node (I2). Returns pairs added.
suggestIdentities(type: string, cap?: number): number;

// --- the verdict (pair-keyed, so not decide()) ---
// "same": the compound merge — survivor chosen BY THE OWNER via argument
// order, never by a heuristic. "different": permanent no_match (I9).
decideIdentity(keep: NodeId, other: NodeId, verdict: "same" | "different"): Node;
```

**`Pending` becomes a tagged union** (the one breaking change — the queue
stays the single place a host renders "everything awaiting the owner"):

```ts
type Pending =
  | { kind: "proposal"; node: Node; conflicts: readonly Conflict[] }
  | { kind: "edit"; node: Node; edit: EditEnvelope; conflicts: readonly Conflict[] }
  | { kind: "identity"; a: Node; b: Node; evidence: IdentityEvidence; created: string };
```

Ordering: proposals, then edits, then identity questions — each oldest
first. Identity entries respect I2 by construction (never-surfaced nodes
cannot enter `identity_pending`).

## Candidate rules (deterministic, in priority order)

| Rule | Fires when | Example |
|---|---|---|
| R1 `title_match` | Equal normalized titles (the doctor's duplicate lens, promoted to a question) | "ana popescu" = " Ana  POPESCU " |
| R2 `token_subset` | One title's full token set ⊂ the other's, shorter side ≥ 1 token, both sides ≥ 2 chars/token | "Ana" ⊂ "Ana Popescu" |
| R3 `alias_match` | An alias of one equals the title or an alias of the other | alias "sis" on Ana = title "Sis" |

Exclusions, in every rule: self-pairs, non-active nodes, `never`-surfaced
nodes (I2), pairs already pending, pairs with a `no_match` edge (I9), pairs
already chained by `merged_into`. Deliberately NOT in v1: edit distance,
phonetics, co-occurrence, embeddings — fuzzy matching enters only if the
deterministic rules prove insufficient in real use, and then as candidate
*generation* only, never as a verdict.

## The merge, step by step (the compound commit)

`decideIdentity(keep, other, "same")` — guards first: both active, same
type, distinct, no `no_match` edge (I9), neither `never`-surfaced. Then, in
order, each step audited:

1. **Rewire edges.** First, edges that must not survive drop outright:
   the pair's own edges (would-be self-loops), the dup's self-loops, and
   every `no_match` edge incident to the dup — identity assertions retire
   with the node that carried them; transplanting one would poison a pair
   the owner never ruled on (I9). Then every remaining edge of `other`
   re-points to `keep` (`keep`'s existing edges win; collision leftovers
   drop). One audit row summarizes `{rewired, dropped}`.
2. **Fold names.** `other`'s normalized title and all its aliases become
   aliases of `keep` (`source='merge'`) — future `resolveRef("Ana")` finds
   the survivor.
3. **Chain and retire.** `other` → status `merged` (terminal), plus the
   `merged_into` edge `other → keep`. The husk keeps title/body/props —
   nothing is destroyed; its own alias rows and pending identity questions
   are removed (moot); FTS row and vectors scrubbed (non-active).
4. **Summary audit** `identity.merge` with both ids and counts — content-free.

`decideIdentity(a, b, "different")`: write the `no_match` edge, remove the
pending row, audit. Permanent (I9).

**No unmerge verb in v1** — stated, not implied: the husk preserves every
byte, so manual recovery is always possible, but mechanical unmerge is
ambiguous for edges created *after* the merge (whose are they?). Google
Contacts answers this with a 30-day window; our answer is honest deferral —
`merged` stays terminal until real demand defines the semantics.

## The peer card (Phase D — shipped)

`entityContext(id, limit = 6)` — the bounded "peer card" primitive: the
node, its aliases, and its 1-hop ACTIVE neighborhood ranked by recency
(the recall blend's own anchor: `last_used ?? updated`, descending; node
id ascending on ties), hard-capped at `limit`. Each peer carries the raw
edges that connect it to the subject — source/target preserved, so
direction and the edge `context` string survive into the host's prompt
block ("this Ana is the sister, not the coworker"). One hop only
(spreading-activation decays steeply past it). A pure read: nothing is
audited, touched, or written — hosts compose it into prompts and own
their token budgets; the library never injects ambiently.

Semantics, precisely:

- **Subject** — must be ACTIVE. A `merged` husk is refused with a pointer
  at `survivorOf()`; other non-active statuses are refused plainly. A
  `never`-surfaced subject is refused (I2 — never means never); an `ask`
  subject is allowed — an id is the strongest form of literal naming.
- **Peers** — ACTIVE (I3) and `always`-surfaced only: the card names its
  subject, not its peers, so `ask` peers stay out (I2). `day` anchors are
  excluded as plumbing (the same rule ambient recall applies). `no_match`
  edges never appear, and a neighbor connected ONLY by `no_match` is not a
  peer — that edge asserts a NON-relation. Self-loops carry no peer.
- **Bounds** — `limit` must be a non-negative integer; `0` returns the
  identity block alone (node + aliases, no peers).

## What stays out (and why)

- **Mention detection in prose** — a host/model concern; the library's
  door is `resolveRef` + `suggestIdentities`.
- **LLM-assisted matching** — hosts may attach advisory rationale to their
  cards; the library's rules stay deterministic end to end.
- **Cross-type identity** ("Ana" the person vs "Ana" the project) — out;
  types are identity domains by design.
- **Person↔person relationship edges** ("sister_of") — already possible
  today via `link(a, b, "sister_of")`; needs no new machinery, only host
  vocabulary. The research says relationships are how person-memory is
  organized — the spine already agrees.
- **Doctor fields for the identity queue** — deferred to avoid a second
  breaking change; revisit with the next DoctorReport revision.

## Phases

| Phase | Delivers | Pins |
|---|---|---|
| **A — names** | schema v2 migration (aliases + identity_pending), addAlias/removeAlias/aliasesOf, resolveRef with I2, forget-cascade alias scrub + husk listing, alias-aware audit sentinel test | I6/I7 amendments |
| **B — questions** | candidate rules R1–R3, suggestIdentities, `Pending` union (v0.2.0), queue ordering | I2 on candidates |
| **C — verdicts** | decideIdentity: the compound merge + no_match permanence, merged-forgettable, golden scenarios (the two-Anas fixture; the Apple-Photos re-run test) | **I9, both halves** |
| **D — the peer card** | entityContext | — |

Each phase lands with the standing discipline: unit tests + conformance
scenarios in the same PR, `bun test` / `tsc --noEmit` / `biome` green,
SCHEMA.md updated in the same change as the migration.

## Open questions for the owner (decide before Phase A)

1. **Should `suggestIdentities` also run implicitly** (e.g., after every
   Nth propose/createNode of a type)? Design says no — explicit invocation
   keeps the library scheduler-free and the host in control. Confirm.
2. **Alias visibility in recall**: should FTS index aliases (an alias hit
   surfaces the node in recall)? Leaning yes via the existing `extra`
   column in Phase A — cheap, useful, one line in `rebuildFts`. Confirm.
3. **Husk display convention**: `getNode` on a `merged` husk returns it
   as-is; should the library add a convenience `survivorOf(id)` walk along
   `merged_into` chains? Leaning yes (trivial, prevents every host
   reimplementing chain-walking wrong). Confirm.
