# HPC: supercomputers as tools, with a spend gate

[hpc-bridge](https://github.com/globus-labs/hpc-bridge) lets an agent drive a supercomputer: find a
facility, log in to Globus once, start a compute block, run commands on it, release it. It is an
MCP server, and Pi connects MCP servers itself from `~/.pi/agent/mcp.json`. The lab profile ships
the entry:

```json
{ "mcpServers": { "hpc": { "command": "uvx", "args": ["--from", "git+https://github.com/globus-labs/hpc-bridge", "hpc-bridge"],
                           "exposure": "direct", "timeout": 180 } } }
```

It needs `uv` on `PATH`. The Globus Labs cluster is in hpc-bridge's registry as a multi-user
endpoint, so it attaches with no SSH; the first time, a Globus login opens in your browser. To
start, ask the agent: *"What HPC facilities can I use?"*

## What the harness adds

hpc-bridge's own spend gate is a parameter the model is trusted to set only after asking you.
On Pi nothing enforces that, so the harness does:

- **A billed block starts only after you confirm a dialog** naming the facility, partition and
  account. A block that may have idled out (no news within the facility's idle window) asks again
  before restarting. Polling while a block provisions does not ask. Headless sessions (`pi -p`)
  cannot start one at all unless `PI_HPC_HEADLESS_SPEND=allow` is set deliberately.
- **A credential guard** refuses commands on hpc-bridge's remote shells that look like they carry
  an inline secret, and local `bash` commands that carry a literal one.
- **An `HPC` row** in the column while a facility is connected: the facility, the block's state and
  how long it has been warm, partition and account, node-hours spent. `/hpc` has the full picture.
- **hpc-bridge's own guidance**, the `driving-hpc` skill, loaded from the installed hpc-bridge — a
  new release reaches the agent the next time `uvx` installs it.

| command | |
|---|---|
| `/hpc` | facility, block, spend, and how to release the block |
| `/mcp` | Pi's MCP servers, their state and tools |

Remember to release a block when you are done (`mcp__hpc__stop_endpoint`, or ask the agent): it
charges the allocation until it is released or idles out.
