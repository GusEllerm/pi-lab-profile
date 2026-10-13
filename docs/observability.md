# Watching the agent: the status column and stuck detection

## The status column

In fullscreen mode, on a terminal 72 columns or wider, a column sits beside the transcript in
place of Pi's crowded footer. Each section is a slot another part of the harness publishes into,
and the optional ones appear only while they have something to say.

| section | shows |
|---|---|
| `CONTEXT` | percentage and tokens left; a sparkline of the past minute; when it is filling steadily, a countdown (`22k/min · full ~12m`) |
| `AGENTS` | running subagents, with tokens, context and elapsed time |
| `LIVENESS` | only when something is slow, stalled or looping — see below |
| `MODEL` | the model and its thinking level |
| `ENDPOINT` | the endpoint behind it, ✓ or ✗ from its last reply; `⚡ argo` on Argo |
| `IMAGES` | images in context, when there are any |
| `ROUND` | the phase of a running `/round` |
| `HPC` | the hpc-bridge facility, block state, time warm and node-hours |
| `USAGE` · `TOTAL` | prompt and output tokens, cache hit rate, speed; dollars on Argo |

While you are attached to a subagent, the column shows that agent's numbers instead. The pinned
bar above the transcript holds your last message, so the question stays visible while you read
the answer; click it to jump back.

| command | |
|---|---|
| `/status` | the same picture as a dashboard; `e` opens `/endpoints`, `a` the agent list. `/status off` and `/status on` toggle the footer |
| `/sidebar on` · `off` · `<cols>` · `auto` · `min <cols>` | the column, its width, and the terminal width below which it hides |
| `/pin on` · `off` | the pinned message |

## Is it stuck? `/stuck`

An agent that looks stuck is always in some phase, and each phase has its own normal wait:

| phase | progress is | judged against |
|---|---|---|
| waiting for its first token | the first token | that endpoint's time to first token |
| streaming | each token | the usual gap between tokens |
| running a tool | the tool finishing | that tool's own history |
| waiting for you, or on a subagent | — | never stuck |
| queued behind the concurrency cap | — | never stuck |

A wait is **slow** past twice its 95th percentile and **stalled** past twice its 99th, with floors
so a quick tool is not flagged at ten seconds. The same call returning the same result three times
in a row is **looping**; tools whose job is to poll are exempt.

The usual times are measured, not guessed: the priors come from 427 recorded sessions, then each
tool and endpoint is learned as you work and kept in `~/.pi/agent/cache/liveness.json`.
`scripts/liveness-replay.mjs` replays the model over your own history and reports the false-alarm
rate those lines would have had — for `bash`, 0.6% of runs, and the runs it flags are the real
hangs.

Nothing is shown while things are fine. When they are not, a `LIVENESS` row appears, fleet rows
carry `⏳` or `⚠`, and you get one notice per episode. `/stuck` shows every agent's phase, its wait,
what that wait usually takes and the lines it is judged against. Nothing is ever aborted for you.

## Diagnostics

| command | |
|---|---|
| `/prof` | what the column costs per frame, since the last `/prof`: frames, milliseconds, cache hits, slow frames |
| `/compat` | which of the three upstream workarounds are active, and why |
| `/hover auto` · `on` · `off` | pi-cc's tool-hover mode (`auto` suppresses it while the column is up) |
