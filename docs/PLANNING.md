# PLANNING.md — tasks, events, reminders: planning rooted in memory (design)

- **Status:** ARC COMPLETE — the owner confirmed all five open questions
  (`when_at` naming; `ask` stays off the agenda; the one consent-gated
  `task` type; no automatic day-anchoring; `dueCandidates` cap 20,
  oldest-first, no cutoff). Phase A shipped in **PR #20** (schema v4,
  v0.4.0); I17 is conformance-pinned.
- **Ships as:** **schema_version 4** and **v0.4.0**. One new invariant
  (I17). No API breaks: one nullable column (on two tables), one new read,
  one new lens, one new verb, one optional field on three write paths.
- **The thesis:** a task is still a memory. The owner said it; the library
  already believes it — *everything durable is a node*. This arc does not
  bolt a task manager onto a memory store; it gives the nodes that happen
  to be tasks, events, and reminders the one thing they lack: **a
  relationship with future time**. Everything else they already inherit —
  the consent gate (an agent-proposed task waits for the owner), typed
  edges (`waiting_on` Ana, `part_of` Trip 2026), the peer card (a
  project's card IS its dashboard), history, importance, surfacing,
  honest forgetting, day anchors.
- **The hard line, restated first:** the library has **no scheduler, no
  daemon, no notifications — by design, forever**. It is a pure function
  of its data and the clock argument. The HOST is the thing that ticks:
  it wakes (cron, a live agent, an app in the foreground), asks
  `agenda(...)` and `doctor(...)`, and acts. Time passes outside.

## The problem

The store holds three kinds of time already: transaction time (`created`),
world time on edges (`valid_from`/`valid_until`), and the episodic past
(`on_day` anchors). What it cannot hold is an **appointment with the
future**: "call Ana on Tuesday", "the flight is on the 14th", "resurface
this in March". Today a host can stuff a date into `props`, but then the
date is invisible to the contract — nothing can query it, sort by it,
report on it, or validate it, and every host reinvents the same column.

## Design principles (inherited, not invented)

1. **Declared, never inferred (I17, the I15 doctrine on nodes).** A node's
   scheduled moment comes from an explicit argument — strict ISO-8601 UTC,
   date-only = midnight UTC, the shared `parseStrictIso` rule. The library
   never derives a date from content ("next Tuesday" is a host/model
   problem; by the time the library sees it, it is an argument).
2. **No new lifecycle.** The status FSM is a memory lifecycle and it
   already fits work: a finished task is an **archived memory with an
   outcome** — which is exactly what a human mind does with finished
   business. `done` is not a status; it is `transition(id, "archived")`
   plus `props.outcome`. The FSM gains nothing in this arc.
3. **The agenda is ambient recall over time.** `agenda(from, to)` obeys I2
   exactly as `recall` does: nothing in an agenda pull literally names a
   node, so `ask` and `never` nodes do not appear. A reminder the owner
   marked `ask` is a reminder the owner chose to keep off the board —
   that is the axis working, not failing.
4. **Recurrence is host vocabulary.** A recurrence rule is data
   (`props.rrule`, host-defined); instances are nodes; materializing the
   next instance is a host act at a host moment (completion, or a tick).
   The library stores what the host declares — it never generates nodes
   on its own. Nothing writes without a verb being called.

## Schema (version 4)

```sql
-- The appointment with the future (or the past): the world-time moment a
-- node is scheduled for / happens at. NULL = undated — most memories.
ALTER TABLE nodes ADD COLUMN when_at TEXT;            -- ISO-8601 UTC
CREATE INDEX idx_nodes_when ON nodes(when_at) WHERE when_at IS NOT NULL;

-- History snapshots capture it too: a reminder's time is content, and
-- "when did I move this deadline" is a history question (I16 unchanged).
ALTER TABLE memory_history ADD COLUMN when_at TEXT;
```

Column named `when_at` (not `when` — an SQL keyword; not `due_at` —
events happen, they aren't due). TypeScript surface: `Node.when:
string | null`, `HistorySnapshot.when: string | null`.

## API

```ts
// The field enters through the three write paths that own node content:
createNode({ ..., when?: string })            // owner, born with a time
propose({ ..., when?: string })               // agent-proposed appointment — gated like everything else
updateNode(id, { ..., when?: string | null }) // set, move, or clear (null clears); history captures the old value
// decide's verdict fields accept "when" (strict ISO string; empty string clears)

// The window read: active, always-surfaced nodes with when_at in
// [from, to), ordered when_at ASC then id ASC. Both bounds strict ISO.
agenda(from: string, to: string, opts?: { type?: string; limit?: number }): Node[];

// The doctor gains the due lens: active, non-never nodes whose when_at
// has passed (<= now), oldest-due first, capped like every other lens.
// Reports, never acts — the host decides what "overdue" means to it.
DoctorReport.dueCandidates: readonly NodeId[];

// The public day-anchor verb: get-or-create the day node for a UTC date
// (the same node ensureDayNode uses internally). Idempotent. The host
// then links explicitly: link(task.id, day.id, "scheduled_on") — a HOST
// edge type; `on_day` remains the system's creation anchor only.
dayAnchor(date: string): Node;
```

### Semantics, precisely

- **`when` is one moment, not a window.** Durations, all-day spans, and
  time zones are host presentation. A node that needs an end has an edge
  or props; the library indexes one sortable instant. (Edges already have
  windows — `valid_from`/`valid_until` — for facts that span.)
- **Owner-local days are the host's job**, same as F12/day anchors: the
  library is UTC-only (I11). A host presenting "today" converts before it
  calls `agenda`.
- **Past `when_at` is fine and meaningful** — an event that happened
  keeps its moment; `agenda("2026-01-01", "2026-02-01")` a year later is
  the January calendar, which is time travel the same way `asOf` is.
- **Nothing auto-archives.** An event past its time stays active until
  the owner (or host policy, explicitly) transitions it. A past event is
  a memory — that is the whole thesis.
- **`agenda` and `dueCandidates` never overlap in purpose:** agenda is a
  window you choose; dueCandidates is the standing "these slipped past
  now" lens. Hosts compose: `agenda(now, +7d)` + `doctor().dueCandidates`.
- **The consent gate composes untouched.** An agent proposing a reminder
  is proposing a memory with a `when` — it waits in the queue like every
  other claim about the owner's life. `merged_pending` keeps the latest
  proposal's `when` (latest wins, the existing rule).
- **History captures the move.** Rescheduling via `updateNode`/verdict
  fields snapshots the pre-change `when` (I16's capture moments, no new
  ones) — "this deadline moved three times" is a `history(id)` replay.

## Hosting conventions (the mapping, recommended not enforced)

The library ships **zero** planning-specific code paths beyond `when_at`,
`agenda`, `dueCandidates`, and `dayAnchor`. Everything below is registry +
edges + props — documented convention, enforced by no one, changeable by
any host.

### Types

| Type | bornStatus | why |
|---|---|---|
| `task` | `proposed` (consent-gated) | The killer feature: an agent can *propose* "Call Ana about the trip" and it waits for the owner. Owner-created tasks still born active via `createNode` (the I1 owner half works on gated types). The cost, honestly: owner **content** edits route through `proposeEdit` → `decide` (two calls a host wraps in one button); `transition`, `touch`, `setSurfacing`, and `when` moves via verdict fields stay direct. |
| `project` | `active` (owner-authored) | Projects are owner structure, not agent claims. `entityContext(project)` is the dashboard: recent tasks, people, notes — the peer card doing project management. |
| `event` | `active` | A thing that happens at `when_at`. Stays active after it happens — a past event is a memory. |
| `reminder` | `proposed` | A task whose whole body is its `when`. Or skip the type and use `task` — hosts choose. |

### Work states — the FSM mapping (no new states)

| Work state | Library state |
|---|---|
| open | `active` |
| done | `transition(id, "archived")` + `props.outcome = "done"` (via the queue for gated types — one wrapped call) |
| dropped | `archived` + `props.outcome = "dropped"`; `forget(id)` only when it should truly never resurface |
| snoozed / rescheduled | update `when` — audited, history-captured |
| waiting on someone | edge `waiting_on` → person (the peer card shows it from both sides) |
| blocked | edge `blocked_by` → task |
| recurring | `props.rrule` (host grammar); on completion or tick, the HOST materializes the next instance as a new node, `derived_from` the rule-holder if lineage is wanted |

### Edges

`part_of` (task → project), `scheduled_on` (node → day node, via
`dayAnchor`), `waiting_on`, `blocked_by` — all host vocabulary, all
already possible, all visible in peer cards and closable with validity
windows where a fact ends ("was blocked by X until the 12th").

## What stays out (and why)

- **A scheduler, daemon, timers, notifications** — the hard line. The
  host ticks; the library answers.
- **New FSM states** (`done`, `cancelled`, `in_progress`) — a work
  lifecycle bolted onto the memory lifecycle would make every memory
  answer questions only tasks have. The mapping table covers it.
- **Recurrence expansion** — the library never creates nodes unbidden.
- **Duration/timezone semantics** — one UTC instant per node; the rest is
  presentation.
- **Calendar sync (CalDAV/ICS)** — a host integration; the schema is
  trivially exportable (`when_at` + title is already an ICS VEVENT).
- **Priority beyond `importance`** — 0–5 exists; a second axis needs a
  demonstrated failure of the first.

## Invariant

- **I17 — Scheduled time is declared, never inferred.** `when_at` is set
  only from explicit arguments (`createNode`/`propose`/`updateNode`/
  verdict fields), strict ISO-8601 UTC via the shared rule; the library
  never derives, shifts, or clears it on its own. `agenda` returns only
  `status='active' AND surfacing='always'` nodes (I2: an agenda pull
  names nothing); `dueCandidates` excludes `never` (the F8 doctor rule).
  History snapshots carry the pre-change `when_at` (I16 unchanged).

## Phase (one)

| Phase | Delivers | Pins |
|---|---|---|
| **A — the appointment** | schema v4 migration (both columns + the partial index), `when` through the three write paths + verdict fields with I17 validation, history capture, `agenda()`, `doctor().dueCandidates`, `dayAnchor()` | **I17**; the golden "Tuesday" scenario: a week's agenda window with tasks/events in order, an overdue task in `dueCandidates`, `ask`/`never` nodes provably off the board, a reschedule replayed by `history`, a task scheduled onto a future day anchor |

One phase — the mechanism is small because the philosophy already did the
work. The standing discipline applies: tests + conformance in the same PR,
the verify loop green, SCHEMA.md updated with the migration.

## Open questions for the owner (ratify before Phase A)

1. **Naming: `when_at` / `Node.when`** — not `due` (events aren't due),
   not bare `when` in SQL (keyword). Confirm or rename.
2. **`ask` stays off the agenda.** The sharpest tradeoff in the arc: a
   reminder marked `ask` will NOT appear in `agenda()` — ambient reads
   name nothing (I2, principle 3). The owner who wants a private reminder
   on the board sets `always` + `importance` low instead. Confirm.
3. **One consent-gated `task` type** — agent proposals and owner-born
   tasks share it; the cost is owner content-edits routing through the
   queue (wrapped by hosts). Alternative: an ungated `task` where agents
   cannot propose tasks at all. Recommend gated. Confirm.
4. **No automatic day anchoring of `when_at`.** `on_day` stays the
   creation anchor; scheduling onto a future day is explicit
   (`dayAnchor` + `link`). Automatic anchoring would write edges the
   owner didn't ask for on every reschedule. Confirm.
5. **`dueCandidates` shape** — cap 20 (every lens's cap), oldest-due
   first, no age cutoff (a task overdue by a year is the one you most
   need to see). Confirm.
