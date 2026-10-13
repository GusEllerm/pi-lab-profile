# Command reference

Every command the harness adds. Pi's own (`/model`, `/resume`, `/tree`, …) are in Pi's
documentation; pi-subagents adds `/agents`, and pi-cc adds `/ccstyle` and `/context`.

| command | what it does | more |
|---|---|---|
| `/endpoints` | every inference machine, probed live, one folder each; Enter on a model switches to it | [endpoints](endpoints.md) |
| `/status` · `/status off` · `on` | the dashboard; turn the footer off or on | [observability](observability.md) |
| `/sidebar on` · `off` · `<cols>` · `auto` · `min <cols>` | the status column | [observability](observability.md) |
| `/pin on` · `off` | the pinned last message | [observability](observability.md) |
| `/stuck` | every agent's phase, its wait, and what that wait usually takes | [observability](observability.md) |
| `/fleet` · `/fleet takeover` | the agent list; turn pi-subagents' own widget off for this project | [agents](agents-and-rounds.md) |
| `/attach [agent]` · `/attach main` | attach to a subagent; detach | [agents](agents-and-rounds.md) |
| `/agent-model [agent] [provider/model]` | move a running subagent to another endpoint | [agents](agents-and-rounds.md) |
| `/open [text]` | reasoning, bash output, diffs and writes from the session you are looking at | [agents](agents-and-rounds.md) |
| `/round <task>` · `--rounds N` · `--reviewers N` | dev → review panel → critic | [rounds](agents-and-rounds.md#review-rounds) |
| `/round status` · `/round stop` | where a round is; end it | [rounds](agents-and-rounds.md#review-rounds) |
| `/review [focus]` | review the working tree, then verify the review | [rounds](agents-and-rounds.md#review-rounds) |
| `/rounds` | past reports; bring one back into the conversation | [rounds](agents-and-rounds.md#review-rounds) |
| `/argo` · `up` · `down` · `spend` · `check` · `reload` | Argo: status and spend; open or close the tunnel; argo-dash's report; probe which models answer; re-read the catalogue | [argo](argo.md) |
| `/hpc` | the hpc-bridge session: facility, block, spend | [hpc](hpc.md) |
| `/mcp` | Pi's MCP servers, their state and tools | [hpc](hpc.md) |
| `/header` · `reload` · `init` · `off` | the startup header | [customising](customising.md) |
| `/images [n]` | images in context; send at most *n* | [customising](customising.md) |
| `/compat` · `/prof` · `/hover` | which upstream workarounds are active; what the column costs per frame; pi-cc hover mode | [observability](observability.md#diagnostics) |
