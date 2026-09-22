---
source: extensions/hpc-bridge.ts
source-hash: fbacff84e149d39c810a8feeac19362e04d34bfc
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
  and when the block went warm. `describe` turns that into the column's HPC row — hidden until a
  facility is connected, `busy` while a block is warm or provisioning, `warn` on `needs_*`,
  `draining`, `tearing_down`, `error` on `failed`. `/hpc` prints the same.
- **The tool prefix follows `mcp.json`** (`hpcPrefix`): the server whose command mentions
  `hpc-bridge`, honouring a custom or empty `prefix`.

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
