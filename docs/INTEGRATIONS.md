# INTEGRATIONS.md — reaching the library from outside (design sketch)

- **Status:** SKETCH — design only. The surfaces below are satellite work
  (their own packages or the host repo), not library code; nothing here
  changes the core.
- **The doctrine, stated once:** the library is **Bun-only by design**
  (ratified). `bun add balaur-memory` and `import { Store }` is the whole
  in-process story — the package ships raw TypeScript (Bun consumes it
  natively; no build, no dist). Every other runtime and harness reaches
  the library **through a process boundary, never an import**: one Bun
  process owns the writer (I14), and everything else talks to it. The
  adapter seam (ADR-0001) remains the documented exit ramp if the world
  ever forces a port — an option kept cheap, not a promise kept warm.

## Surface 1 — the MCP server (any MCP host: Claude, Cursor, …)

A standalone stdio MCP server, run with Bun, owning one Store:

```
bunx balaur-memory-mcp --dir ~/.local/share/life
```

**The consent doctrine maps directly onto the tool surface.** The MCP
client IS the agent — so the server exposes the AGENT's verbs, and only
those:

| Tool | Backs onto | Notes |
|---|---|---|
| `memory_propose` | `propose()` | annotated `destructiveHint: false` — it can only queue |
| `memory_propose_edit` | `proposeEdit()` | parks; never applies |
| `memory_recall` / `memory_search` | `recall()` / `search()` | I2 enforced by the library, not the prompt |
| `memory_agenda` | `agenda()` | the scheduled window |
| `memory_episode` | `episode()` | the lived past |
| `memory_who` | `resolveRef()` | candidates, never a winner |
| `memory_context` | `entityContext()` | the peer card for prompts |

**Deliberately NOT exposed to agents:** `decide`, `decideIdentity`,
`forget`, `closeEdge`, `updateNode`, `transition`, `backup` — the owner's
verbs live in the host UI, behind the human. An MCP host that wants an
approval flow renders `pendingQueue()` (read-only tool: `memory_pending`)
and routes the owner's click to the host process, not through the agent's
tool channel. This is the same split the schema enforces (I1/I4) — the
wire surface just refuses to blur it.

## Surface 2 — the pi.dev extension

Pi (`earendil-works/pi`) ships **no built-in MCP by design**; its native
surface is a TypeScript extension API (`pi.registerTool`,
`pi.appendEntry`, session lifecycle hooks) running under Pi's own
runtime. The library does not import into that runtime (Bun-only), so the
extension is a **thin client over the process boundary**:

- `~/.pi/agent/extensions/balaur-memory.ts` registers the same agent-verb
  tool set as Surface 1 and forwards each call to the Bun-run server
  (spawn once per session, stdio; or connect to the MCP server above —
  one backend, two front doors).
- `session_start` hook: pull `entityContext` / `recall` for the working
  topic and inject as context; `pi.appendEntry` keeps the session's
  memory cursor so a resumed session re-hydrates.
- Distribution: an npm package referenced from Pi's `settings.json`
  (`npm:balaur-memory-pi`), per Pi's package mechanism.

## Surface 3 — the Agent Skills package

A `SKILL.md` under the [Agent Skills spec](https://agentskills.io) —
the same shape Claude Code, Codex, and Pi all read — documenting the
CLI/server invocations, so one skill folder serves every harness that
speaks the standard. Cheapest surface of the three; ships with either
satellite.

## Future satellite work (from the field survey, unscheduled)

- **Export CLI**: `balaur-memory export --mif | --ics | --vcard | --jsonl`
  — MIF for cross-tool memory portability, ICS for `when`-bearing events,
  vCard for `person` nodes, JSONL for archival. All pure reads over the
  schema; none require library changes.
- **A Markdown mirror** (write-through, read-never) as a second archival
  layer — the basic-memory pattern, host-side.

## What this sketch refuses

No HTTP server in or near the core. No multi-writer story — remote
surfaces serialize through the one Bun process that owns `memory.db`
(I14). No agent-reachable owner verbs, ever, on any surface — a consent
gate with a wire-shaped hole in it is not a consent gate.
