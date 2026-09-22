---
source: extensions/fleet.ts
source-hash: 6dcc4e9968ce9978ea13fe5a1a771fc8d7a24f27
documented: 2026-09-20
---

# fleet.ts — one interactive surface for Pi subagents: live roster, attach/steer, per-agent endpoint moves

## What it owns

`fleet.ts` is the single agent surface in this profile, standing in for the two that the
`pi-subagents` package ships (its widget and its own fleet view). It owns:

- **The roster widget** below the editor (`ctx.ui.setWidget` with `WIDGET_KEY = "fleet"`,
  `placement: "belowEditor"`): two lines per agent — a stats row and a live activity line.
- **The `agents` status slot**, published over the `statusbar:slot` bus so `statusbar.ts`'s footer,
  sidebar and `/status` dashboard can show agent counts, per-agent detail and an aggregate token
  figure without knowing anything about subagents.
- **Attachment**: swapping the main transcript pane for one agent's conversation, redirecting the
  status column to that agent's numbers, and routing typed input into `session.steer()`.
- **Per-agent model/endpoint moves** (`/agent-model`), which `pi-subagents` itself does not offer —
  its `invocation` record keeps the spawn-time model forever.
- **A keyboard layer on the empty prompt** (↓/←, ↑/↓, esc, enter, `s`, `m`) that must not steal keys
  from anyone else's dialog.

It reads state from two places: `pi-subagents`' lifecycle events on the bus, and its registry at
`globalThis[Symbol.for("pi-subagents:manager")]`, via `getRecord(id)` (see `record()`). The registry
record carries `lifetimeUsage`, `toolUses`, `invocation.modelId`, `status`, and the agent's own
`AgentSession` — from which fleet uses `sessionManager.getBranch()` (transcript), `getSessionStats()`
(context %), `steer()` and `setModel()`. Only top-level agents are visible; the package hides an
agent's children from every top-level surface, so there is no nested tree.

## Commands

| command | what it does |
| --- | --- |
| `/attach [agent]` | Attaches the session view to a subagent, matching on id prefix or a case-insensitive substring of its description/type. With no argument it attaches directly if exactly one agent is in the roster, otherwise opens a picker. `/attach main` or `/attach off` detaches. |
| `/agent-model [agent] [provider/model]` | Moves a running or queued subagent to another endpoint by calling `session.setModel()`. Either argument may be omitted and is then prompted for with `ctx.ui.select`. Takes effect on the agent's next turn; its prompt cache starts cold on the new endpoint. |
| `/fleet` | Reports whether `pi-subagents`' own widget and fleet view are still on in this project (they fight fleet over ↓). |
| `/fleet takeover` | Writes `widgetMode: "off"` and `fleetView: false` into `<cwd>/.pi/subagents.json`, merging with whatever is already there. Requires a pi restart. |

## Events consumed and emitted

| event | direction | payload | why |
| --- | --- | --- | --- |
| `subagents:created` | consumed | `{ id, type, description, … }` | Adds the agent to the roster as `queued`. |
| `subagents:started` | consumed | `{ id, … }` | Marks it `running` and stamps `startedAt`. |
| `subagents:completed` | consumed | `{ id, status?, durationMs?, tokens? }` | Marks it ended; it lingers in the roster for `FINISHED_LINGER_MS`. |
| `subagents:failed` | consumed | same shape | Same, rendered with the error glyph. |
| `statusbar:endpoint-labels` | consumed | `Record<provider, label>` | Populates `endpointLabels`, so a model id renders as `↗ ALCF Minerva` rather than a bare provider string. Emitted by `endpoints.ts`. |
| `fleet:keys-hold` | consumed | `{}` | Increments `keysHeld`; the key layer goes quiet. |
| `fleet:keys-release` | consumed | `{}` | Decrements it. |
| `statusbar:slot` | emitted | `{ id: "agents", order: 3, tokens, text, state, statusKey: "subagents", details() }` | The roster's presence in the footer/sidebar/dashboard. `statusKey` suppresses `pi-subagents`' raw `setStatus()` line under the dashboard's OTHER section. |
| `statusbar:transcript` | emitted | `{ component }` on attach, `{}` on detach | Hands `statusbar.ts` the `ScrollView` that replaces the main transcript pane. `statusbar.ts` owns the layout; fleet only supplies the component. |
| `statusbar:attached` | emitted | `{ name, stats: () => AttachedStats }` on attach, `{}` on detach | Switches the status column from the session's own numbers to the attached agent's. `stats` is a thunk, re-invoked per render. |

Pi hooks (not bus events) used: `session_start`, `session_shutdown`, `input`, `ui_prompt_start`,
`ui_prompt_end`.

## Modules

### The roster and its ledger

`agents: Map<string, Tracked>` is the raw lifecycle view, updated by the `track(status)` handler
registered for all four `subagents:*` events. `roster()` is the rendered view: it filters out agents
that ended more than `FINISHED_LINGER_MS` (20 s) ago and sorts by `startedAt`, so the list self-prunes.

`track()` encodes one ordering fact: for background spawns `subagents:started` can arrive *before*
`subagents:created`, so a `queued` event never downgrades an agent already marked `running`. It also
only resets `startedAt` on the `running` transition, not on every event.

Everything numeric comes from `live(id)`, a 400 ms-TTL cache (`liveCache`, `LIVE_TTL_MS`) over
`readLive(id)`, which reads the registry record and calls `readSession()` to scan the tail of the
agent's branch (`MAX_TURN_SCAN = 400` messages) for a turn count and the current activity line. That
cache is not an optimisation nicety: the widget re-renders many times a second while the main session
streams, and walking every agent's session per row per frame exhausted the heap.

`rows(theme, width)` renders the widget; `publishSlot()` renders the same data into the status slot.
Both recompute running/queued counts from `live(a.id)?.status ?? a.status` — the registry is more
current than the last lifecycle event.

`ensureTicker()` runs a `TICK_MS` (500 ms) `setInterval` that calls `publishSlot()` and `rerender()`
whenever the roster is non-empty, so elapsed times and token counts keep moving while the main session
is idle. It is started from the widget's `render()` and from `track()`, and torn down as soon as the
roster empties or `dead` is set.

Grep for: `Tracked`, `agents`, `track`, `roster`, `live`, `readLive`, `readSession`, `record`,
`liveCache`, `LIVE_TTL_MS`, `FINISHED_LINGER_MS`, `ensureTicker`, `rows`, `publishSlot`.

### Attach and detach

`attach(ctx, agent)` sets `attachedId`, clears `selectedId` and `paneCache`, wraps a `Component` whose
`render()` calls `attachedRows()` in a `ScrollView({ follow: "end", primary: true })` — `primary: true`
is what lets Pi's own scroll keys drive it — and ships it over `statusbar:transcript`, followed by a
`statusbar:attached` with a `stats` thunk. `detach()` emits both events with empty payloads.

`attachedRows(session, width, theme)` renders the agent's conversation: user/custom messages as
`▌`-quoted wrapped text, assistant text through Pi's `Markdown` renderer with `getMarkdownTheme()`,
tool calls as `→ name {args}` and tool results as a `⎿` first line plus a `(+N lines)` count. It only
renders the last `MAX_PANE_MESSAGES` (120) entries and prepends a "… N earlier messages not shown"
row; `paneCache` keys on entry count, width and the serialized length of the last message's content,
so a streaming agent rebuilds the rows only when they actually changed.

While attached, the `pi.on("input")` hook intercepts interactive input and calls `session.steer(text)`
instead of letting it reach the main session. It always returns `{ action: "handled" }` once
`attachedId` is set — including for empty input and for an agent whose session has no `steer` — so
nothing leaks through to the main conversation by accident.

Grep for: `attach`, `detach`, `attachedId`, `attachedRows`, `paneCache`, `MAX_PANE_MESSAGES`,
`agentOf`.

### The model picker

`/agent-model` filters `roster()` down to agents whose live status is `running` or `queued`, resolves
a target (argument match, then a picker if more than one, then the single candidate), then resolves a
model from `ctx.modelRegistry.getAvailable()` (exact `provider/id`, then a loose match on either),
falling back to a labelled picker that marks the agent's current endpoint (`◀ on this now`) and the
main session's (`← this session`).

`session.setModel(model)` is session-only — the same call `/model` makes for the main session.
Because `pi-subagents`' `invocation.modelId` still reports the spawn-time model afterwards, fleet keeps
its own `endpointOverrides: Map<id, "provider/model">` and every display path reads
`endpointOverrides.get(id) ?? info?.modelId`. The `↗ label` mark is drawn only when that value differs
from `sessionModelId()`, i.e. only when the agent is somewhere other than the main session's endpoint.
`endpointLabel()` maps the provider half of a model id through `endpointLabels`, falling back to the
provider name.

A non-obvious detail: on a successful move `target.samples = []` is cleared, because the agent's
measured tok/s belongs to the endpoint it just left.

There is a deliberate comment in the handler warning that the local variable must not be named `live`
— shadowing the module-level `live()` made the filter reference its own binding before initialization.

Grep for: `endpointOverrides`, `endpointLabels`, `endpointLabel`, `sessionModelId`, `movable`, `nowOn`.

### Token accounting

Per-agent totals come from the registry's `lifetimeUsage` in `readLive()`, summed as
`input + output + cacheWrite`. Context percentage is read separately from
`session.getSessionStats().contextUsage.percent` inside its own `try`, because that call can throw on
a stale session and `null` is a legitimate answer.

The aggregate published on the `agents` slot comes from `tokensById`, a per-session ledger of *every*
agent this session has ever run, keyed by id. `publishSlot()` refreshes the entry for each agent still
in `roster()`; finished agents keep their last known figure. Summing `roster()` directly would make a
cumulative counter go **down** every time an agent aged out after 20 s. `statusbar.ts`'s `Slot`
interface documents the `tokens` field as "fleet publishes the subagent total here".

`rate(agent, out)` computes tok/s over a sliding `SPEED_WINDOW_MS` (10 s, overridable via
`PI_SPEED_WINDOW_MS`) window of `{ t, out }` samples appended at most every 250 ms. It returns
`undefined` unless the span is at least a second and output actually advanced, so a paused agent shows
no speed rather than `0 t/s`. Note that `rate()` mutates `agent.samples`, so it is called from render.

Grep for: `tokensById`, `publishSlot`, `rate`, `samples`, `SPEED_WINDOW_MS`, `contextPercent`, `fmt`.

### Keyboard handling

`ctx.ui.onTerminalInput` is registered in `session_start` and runs four gates before touching anything:

1. `promptDepth > 0 || keysHeld > 0` — see the invariants below.
2. `isKeyRelease(data)` — under the Kitty keyboard protocol (iTerm2 and friends) one press also
   delivers a release; acting on both moved the selection twice, which read as "skips the first agent".
3. `ctx.ui.getEditorText() !== ""` — the layer is live only on an empty prompt, so typing is never
   disturbed.
4. If `attachedId` is set, only `escape` is consumed (to detach); everything else falls through.

`selectedId === undefined` means the list is not focused. ↓ or ← from that state focuses the first
agent still working, else the first row; ↑ from the first row returns to `undefined` rather than
wrapping; `escape` unfocuses; `enter` attaches; `s` opens `ctx.ui.input` and steers; `m` re-enters the
command path via `pi.sendUserMessage("/agent-model <id>")` rather than calling the handler directly.
Every handled key returns `{ consume: true }`; anything unrecognised returns `undefined` so it reaches
the editor. The widget's `render()` repairs `selectedId` if its agent has dropped out of the roster,
snapping to the last row.

Grep for: `onTerminalInput`, `promptDepth`, `keysHeld`, `isKeyRelease`, `matchesKey`, `selectedId`.

### Fire-and-forget promises (fixed 22 Sept 2026)

The `s` (steer) key launched `ctx.ui.input(...).then(...)` with no `.catch`. pi has no
`unhandledRejection` handler, so a rejected `steer()` — or a `notify` on an activation that went
stale during it — would have exited the process. It now has a `.catch` and a `dead` check after the
await, matching the `input` hook and `/agent-model` beside it.

### 22 Sept 2026 lows

Deleted: `transcript()`, `forget`, `Tracked.outputTokens` (all confirmed unreferenced). The 500 ms
ticker now re-checks the roster from inside its own body: only `render()` used to re-evaluate it,
and a session without UI never renders, so after the last agent aged out a headless session kept
emitting a `statusbar:slot` every half second until shutdown.

## Invariants a future change must not break

- **The 500 ms ticker must never outlive the activation.** `/reload` (and any shutdown) replaces the
  extension activation; from that moment `pi.events.emit` throws `"extension ctx is stale"`. A throw
  from a render is survivable — Pi's layout pass catches it — but a throw from a timer is an
  **uncaughtException that kills the session**. `pi.on("session_shutdown")` therefore sets `dead = true`,
  clears `ticker` and clears `liveCache`; the interval callback re-checks `dead` and self-clears as a
  second line of defence; `session_start` resets `dead = false`. Any new timer or async callback needs
  the same treatment.
- **All bus emissions go through `emit(event, payload)`, never `pi.events.emit` directly.** `emit()`
  returns early when `dead`, and latches `dead = true` if the call throws — the activation can go away
  between the check and the call.
- **`sessionModelId()` must stay defensive.** It reads `ctxRef?.model` inside a `try` and returns
  `undefined` on throw, because it is called from `rows()` during layout; the "↗ endpoint" mark is
  simply omitted rather than taking the session down.
- **`promptDepth` and `keysHeld` gate the key layer.** `promptDepth` is incremented/decremented by
  `ui_prompt_start` / `ui_prompt_end` and is `> 0` whenever Pi is showing a blocking dialog
  (select/confirm/input/editor/custom). Without that gate, escape closing the `/status` dashboard also
  detached from the attached agent (two escapes to leave one popup), and arrow keys moved the roster
  underneath an open picker. `keysHeld` covers the window *before* a dialog exists: Pi has no
  command-start event, so a slow command announces itself — `endpoints.ts` emits `fleet:keys-hold`
  around its ~10 s four-cluster probe and `fleet:keys-release` in a `finally`. Both counters clamp at
  zero on release.
- **`tokensById` is append-only within a session.** Do not rebuild the aggregate from `roster()`.
- **`live()`'s cache must stay in front of every session walk.** Calling `readLive()` or
  `readSession()` per row per frame is what exhausted the heap before the cache existed.
- **`pi-subagents`' own surfaces must be off**, or two lists fight over ↓ and the first keypress goes
  to theirs.

## Gotchas

- `<cwd>/.pi/subagents.json` **overrides** `~/.pi/agent/subagents.json`, and `pi-subagents`'
  `/agents → Settings` writes the project file. A project can therefore silently switch its widget and
  fleet view back on; `subagentSurfaces()` merges both files and `session_start` warns when they are on.
  `/fleet takeover` writes the project file, and the change needs a pi restart.
- `subagentSurfaces()` treats the surfaces as on unless *both* `widgetMode === "off"` **and**
  `fleetView === false` — setting only one is not enough.
- `statusbar:attached` passes `stats` as a function, not a snapshot. Making it a plain object would
  freeze the column's numbers at attach time.
- `rate()` has a side effect (it pushes into `agent.samples`) and is called from `rows()` and from the
  `statusbar:attached` stats thunk. Calling it from a third render path changes the sampling cadence.
- `attach()` closes over the `Tracked` object, but reads live data through `live(agent.id)` on every
  render, so the pane keeps working as the record is updated. It does *not* re-check that the agent is
  still in `roster()` — an attached agent that ages out of the roster stays attached until esc.
- Dead code to be aware of before "fixing" it: the module-level `transcript()` helper, the local
  `forget()` alias for `liveCache.delete`, and `Tracked.outputTokens` are all written but never read.
- The `agent-model` handler deliberately avoids naming a local `live`; re-introducing that shadow
  reproduces a TDZ crash in the `movable` filter.
- `MAX_PANE_MESSAGES` (120) and `MAX_TURN_SCAN` (400) are the only things bounding work on a
  long-running agent's branch, which can hold thousands of messages.

## Related

- [[statusbar]] — owns the footer, sidebar, `/status` dashboard and the transcript layout; consumes
  `statusbar:slot`, `statusbar:transcript` and `statusbar:attached`.
- [[endpoints]] — emits `statusbar:endpoint-labels` and the `fleet:keys-hold` / `fleet:keys-release`
  pair; supplies the human labels behind the `↗` mark.
- [[rounds]] — another publisher on the `statusbar:slot` protocol.
- [[../architecture/pi-internals]] — the Pi-internal surfaces this profile relies on
  (`Symbol.for("pi-subagents:manager")`, `setLayoutRoot`, widget placement, `onTerminalInput`).
