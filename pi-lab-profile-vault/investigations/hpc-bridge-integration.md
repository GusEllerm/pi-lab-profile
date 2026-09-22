---
documented: 2026-09-22
status: A + C built (extensions/mcp.ts) and B built (extensions/hpc-bridge.ts); all verified live. Open upstream ask: a read-only endpoint_status tool, so block liveness can be polled without spend
sources: hpc-bridge repo at ~/Projects/hpc-bridge (main, plugin 0.1.17), its vault, and the hpc-bridge Claude session's inventory; Pi 0.87.0 docs and types
---

# Packaging hpc-bridge into this profile

**Question.** hpc-bridge lets an agent drive a supercomputer — find a facility, log in to Globus once,
start a billed one-node block, run commands on it, release it. It ships as a Claude Code plugin. Can
this Pi profile carry it as one of its packaged tools?

**Answer.** Yes, and more cleanly than it first looks, because the plugin is a thin Claude-Code
wrapper around a **standard stdio MCP server**. Pi has no MCP support of its own — deliberately
(`usage.md`: "intentionally does not include built-in MCP … build or install those as extensions or
packages") — but its extension API has `pi.registerTool()`, and a Pi package's `package.json`
`dependencies` are installed by `pi install`. So the work is an MCP client living in this profile,
not a port of hpc-bridge.

## What hpc-bridge is, exactly

| | |
|---|---|
| Server | Python ≥ 3.11, FastMCP (`mcp>=1.28.1,<2`), stdio. `uvx --from git+https://github.com/globus-labs/hpc-bridge hpc-bridge` runs it with nothing cloned; only `uv` is needed locally. |
| Tools (12) | `list_facilities`, `connect_facility`, `authenticate`, `complete_login`, `complete_preauth`, `ensure_endpoint_up`, `run_shell`, `poll_task`, `reset_session`, `login_shell`, `stop_endpoint`, `teardown_endpoint` — reference in `docs/hpc-bridge-vault/Reference/The MCP tools.md` |
| Resource | `hpcbridge://guidance/operations` — the `driving-hpc` SKILL.md served verbatim, so hosts without a skill system get the same guidance |
| Claude-only parts | `.claude-plugin/*`, `.mcp.json` with `${CLAUDE_PLUGIN_*}` substitution, `commands/hpc-connect.md`, the skill's *loading*, `hooks/credential-guard.sh` (a PreToolUse grep that refuses tool inputs containing `password=`/`api_key=`/`secret=`/`token=`) |
| Spend gate | **A tool parameter**, not a hook or MCP elicitation: `ensure_endpoint_up(account, partition, confirm_spend=True)`. The agent is expected to ask the user first, guided by the skill. Survives any host — but nothing *enforces* it on a host without permission popups. |
| State | `HPC_BRIDGE_USER_DIR` (Globus Compute SDK storage, tokens with refresh — one consent per install), `HPC_BRIDGE_STATE_DIR` (pins, facility cache, SSH control sockets). Needs `HOME`. |
| Network | HTTPS to Globus Auth/Compute/Search, AMQP to Compute; SSH to a login node only for SSH-type facilities; a localhost loopback for the browser login. |
| Registry today | NCSA Delta (MEP), Purdue Anvil, SDSC Expanse (SSH), **Globus Labs cluster (MEP)** |

That last row matters for this lab: the cluster is already catalogued as a multi-user endpoint, so it
attaches with **zero SSH and no bootstrap** — the facility maps the Globus identity to the local
account. The tunnel this profile maintains for *inference* is unrelated; hpc-bridge is for *compute*.

## What Pi offers to meet it

- `pi.registerTool({ name, label, description, parameters, execute, promptSnippet?, promptGuidelines? })`
  — `parameters` is TypeBox, and **`Type.Unsafe(jsonSchema)` accepts the server's `inputSchema`
  unchanged** (verified against Pi's bundled TypeBox 1.3.27: `Value.Check` validates it). No
  hand-written schemas; the tool list is read from `tools/list` at startup.
- `execute(toolCallId, params, signal, onUpdate, ctx)` returns `AgentToolResult`; MCP `tools/call`
  text content maps onto it directly. hpc-bridge sends no progress notifications, so `onUpdate` is
  unused. `signal` can cancel a call (kill nothing server-side; hpc-bridge's own timeouts apply).
- Async extension factories are awaited before `session_start`, so the server can be spawned and
  its tools listed before the first prompt.
- `resources_discover` returns `skillPaths`: an extension can advertise a SKILL.md it wrote at
  startup. `pi.on("tool_call")` can **block** a call — the credential guard ports to ~15 lines.
- `@modelcontextprotocol/sdk` (1.30.0 on npm) has a stdio client transport; as a `dependencies`
  entry it is installed by `pi install` for git and npm installs alike.

## Options

### A · A generic MCP bridge (`extensions/mcp.ts`)

Reads `~/.pi/agent/mcp.json` and project `.pi/mcp.json` (`servers: { name: { command, args, env,
cwd } }`), spawns each server over stdio at startup, registers every tool as `<server>_<tool>` with
its schema passed through, forwards calls, and offers `/mcp` (status, restart, list tools). Any
resource named in config becomes a skill via `resources_discover`.

*For:* it is the feature Pi lacks and that every other host has; hpc-bridge is then a config entry,
and so is the next server. *Against:* a generic bridge is where scope creep lives (sampling,
elicitation, roots, notifications); keep the first version to tools + resources.

### B · An hpc-bridge layer on top of A (`extensions/hpc-bridge.ts`)

- **A host-level spend gate.** Intercept `ensure_endpoint_up` with `confirm_spend: true` and require
  `ctx.ui.confirm("Start a billed block on <facility> · <partition> · <account>?")` before the call
  goes through. hpc-bridge's gate trusts the model to ask; this one does not have to. It is the
  strongest reason to build B at all.
- **The credential guard**, as a `tool_call` handler over `bash`, `run_shell` and `login_shell`.
- **An `HPC` slot in the column** — facility, endpoint phase, block elapsed — published on the
  `statusbar:slot` bus like `round` and `agents` are.
- **Config for the lab**: `profiles/lab/mcp.json` with the `uvx` command and env
  (`HOME`, `HPC_BRIDGE_USER_DIR`/`STATE_DIR` under `~/.pi/agent/hpc-bridge/`), installed by
  `scripts/install.sh lab` next to `models.json` and `rounds.json`.

### C · Guidance delivery

Fetch `hpcbridge://guidance/operations` at startup, write it to a cache dir as
`driving-hpc/SKILL.md`, advertise the path via `resources_discover`. The guidance then tracks the
server version with nothing vendored. Fallback when the server is unreachable: a vendored copy in
`skills/driving-hpc/` with a canary test that diffs it against upstream, the way the upstream
workarounds are watched.

## Recommendation

**A + C first, B second.** A and C together are the whole of "hpc-bridge works in Pi" — perhaps
400 lines plus tests, with the SDK's in-memory transport making the bridge testable without a
Python server. B is where this profile adds something the plugin does not have on any host: an
enforced spend gate. Build it once A is exercised against the real cluster.

## Risks and unknowns

- **Twelve tool schemas in every prompt.** Register lazily — only when an `mcp.json` names the
  server — and consider a `/hpc off` that unregisters. Measure the prompt cost before deciding.
- **macOS local-dev path.** hpc-bridge's *own* endpoint daemon is Linux-only; on a Mac the
  registry's MEP facilities (the Globus Labs cluster included) need nothing local, and a BYO
  endpoint needs `HPC_BRIDGE_ENDPOINT_ID`. Not a blocker for this lab.
- **Long calls.** `run_shell` waits synchronously up to `HPC_BRIDGE_SYNC_WAIT_S` (120 s) and then
  returns a `task_id` for `poll_task`. Fine under Pi; the abort signal should not be confused with
  releasing the block.
- **The browser login** happens on the machine running Pi. Over SSH to a headless box that means
  paste mode (`complete_login`).
- **The generic bridge is a second MCP client in the lab's tooling** — worth a look at whether the
  `pi-cc`/`pi-subagents` ecosystem already has one before writing it.

## Read first, in hpc-bridge

`docs/hpc-bridge-vault/Happy path.md` → `docs/hpc-bridge-vault/Reference/The MCP tools.md` →
`docs/user/other-hosts.md` → `docs/hpc-bridge-vault/Reference/Plugin packaging.md`. Live state is
`HANDOFF.md` at that repo's root; the hpc-bridge Claude session on this machine answers questions
from the repo and can be messaged from here.
