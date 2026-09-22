---
source: extensions/mcp.ts
source-hash: 8d31dee967ec6d2be82beac18548d63debc6fdb9
documented: 2026-09-22
---

# mcp.ts — MCP servers as Pi tools

Pi has no MCP support of its own, deliberately. This is the extension its docs say to write instead.

## What it owns

Every server named in `~/.pi/agent/mcp.json` (global) and `<cwd>/.pi/mcp.json` (project, winning
per server name) is started over **stdio** when the session starts, its tools are registered with
Pi as `<server>_<tool>`, calls are forwarded, and any resource the config names is written to
`~/.pi/agent/cache/mcp/<server>/<skill>/SKILL.md` and advertised as a skill through
`resources_discover`. The lab profile ships one server: hpc-bridge (`profiles/lab/mcp.json`, installed
by `scripts/install.sh lab`), twelve tools and the `driving-hpc` guidance as a skill. Built 22 Sept
2026 as the proof of concept from [[../investigations/hpc-bridge-integration]].

## Commands

| command | what it does |
|---|---|
| `/mcp` | every connected server: tool count, skills, uptime, command; problems listed with `!` |
| `/mcp tools <server>` | that server's registered tool names |

## Modules

- **`readConfig(cwd)`** — both files merged; a broken file throws with its own path in the message.
  Exported, tested.
- **`start(name, spec)`** — `StdioClientTransport` + `Client` from `@modelcontextprotocol/sdk`
  (a `dependencies` entry, so `pi install` installs it). `HOME` is always passed; `~` in `env` and
  `cwd` expands. `tools/list` → one `pi.registerTool` per tool with **the server's `inputSchema`
  passed through `Type.Unsafe`** — Pi validates with `Value.Check`, which accepts JSON Schema, and
  the model sees the schema unchanged. Nothing is transcribed by hand. `promptSnippet` is the first
  line of the description, so the tool appears in the system prompt's tool list.
- **`execute`** — `callTool` with the per-server `timeoutMs` (default 120 s) and Pi's abort signal;
  content flattened by `flattenContent` (text joined, images noted); a server-side `isError` is
  flagged, not swallowed. A failed server's tools report "not connected" rather than throwing.
- **Skills** — `readResource` → `skillText` adds frontmatter only if the resource lacks it
  (hpc-bridge's already carries `name`/`description`) → written to the cache → the path is returned
  from `resources_discover`.
- **Startup** — the default export is `async`: Pi awaits it before `session_start`, so every tool
  exists before the first prompt. Servers start in parallel; one that cannot start is recorded and
  shown by `/mcp` and in the `session_start` notice, never fatal.

### Heartbeat (22 Sept 2026)

Every 30 s (`PI_MCP_PING_MS`) each server gets a protocol-level `ping` — the one liveness check
that costs a server nothing and touches nothing behind it. A server that stops answering is marked
`down`: `/mcp` says `DOWN since …`, its tools return an error naming the time instead of hanging,
and `mcp:server {name, up, since}` goes out on the bus (which is how [[hpc-bridge]]'s row shows
`server down`). It comes back the same way. The ticker is cleared on `session_shutdown` — a timer
is the one thing here that would outlive the activation. **This is process liveness only**: it
says nothing about a compute block behind hpc-bridge, which has no read-only status tool.

## Invariants a future change must not break

- **`session_shutdown` closes every client and clears `live`.** The child processes belong to the
  activation; a tool registered by a dead activation must not forward to a client whose owner is
  gone. A `/reload` therefore restarts the servers (hpc-bridge: ~5 s via `uvx`).
- **Tools look up the client through `live` at call time**, never through a closure captured at
  registration — so a closed client is "not connected", not a stale handle.
- **The schema is the server's.** Do not hand-write TypeBox for a specific server here; a
  server-specific layer (the planned hpc-bridge spend gate) belongs in its own extension.

## Gotchas

- Tests must override `HOME`: `readConfig` reads the global file, and on this machine it is a
  symlink to the lab config, so an un-isolated test starts the real hpc-bridge — it did, and
  registered twelve real tools inside a test that expected none.
- Twelve tool schemas ride in every prompt while hpc-bridge is configured. Not measured yet; if it
  matters, register lazily or add a `/mcp off`.
- No sampling, elicitation, roots or notifications. hpc-bridge needs none; the next server might.

## Verified

`tests/mcp-bridge.test.mjs` drives a real stdio fixture server (`tests/fixtures/mcp-echo-server.mjs`)
through a fake `pi`. Live: a headless `pi -p` asked to call `hpc_list_facilities` answered
`delta, globus-labs, anvil, expanse`; the guidance skill materialised with its frontmatter.

## Related

[[../investigations/hpc-bridge-integration]] · [[statusbar]] (a future `HPC` slot) · [[../architecture/pi-internals]]
