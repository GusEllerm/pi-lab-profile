---
source: extensions/hpc-bridge.ts
source-hash: d311a6a2148137059b0aa83197ab7e9a01be2ac6
documented: 2026-09-22
---

# hpc-bridge.ts — the enforced spend gate, the credential guard, and the HPC row

What this profile adds on top of [[mcp]] for one server. hpc-bridge can allocate a **billed** compute
block on a supercomputer; its own gate is the tool parameter `ensure_endpoint_up(confirm_spend=True)`,
which on Claude Code a skill tells the model to ask about first. Nothing enforces that on any host,
and Pi has no permission popups. This does. Built 22 Sept 2026 as option B of
[[../investigations/hpc-bridge-integration]].

## What it owns

- **The spend gate.** A `tool_call` handler: `<prefix>ensure_endpoint_up` with `confirm_spend: true`
  reaches the server only after `ctx.ui.confirm` names the facility, partition and account. Declined
  → blocked with a reason that tells the model not to retry unasked. **Headless sessions block it
  outright** unless `PI_HPC_HEADLESS_SPEND=allow` — verified live: a `pi -p` asked to call it with
  `confirm_spend=true` was blocked inside Pi; nothing reached the server.
- **The credential guard.** hpc-bridge's `hooks/credential-guard.sh` pattern
  (`(password|api[_-]?key|secret|token)\s*[=:]`, case-insensitive) refuses `bash`, `run_shell` and
  `login_shell` commands that carry an inline secret. `TOKEN_FILE=` passes; `TOKEN=` does not.
- **The `hpc` slot.** `tool_result` events for `<prefix>*` tools are parsed with `parseResult` (the
  first JSON object in the text — hpc-bridge returns its pydantic models as JSON) and folded by
  `applyResult` into a state shaped after `EndpointStatus`, `ConnectFacilityResult` and
  `ShellOutcome`: facility, status/phase, block state, session spend, partition, account, notice,
  and when the block went warm. `describe` returns two forms: `column` — three or four rows of at
most ~21 cells (facility; `status · warm 5m`; `partition · account`; `0.30 node-h`) — and `full`,
which adds the server's `notice` and the release hint, for `/hpc`. The notice is prose written for
the model; in the column it wrapped into seven rows cut mid-word, which is why it is not there.
`describe` turns the state into the column's HPC row — hidden until a
  facility is connected, `busy` while a block is warm or provisioning, `warn` on `needs_*`,
  `draining`, `tearing_down`, `error` on `failed`. `/hpc` prints the same.
- **The tool prefix follows `mcp.json`** (`hpcPrefix`): the server whose command mentions
  `hpc-bridge`, honouring a custom or empty `prefix`.

### The gate keys on provisioning, not on the flag (22 Sept 2026)

The first version gated only `confirm_spend: true`. That covers the *first* allocation and nothing
after it: once spend is acknowledged, hpc-bridge keeps `spend_confirmed` for the session
(`warmth.py:194–204`), and every later `_provision` — from `ensure_endpoint_up` with any flag, or
from `run_shell`, which provisions on its way to running (`_ensure_warm_runner`) — re-allocates a
billed block if the current one is cold, with no flag in sight. So the question is now "could this
call provision?": an explicit `confirm_spend: true`, **or** any provisioning call on a non-login
shape after spend was confirmed this session when the block is not provably warm within the idle
window. The dialog then says *Restart*, names how long since the last news, and explains that the
block may have idled out. Fresh warmth (a warm result within `IDLE_S`, 600 s) lets commands flow
without asking.

**Warmth has a TTL.** There is no read-only status probe in hpc-bridge: `ensure_endpoint_up` runs a
canary task on every call (`force_canary=True`) and re-provisions a cold block once spend was
confirmed; block state is in the server's memory only; a released block is discovered only by the
next call. So the row treats "warm" as a fact that ages out after the facility's idle window — it
turns `warn` and reads `warm? no news 12m` — rather than polling something that spends. The honest
fix is upstream: a read-only `endpoint_status` tool (~30 lines in `server.py`) reporting the
in-memory runtime; the hpc-bridge session confirmed both the gap and the fix, and it is Gus's call.

`server down Nm` (error) appears when the bridge's heartbeat loses the server.

## Invariants a future change must not break

- **It never talks to the server.** Everything is observed through Pi's `tool_call` and
  `tool_result` events, so it cannot be out of step with what the model actually did.
- **A blocked call is blocked before execution** — that is what `ToolCallEventResult.block`
  means. The reason string is what the model reads, so it says what to do instead.
- Every emit goes through the dead-checked `emit()`; the handlers themselves are host-invoked.

## Gotchas

- `warmSince` is a timestamp: test it for presence, not truth. The first version used `?` and a
  test with `warmSince: 0` caught it before it mattered.
- `describe` reads `block_state` off run_shell/poll_task results too, so the row stays right
  between endpoint calls; an errored result is ignored, so a failed call does not paint a false state.
- The spend dialog can only show a facility once `connect_facility` has returned; before that it
  says "not yet connected", which is itself worth seeing.
- The idle row is not shown in the column (like ROUND); the dashboard lists it always.

## Related

[[mcp]] · [[statusbar]] · [[../investigations/hpc-bridge-integration]]
