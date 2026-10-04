---
source: extensions/liveness.ts
source-hash: 46a416e9e4d7479b21d581b38ed2148db4bee45d
documented: 2026-10-04
---

# liveness.ts — "is this agent stuck?", answered with evidence

Built 4 Oct 2026 for a question the user kept asking by hand: is the primary, or a subagent,
stuck, or just slow? The answer is a verdict per agent — `ok`, `slow`, `stalled`, `looping`,
`waiting` — with the phase it is in, how long since the last sign of progress, and what that wait
usually takes. Nothing is ever aborted from here.

## The model

An agent that looks stuck is in a phase, and each phase has its own normal wait:

| phase | progress is | judged by |
|---|---|---|
| `thinking` | the first token | `ttft:<provider>` |
| `streaming` | each token | `gap` (between tokens) |
| `tool` | a `tool_execution_update`, or the result | the tool's own name |
| `waiting-human` | the user (a question tool, or any UI dialog — `ui_prompt_start/end`) | never stuck |
| `waiting-agent` | another agent (`Agent`, `get_subagent_result`, …) | that agent's own row |
| `queued` | a concurrency slot (pi-subagents) | never stuck |

`LivenessModel` keeps `phase`, `since`, `lastProgress`, the running tools, a ring of the last eight
tool-call signatures (`name + JSON(args)`), and a dialog depth. `verdict(now)` compares the right
gap — the wait for a first token, the gap since the last token, or the *run time* of the
longest-running tool (not its last update: a tool that streams output for an hour is still an
hour-long tool) — with two lines from `thresholds(q, kind)`: `slow = max(2·p95, floor)`,
`stalled = max(2·p99, floor, slow+10)`. Floors (seconds): tool 10/60, first token 20/60, token gap
15/30. `observe()` maps Pi's events onto the model, and the same function serves the primary
(through `pi.on`) and subagents (through `session.subscribe` on pi-subagents' in-process session,
found via `Symbol.for("pi-subagents:manager")`).

## Where the numbers come from, and how much to trust them

**Priors are measurements.** `PRIORS` was computed on 4 Oct 2026 from 427 recorded sessions
(56,420 message entries) by pairing each tool call's assistant message with its result, and each
request's start (the message's own timestamp) with its appended time:

| wait | p50 | p95 | p99 | max |
|---|---|---|---|---|
| bash | 0 s | 4.7 s | 45 s | 9428 s (a hang) |
| agent_browser | 0.2 s | 16 s | 37 s | 100 s |
| hpc run_shell | 5 s | 120 s (its sync-wait cap) | 121 s | 123 s |
| globus reply, under 100 output tokens (≈ first-token ceiling) | 5 s | 12 s | 31 s | — |
| globus generation | — | — | 9 tok/s at p5 | — |
| ALCF first token | ≈1 s | 4 s | 7 s | — |

A total reply time is *not* a signal — it scales with output size (globus: 5k+ tokens take 325 s at
p50) — which is why the model judges gaps, never totals.

**They keep learning.** Every completed wait goes into a `Timings` reservoir per key (200 samples);
p95/p99 are read from it once it holds 20, the prior until then, a default (tool 10/60, first
token 15/45) for the unknown. Reservoirs persist in `<agent-dir>/cache/liveness.json`, so the
second session already knows what `mcp__hpc__run_shell` takes here.

**The false-alarm rate is measured, not hoped for.** `scripts/liveness-replay.mjs` runs the same
model over the recorded sessions and reports, per tool, how many completed runs would have been
called stalled before they finished. With priors only: bash 0.6% of 20,740 runs (0.3% learning),
edit/read/write/grep/ls/find 0%, agent_browser 0.3%, and the runs it names are the hangs — 2.6 h,
2.25 h, 69 min. "Stalled" therefore means "has outlasted twice the worst of a hundred normal runs
of this very tool", and the row says so. Replay cannot judge the thinking and streaming phases
(session files hold no first-token time); those thresholds rest on the measured first-token
ceiling, with a one-minute floor so a shared GPU's queue is not an alarm.

## Surfaces

- **The column**: a `LIVENESS` row under AGENTS, hidden while everything is `ok`/`waiting`; `warn`
  for slow, `error` for stalled or looping; the dashboard shows it always.
- **Fleet's rows**: each running agent carries `⏳ slow · …` or `⚠ stalled · …` after its activity
  line, from the `liveness:agents` event, and the agents slot rows carry the same mark.
- **`/stuck`**: every agent — phase, wait, the usual times with their source (learned/prior/default),
  the slow and stalled lines — and what to do: steer with `@name`, stop with `x` in the list,
  `/argo check` for an Argo model that answers nothing.
- **One notification per episode** when something turns stalled or looping; cleared when it
  recovers, so a long stall is said once, not every two seconds.

A 2 s ticker runs only while something is active and stops itself when nothing is.

## Invariants a future change must not break

- Judge gaps, never totals. A long reply is long because it is long.
- Human and agent waits are never stuck, and a UI dialog overrides every other phase.
- Priors are measurements with a date; change them by re-running the measurement, and keep the
  replay script's numbers in this note current.
- The ticker is dead-guarded like fleet's: an emit after `/reload` must not throw from a timer.

## Verified

`tests/liveness.test.mjs` (9): thresholds and floors, the reservoir and its persistence,
every phase's lines, the longest-tool rule, human/agent/dialog waits, the loop run, queued/done,
`observe()`'s event mapping, and the extension's once-per-episode notice. Replay as above.

## Related

[[statusbar]] · [[fleet]] · [[argo]] (the empty-stream case is a stall with a known cause) · [[../00-start-here]]
