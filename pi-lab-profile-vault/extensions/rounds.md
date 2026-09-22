---
source: extensions/rounds.ts
source-hash: 8564b6916b510d7819e6c44add9289c384897217
documented: 2026-09-20
---

# rounds.ts — runs a change through dev → review → critique as subagents on separate endpoints

## What it owns

The `/round` lifecycle and nothing else. It sequences three roles — **dev** implements, a **panel**
of reviewers reads the diff, a **critic** adjudicates the reviews — by spawning each as a
pi-subagents subagent over that extension's documented cross-extension RPC, waiting for its result,
and feeding that result to the next phase.

It owns:

- the three commands (`/round`, `/rounds`, `/review`) and the `--rounds` / `--reviewers` parsing;
- one round's in-flight state: the current phase, the set of live agent ids, and the cancel flag;
- the `round` status slot published to [[statusbar]];
- the per-run report at `<cwd>/.pi/rounds/<timestamp>.md`;
- the follow-up message that puts the verdict back into the session.

It does **not** own the roles. Those are agent files (`agents/dev.md`, `reviewer.md`, `critic.md`,
symlinked into `~/.pi/agent/agents/`) and they deliberately carry no `model:` frontmatter. It does
not own the model registry or run any inference itself — every phase is a subagent.

The point of the panel is *different weights*, not different hosts: the same reviewer role runs
twice on two models at once and the critic sees both, so a change is never graded only by the model
that wrote it, and one model's blind spot does not become the review's blind spot. Two copies of one
model would share blind spots; a second seat that differs only by endpoint buys little beyond
redundancy against a flaky gateway, which the per-seat retry already covers.

## Commands

| Command | What it does |
|---|---|
| `/round <task>` | One full cycle: dev, then the panel in parallel, then the critic. Writes a report, posts the verdict, updates the slot. |
| `/round --rounds N <task>` | Hands what survived the critic back to dev and goes again, up to N times (clamped 1–5). Stops early when nothing was CONFIRMED. |
| `/round --reviewers N <task>` | Uses the first N seats of the configured panel. Flags may be combined and given in either order, before the task text. |
| `/round` or `/round status` | Notifies with the current phase, elapsed seconds and task — or the last verdict if idle. |
| `/round stop` | Sets the cancel flag and sends `subagents:rpc:stop` to every live agent. The loop then breaks at the next phase boundary. |
| `/rounds` | Lists up to 20 past reports in `<cwd>/.pi/rounds` (newest first, labelled with date, verdict and task) and pastes the chosen one back into the conversation, clipped to 12 000 characters. |
| `/review [focus]` | Same machinery with the dev phase skipped: reviews the working tree as it stands. Defaults the task to "the current uncommitted change". |

## Configuration

`rounds.json` decides which endpoint each role runs on. `readConfig(cwd)` tries, in order:

1. `<cwd>/.pi/rounds.json` — project-local,
2. `~/.pi/agent/rounds.json` — global.

The **first file that parses to an object wins**; it is not merged with the next one or with
`DEFAULTS` field by field. Missing *and* malformed both fall through silently (a bad JSON file
must not take the command down), so a typo in the project file quietly demotes you to the global
file, and a typo in both quietly gives you `{}`.

Shape, as shipped in `profiles/lab/rounds.json` (symlinked to `~/.pi/agent/rounds.json`):

```json
{
  "dev": null,
  "panel": [
    { "label": "reviewer A", "model": "alcf-minerva/gpt-oss-120b" },
    { "label": "reviewer B", "model": "alcf-minerva/nemotron-3-ultra" }
  ],
  "critic": "alcf-metis/gpt-oss-120b",
  "timeoutMinutes": 20
}
```

- `dev` / `critic` — a `"provider/modelId"` string, or `null`/absent to inherit the session's model.
- `panel` — an array of seats, each `{ label, model? }`. The label is what appears in the report
  heading and in the block handed to the critic; the model is optional per seat.
- `timeoutMinutes` — **declared and never read.** `RoundsConfig` and `DEFAULTS` both carry it, but
  the only timeout in force is the module constant `SPAWN_TIMEOUT_MS` (20 minutes per phase).
  Changing it in the config does nothing.

`DEFAULTS` supplies `panel` (two seats labelled "reviewer A" and "reviewer B", neither pinned to a
model) and the unused `timeoutMinutes`. With no config at all a round still runs — it is just one
model reviewing itself.

How a model string takes effect: it is passed as `options.model` on the spawn RPC, and pi-subagents'
agent runner resolves *explicit option > config.model > parent model*. That is why the role files
stay portable and this one file is the only place endpoints are decided. `profiles/example/rounds.json`
is the template for strangers, naming hosted models instead of the lab's clusters.

**Degradation.** If a spawn is refused with an error matching `/model (not found|not in scope)/i`,
`runPhase` retries the same spawn once with no model override, so that seat falls back to the
inherited model. A config naming clusters this machine does not have therefore degrades rather than
failing.

## Events consumed and emitted

| Event | Direction | Payload | Why |
|---|---|---|---|
| `subagents:rpc:ping` | emitted | `{ requestId }` | Asked once before a run starts; `subagentsReady()` |
| `subagents:rpc:ping:reply:<requestId>` | consumed | any | Answered ⇒ pi-subagents has bound a session. Times out after **1 s** and the command aborts with an install hint, because otherwise the first spawn sits for the full 30 s reply timeout and then blames itself |
| `subagents:rpc:spawn` | emitted | `{ requestId, type: role, prompt, options: { description, isBackground: true, bypassQueue: true, model? } }` | Start one phase |
| `subagents:rpc:spawn:reply:<requestId>` | consumed | `{ success, data: { id } }` or `{ error }` | Gives the agent id, or the refusal that triggers the no-model retry. Times out after `SPAWN_REPLY_MS` (30 s) |
| `subagents:completed` | consumed | `{ id, status, result, error, durationMs, tokens }` | Phase finished |
| `subagents:failed` | consumed | same shape | Same handler; both resolve the phase promise |
| `subagents:rpc:consume` | emitted | `{ requestId, agentId }` | Tells pi-subagents this result has already been shown, so its own completion notification is not delivered on top of ours and does not cost the parent a turn |
| `subagents:rpc:stop` | emitted | `{ requestId, agentId }` | `/round stop`, and the stop-on-arrival path for an agent that was still starting |
| `statusbar:slot` | emitted | `{ id: "round", text, state, statusKey: "rounds", details }` | The one place a round's progress shows |
| `statusbar:ready` | consumed | — | The bar re-emits at session start, so the slot appears whatever order extensions load in |
| `session_start` | consumed (`pi.on`) | — | Publish the idle slot |
| `session_shutdown` | consumed (`pi.on`) | — | Set `dead` |

Outside the bus, the verdict reaches the model through `pi.sendMessage({ customType: "rounds", … },
{ deliverAs: "followUp", triggerTurn: false })` — delivered, but it does not start a turn by itself.

## Modules

**Lifecycle guard — `dead`, `emit()`.** A round outlives a `/reload`: its phases are promises and
pi-subagents keeps running the agents, but the activation that started it is gone and the captured
`pi` throws on access. A throw from an async continuation is an uncaughtException, which kills the
session. So `session_shutdown` sets `dead`, every emit goes through `emit()`, and a throw inside it
latches `dead` as well. The one non-emit escape — `pi.sendMessage` — is guarded by an explicit
`if (dead) return` that also skips the `ctx.ui.notify` after it.

**Config — `RoundsConfig`, `Seat`, `DEFAULTS`, `readConfig`.** See above. Both `round()` and
`parse()` call `readConfig` independently, so a config edited mid-session is picked up by the next
command without a reload.

**Status slot — `publish`, `idleSlot`.** Idle shows the last verdict (`state: "ok"`) or a dash
(`state: "idle"`); `announce()` republishes as `busy` with the phase, the first 60 characters of the
task and the elapsed seconds. `announce` also clears Pi's native `rounds` status key, because the
slot is the single display.

**Phase runner — `runPhase`, `stopAgent`, `live`.** Two nested promises: the spawn handshake (30 s)
and then the completion wait (`SPAWN_TIMEOUT_MS`, 20 min). Both unsubscribe in every exit path.
Non-obvious invariants here:

- `live.add(id)` happens before the wait, and `if (cancelled) stopAgent(id)` immediately after,
  because a `/round stop` can land while a spawn is still in flight and that agent would otherwise
  never be told.
- The `subagents:rpc:consume` emit sits directly after the completion event with **no `await`
  between them**. pi-subagents holds its completion nudge for 200 ms (`NUDGE_HOLD_MS`); an await
  there would miss the window and the model would see the result twice.

**Outcome grading — `text`, `failed`, `count`, `verdictLine`.** `failed()` treats an *empty* result
as a failure alongside errors and non-`completed` statuses: a gpt-oss model occasionally ends a turn
having produced only reasoning, and an empty review handed to the critic is worse than one reviewer
fewer. `verdictLine` counts the literal words CONFIRMED / PLAUSIBLE / REJECTED in the critic's text —
that vocabulary is defined in `agents/critic.md`.

**The round loop — `round()`.** Guards on `running`, pings, then per iteration: dev (skipped by
`/review`), the panel in parallel via `Promise.all`, one retry for each seat that failed, then the
critic over the merged usable reviews. `carry` is the thread between phases — dev's report into the
review brief, the critique into the next round's dev prompt. The loop breaks when a phase fails, when
cancelled, when no seat produced anything usable, or when the surviving critique contains no
CONFIRMED (another dev pass would have nothing to fix).

**Report and hand-back — `writeReport`, `clip`.** The full transcript of every phase goes to disk;
the session gets the critique at up to 6 000 characters and every other phase at 1 200, because a
round that pastes three agent transcripts into the context window has spent the budget it was meant
to save. `writeReport` swallows its own failure and returns `undefined`; the round still reports.

**Argument parsing — `parse`.** Loops `^--(rounds|reviewers)[\s=]+(\d+)` off the front, so flags may
repeat and come in any order, each clamped to 1–5. Everything after them is the task. The default
seat count is the *configured* panel length, not `DEFAULTS`.

### Surviving a `/reload` (fixed 22 Sept 2026)

A round runs for minutes after `/round` returned, so the host's catch around command handlers does
not cover it. Three things make a reload safe now: every wait in `runPhase` registers a settle
function in a module-level `pending` set, and `session_shutdown` settles them all with `RELOADED`
instead of leaving a 20-minute timer to fire into a dead activation; `runPhase`, `announce` and every
post-`await` point in `round()` check `dead` before touching `ctx`; and both command sites go through
`launch()`, whose `.catch` is the only one the promise has. Also fixed in the same block: the reply
listener is subscribed *before* its timer is armed (a throw from `pi.events.on` used to leave a timer
reaching for an unassigned unsubscriber), and a phase that times out now calls `stopAgent` rather
than merely forgetting an agent that is still running.

### The critic contract (fixed 22 Sept 2026)

The critic's verdict words are machine-read, and `agents/critic.md` now says so: each finding's
verdict line starts with `CONFIRMED`/`PLAUSIBLE`/`REJECTED`, the capitalised words appear nowhere
else, and the output ends with `TALLY: confirmed=N plausible=N rejected=N`. `tally()` takes the TALLY
line as the authority and otherwise counts only lines that *start* with a verdict — the first
version matched anywhere, case-insensitively, so "nothing was confirmed" and the critic's own bottom
line inflated the count and could start a dev round with nothing to fix. `surviving()` hands the
next dev round the critique **minus its REJECTED blocks**; it used to receive the whole text under
"findings to address", rejected ones included. Both are exported and tested in
`tests/round-tally.test.mjs`. Also: `running` is now claimed *before* the readiness await, so two
commands in that window can no longer share one round's state; `parse()` and `round()` apply the
same default when `"panel": []`; the critic prompt says how many reviewers there were.

## Invariants a future change must not break

1. **Every bus emit goes through `emit()`**, and every other use of the captured `pi`/`ctx` from an
   async continuation is behind `if (dead)`. A raw `pi.events.emit` in a timer or a `.then` is a
   session-killer after shutdown.
2. **No `await` between a `subagents:completed`/`failed` event and the `subagents:rpc:consume`
   emit.** The 200 ms nudge hold is the whole reason that emit is where it is.
3. **Roles stay model-free.** Adding `model:` to an agent file would not even win — the spawn option
   outranks it — but it would make `rounds.json` a lie.
4. **`failed()` must keep treating an empty result as a failure**, or empty reviews reach the critic.
5. **The panel can only shrink.** `panel = configured.slice(0, max(1, min(configured.length, seats)))`
   — `--reviewers 3` against a two-seat config still runs two. Seats are never invented.
6. **Every spawned agent goes through `runPhase`**, so it lands in `live` and `/round stop` can reach
   it.
7. **The critic's verdict vocabulary is load-bearing.** `verdictLine` and the early-exit check both
   grep for CONFIRMED; rewording `agents/critic.md` without updating `count()` makes every round
   report "no findings" and kills multi-round mode silently.
8. **One round at a time.** `running` is a module-level singleton and `round()` refuses re-entry;
   the `finally` must always clear it, or the command is dead for the session.

## Gotchas

- **`/reload` can kill a round mid-phase.** pi-subagents calls `manager.abortAll()` on
  `session_shutdown` (it changed from `waitForAll()` precisely so the process can exit), so a reload
  aborts every running subagent. The round's promises are orphaned, `dead` stops them taking Pi down
  with them — but no report is written and no verdict is posted. Do not `/reload` to pick up an edit
  while a round is running.
- `timeoutMinutes` in `rounds.json` does nothing (see Configuration). The real limit is
  `SPAWN_TIMEOUT_MS`.
- `/round` needs `@tintinweb/pi-subagents`; the readiness ping gives it **1 second** to answer. On a
  loaded machine a slow session start can read as "not installed".
- Reports are keyed to `ctx.cwd`, so `/rounds` in a different directory shows nothing.
- `/rounds` labels are built from the first four lines of each report and `ctx.ui.select` matches the
  chosen *string* back to its file — two reports with an identical label would collide.
- A round that is stopped still writes its report; `broken` deliberately counts 0 failed phases when
  cancelled, because a stopped phase is not a broken one.
- Each failed seat gets exactly one retry, and the retry's outcome replaces the original in the
  report — a seat that failed twice shows only the second failure.
- `--reviewers` is clamped to 5, but so is `--rounds`; `--rounds 5` with a 2-seat panel is up to 20
  subagent runs against your cluster.

## Related

- [[endpoints]] — where the models named in `rounds.json` actually live, and whether they are up
- [[statusbar]] — consumes the `round` slot and its `details()`
- [[fleet]] — the subagent list; `/attach` can watch a round's phases while they run
- [[../architecture/pi-internals]] — cross-extension RPC, the 200 ms nudge hold, `deliverAs: "followUp"`
- `agents/critic.md` (repo, not vault) — defines the CONFIRMED / PLAUSIBLE / REJECTED vocabulary this
  file counts; `agents/dev.md` and `agents/reviewer.md` are the other two roles
