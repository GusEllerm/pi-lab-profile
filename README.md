```
 ██████╗ ██╗      ██████╗ ██████╗ ██╗   ██╗███████╗
██╔════╝ ██║     ██╔═══██╗██╔══██╗██║   ██║██╔════╝
██║  ███╗██║     ██║   ██║██████╔╝██║   ██║███████╗
██║   ██║██║     ██║   ██║██╔══██╗██║   ██║╚════██║
╚██████╔╝███████╗╚██████╔╝██████╔╝╚██████╔╝███████║
 ╚═════╝ ╚══════╝ ╚═════╝ ╚═════╝  ╚═════╝ ╚══════╝
                H  A  R  N  E  S  S
```

# Globus Harness

**A coding agent for research computing.** Globus Harness turns [Pi](https://pi.dev), an open,
extensible terminal coding agent, into one harness across the inference and compute a research lab
actually has: the lab's own GPUs, the ALCF inference gateway, Argonne's Argo gateway for frontier
models, and supercomputers through [hpc-bridge](https://github.com/globus-labs/hpc-bridge). It
shows you, all the time, which endpoint you are talking to, what it costs, and whether anything is
stuck — and it never spends an allocation or opens a tunnel without you.

It is a Pi package (this repository, `pi-lab-profile`) plus one lab's configuration (Globus Labs).
The extensions work with any Pi provider; the lab config is the part you swap.

Verified on **Pi 1.2.0** on macOS (12 Oct 2026) with pi-cc-extensions 1.0.2, pi-subagents 0.21.0,
pi-agent-browser-native 0.9.5 and rpiv-ask-user-question 2.13.8.

---

## Where it sits

Vendor harnesses such as Claude Code and Codex are built around one family of models, with one
price and one trust boundary in mind. A research lab's reality is different. Inference comes from several
places at once, each with its own latency, cost and trust:

| | where it runs | what it is like |
|---|---|---|
| **Lab GPUs** | a vLLM server on the Globus Labs cluster, through an SSH tunnel | private and unmetered, one model shared by the whole lab |
| **ALCF gateway** | Argonne's inference service on Minerva, Metis and Sophia | institutional access, many open-weight models, a *cold* model can take minutes to start |
| **Argo** | Argonne's gateway to Claude, GPT and Gemini, through a Duo-protected tunnel | frontier quality, **metered**, prompts may be logged on a shared node |
| **HPC** | any facility in hpc-bridge's registry, via Globus Compute | real compute, **billed** by the node-hour |

Pi is the right base for that: small, open, model-agnostic, with an extension API that can
replace its layout, register providers at runtime and gate tool calls. Globus Harness is built on
that API — no fork — so it upgrades with Pi. Where it relies on a Pi internal it checks the shape
before use, and where it works around an upstream bug a CI canary says when the bug is fixed.

What it adds falls into four kinds:

- **Visibility.** A status column beside the transcript: context left and how fast it is filling,
  the model, the endpoint and whether its last reply worked, tokens and dollars, running agents,
  the HPC block. `/endpoints` probes every machine live. `/stuck` says whether a wait is normal.
- **Many models, deliberately.** Subagents you can watch, attach to, steer and move between
  endpoints mid-run; a `/round` that sends a change through dev → a two-model review panel → a
  critic, each role on a different model.
- **Consent around anything that costs.** Billed HPC blocks need your confirmation in a dialog;
  the Argo tunnel opens only when you say `/argo up`; metered models are badged `⚡`; headless runs
  cannot spend.
- **Measured, not guessed.** Liveness thresholds come from hundreds of recorded sessions and keep
  learning; Argo spend uses argo-dash's own price table; workarounds for upstream bugs carry
  canary tests that fail the day the bug is fixed.

What it is not: a hosted service, or a finished product. It is one lab's working harness, written
down carefully enough that another lab can take it.

---

## Getting started

The [setup guide](docs/setup-guide.md) is the long form of every step below, written so that **a
coding agent can do the setup for you**: hand it the file and your machine. What follows is the
short version.

### 1. What you need

- macOS or Linux, Node.js ≥ 22.19, `python3`, `curl`
- [`uv`](https://docs.astral.sh/uv/) on `PATH` if you want hpc-bridge
- a terminal with truecolour (iTerm2, kitty, WezTerm, Ghostty, …); the status column appears at 72
  columns and up, and is comfortable from about 120

### 2. Install Pi and the two packages the harness builds on

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.2.0
pi install npm:pi-cc-extensions@1.0.2          # Claude Code-style transcript: compact tool rows, collapsed thinking
pi install npm:@tintinweb/pi-subagents@0.21.0  # the Agent tool and subagents that /round and the fleet drive
```

Versions are pinned because Pi packages run with full access to your machine; each pin was
source-reviewed (no install scripts, no network calls) and the setup guide lists the integrity
hashes to check.

### 3. Install the harness and its configuration

```bash
pi install git:github.com/GusEllerm/pi-lab-profile
git clone https://github.com/GusEllerm/pi-lab-profile && cd pi-lab-profile
scripts/install.sh lab         # Globus Labs members: agent roles + the lab's endpoint, HPC and header config
scripts/install.sh example     # anyone else: agent roles + a rounds.json template to edit
```

The first line installs the extensions. The script adds what a package cannot carry — the agent
roles in `~/.pi/agent/agents/`, `models.json`, `mcp.json`, `rounds.json`, `subagents.json`,
`header.json` and two helper scripts — and never overwrites a file you already have.

Then, in `~/.pi/agent/settings.json`, add `"tuiMode": "fullscreen"` (the column needs it), and
create `~/.pi/agent/pi-cc-extensions.json` so pi-cc leaves the footer, pinned prompt and header to
the harness:

```json
{ "previewLines": 0, "enableCustomFooter": false, "stickyUserMessage": false, "showStartupHeader": false }
```

Finally put the `pi()` launcher function from [setup guide §6](docs/setup-guide.md) in your shell
rc: it opens the tunnel to the lab GPUs before Pi starts. For a demo, `PI_SKIP_VERSION_CHECK=1`
keeps Pi's "Update Available" box off the screen.

### 4. Get access to the endpoints you want

The configuration is ready for every endpoint the lab uses; what no script can give you is access.
Each is a credential only you can obtain, and the harness picks it up the moment it is in place.
None is required — `/endpoints` shows what is reachable.

| endpoint | what you set up | who grants it | check |
|---|---|---|---|
| **Globus Labs GPUs** (`globus/…`, the default) | a `Host globus1` block in `~/.ssh/config` with your cluster username and key; `ssh globus1 true` must succeed without a prompt (or set `GLOBUS_TUNNEL_HOST=<user>@<host>`) | a cluster account, from the lab | `pi --no-session -p "Reply with just: ok"` opens the tunnel and prints `ok` |
| **ALCF gateway** (`alcf-minerva/…`, `alcf-metis/…`, `alcf-sophia/…`) | `uvx alcf-ai auth login` once, in a browser; the refresh token lasts about six months idle. `models.json` fetches a fresh token per request, so nothing secret is stored in config | gateway access under your Globus identity, from ALCF | `alcf-token --status`, then `/endpoints` |
| **Argo** (`argo/claude-…`, `argo-openai/…`, metered) | `git clone https://github.com/GusEllerm/argo-tools && cd argo-tools && ./argo-setup`; the models are read from the live catalogue, nothing goes in `models.json` | a CELS account with an SSH key and Duo, plus Argo Gateway API authorisation from your division's AIOps representative (without it every reply is "ACCESS DENIED") | `/argo up`, type `1`, approve the Duo push; then `/argo` |
| **HPC** via hpc-bridge (compute, not inference) | `uv` on `PATH`; the server starts from `mcp.json` and asks for a Globus login in-session the first time | an allocation at the facility (the Globus Labs cluster needs only your account) | `/mcp`, then ask "what HPC facilities can I use?" |

### 5. Your first ten minutes

```bash
pi
```

1. The **GLOBUS HARNESS** header opens the session, with the model and endpoint under it. The
   column sits on the right; the pinned bar above the transcript will hold your last message.
2. `/endpoints` — every machine as a folder, each summarised (`3 live`, `11 live · 6 queued ·
   6 cold`). → opens one; Enter on a model switches to it.
3. Ask something that uses tools ("what does `extensions/liveness.ts` measure?") and watch the
   column: context filling, tokens per second, the endpoint's ✓.
4. `/review` on a working tree with changes: two reviewers on different models read the diff, a
   critic checks what they claimed, and the verdict comes back into the conversation.
5. While a subagent works, press ↓ on an empty prompt to focus it in the list under the editor,
   Enter to attach — the transcript becomes that agent's — and Esc to come back.
6. `/stuck` any time something feels slow.

---

## A tour of what it does

### See where your inference goes

Every reply comes from somewhere specific, and the harness never lets you lose track of where.

- **The status column** (fullscreen mode, 72 columns and up) replaces Pi's crowded footer:
  - `CONTEXT` — percentage and tokens left, a sparkline of the past minute and, when it is
    filling steadily, a countdown (`22k/min · full ~12m`)
  - `AGENTS` — running subagents with tokens, context and elapsed time
  - `MODEL` and `ENDPOINT` — the endpoint gets ✓ or ✗ from its last reply
  - `USAGE` and `TOTAL` — prompt and output tokens, cache hit rate, speed, and dollars on Argo
  - `IMAGES`, `ROUND` and `HPC` appear while they have something to say, and `LIVENESS` when
    something is slow
- **`/endpoints`** probes every provider at once and opens immediately, filling in as answers
  land: the lab GPU `up` or `absent`, each ALCF model `live`, `queued` or `cold` (a cold model
  starts on its first request, so expect a wait), Argo with its catalogue size. Models a cluster
  serves but your config does not declare are listed too.
- **`/status`** is the same picture as a dashboard; `e` and `a` jump to `/endpoints` and the
  agent list.

### Work with many agents

[pi-subagents](https://github.com/tintinweb/pi-subagents) supplies the `Agent` tool; the harness
gives it a control surface.

- **The fleet list** under the editor shows every subagent with its turns, tools, tokens, rate and
  what it is doing right now (`→ bash`). ↓ on an empty prompt focuses it; **Enter attaches** —
  the transcript and column become that agent's, and what you type steers it; `s` sends a single
  steering message; `m` moves it to another endpoint; Esc detaches.
- **`/agent-model`** moves a *running* subagent to a different endpoint mid-run — off a cold ALCF
  model, say, onto the lab GPU.
- **`/open`** lists everything substantial the agent you are looking at produced — reasoning,
  `!bash` runs, edits as diffs, writes — in full, in a picker, with a hand-off to `$EDITOR`. The
  transcript truncates long output; the session keeps it, and `/open` reads the session.

### Review with more than one model

`/round <task>` puts a change through three roles, each on a model chosen in `rounds.json`:

1. **dev** implements the task (on the session's model unless configured otherwise)
2. a **review panel** of two reviewers on *different weights* reads the diff — two copies of one
   model share their blind spots
3. a **critic** checks every finding against the code and discards what does not hold

The report goes to `.pi/rounds/<timestamp>.md` and its verdict into the session, so the main model
can act on it. `--rounds 2` hands what survived back to dev for another pass; `--reviewers 1`
uses one reviewer instead of the panel; `/review [focus]` skips dev and reviews the working tree; `/rounds` brings an old
report back.

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

That is the lab's `rounds.json`. A seat with no model inherits the session's, and a model this
machine cannot resolve falls back the same way, so a config written for another cluster degrades
instead of failing. The role files in `agents/` never pin a model; this file is the only place
endpoints are decided. `/round` deliberately does not use Argo, because Argo is metered.

From a bake-off on three diffs (two with planted bugs, one clean) on the lab's gateway — a shape to
expect, not a ranking to copy: accuracy on the **clean** diff matters most, because a reviewer
that invents defects costs more than one that finds none; one 675B model produced four
high-confidence false findings and was dropped; a 31B model was as accurate as a 120B and six
times faster. Run your own before trusting a model in the critic seat.

### Know when something is stuck

An agent that looks stuck is always in some phase — waiting for its first token, streaming,
running a tool, waiting for you, waiting on a subagent, queued — and each phase has its own normal
wait. The liveness extension judges each one against what *that* wait usually takes: **slow** past
twice its 95th percentile, **stalled** past twice its 99th, with floors. Three identical calls
returning the same result is **looping**; polling tools are exempt.

The usual times are measured: priors from 427 recorded sessions, then learned per tool and
endpoint and kept in `~/.pi/agent/cache/liveness.json`. `scripts/liveness-replay.mjs` replays the
model over your own history and reports the false-alarm rate (for `bash`: 0.6% of runs, and the
runs it flags are the real hangs). Nothing is shown while things are fine; a `LIVENESS` row, `⏳`
and `⚠` marks on the fleet rows, and one notice per episode appear when they are not. `/stuck`
shows every agent's phase with the evidence. Nothing is ever aborted for you.

### Frontier models when you need them: Argo

With [argo-tools](https://github.com/GusEllerm/argo-tools) installed, the harness registers what
Argo serves as two providers — `argo/<claude-…>` over the Anthropic API and
`argo-openai/<gpt-…|gemini-…>` over chat completions — de-duplicated, with test and embedding
models dropped and the frontier models first in `/model`.

- **The tunnel stays yours.** `/argo up` runs `argo-up` inside a pseudo-terminal and relays its
  Duo prompt into the chat (type `1`, approve the push); `/argo down` closes it. Nothing opens it
  on its own.
- **It is badged.** While you are on Argo, the column's endpoint reads `⚡ argo` in a warning
  colour: it is metered, and argo-proxy may log request bodies on a shared node.
- **Spend is priced like argo-dash prices it**, from the dash's own table. The `USAGE` row shows
  the session's dollars, `/argo` says them in words, and `/argo spend` opens the dash's report. The
  figure is marked `≈` because argo-proxy streams Claude's prompt tokens as zero; the harness puts
  Pi's estimate in their place, which also keeps the context gauge and auto-compaction working.
- **`/argo check`** finds models the catalogue lists but that no longer answer, and drops them
  from `/model`. It sends one billed token per model, so it runs only when you ask.

### Supercomputers as tools: hpc-bridge

Pi connects MCP servers itself (`~/.pi/agent/mcp.json`, `/mcp`). The lab config ships
[hpc-bridge](https://github.com/globus-labs/hpc-bridge), which lets the agent find a facility, log
in to Globus once, start a compute block, run commands on it and release it. The Globus Labs
cluster is in its registry as a multi-user endpoint, so it attaches with no SSH.

The harness adds what hpc-bridge has on no host:

- **A spend gate that is enforced, not requested.** A billed block starts only after you confirm a
  dialog naming the facility, partition and account; a block that may have idled out asks again
  before restarting; headless sessions cannot start one.
- **A credential guard** on the shell tools, refusing commands that carry a literal secret.
- **An `HPC` row** in the column with the facility, the block's state and how long it has been
  warm, and the node-hours spent.
- **The plugin's own guidance**, the `driving-hpc` skill, loaded from the installed hpc-bridge
  itself — a new release reaches the agent the next time `uvx` installs it.

### And the smaller things

- **Your own header.** The wordmark at the top is `~/.pi/agent/header.json` (a project's
  `.pi/header.json` wins, which suits a demo directory). Lines take `{style:text}` with any theme
  colour or `#rrggbb`, and live values — `{model}` `{endpoint}` `{version}` `{branch}` `{date}`
  `{hints}` and more. Edit, then `/header reload`; `/header init` writes a starter. The lab's is
  the Globus cluster's login wordmark, same glyphs and gradient, reading HARNESS.
- **Code blocks as panels** — tinted, labelled with their language, without the ``` fences Pi
  otherwise prints.
- **`/images <n>`** keeps only the newest *n* images in what is sent, so screenshots do not eat the
  context window.
- **Pasting** from terminals that drop bracketed-paste markers lands in the editor as one block
  instead of sending every line as its own prompt.
- **`/pin`** toggles the pinned copy of your last message above the transcript; clicking it jumps
  back to where you asked.

---

## Command reference

| command | what it does |
|---|---|
| `/endpoints` | every inference machine, probed live, one folder each; Enter on a model switches to it |
| `/status` · `/status off` | the dashboard; turn the footer off or on |
| `/sidebar on` · `off` · `<cols>` · `auto` · `min <cols>` | the status column |
| `/pin on` · `off` | the pinned last message |
| `/fleet` · `/fleet takeover` | the agent list; turn pi-subagents' own widget off for a project |
| `/attach [agent]` · `/attach main` | attach to a subagent; detach |
| `/agent-model [agent] [provider/model]` | move a running subagent to another endpoint |
| `/open [text]` | reasoning, bash output, diffs and writes from the session you are looking at |
| `/round <task>` · `--rounds N` · `--reviewers N` | dev → review panel → critic |
| `/round status` · `/round stop` | where a round is; end it |
| `/review [focus]` | review the working tree, then verify the review |
| `/rounds` | past reports; bring one back into the conversation |
| `/stuck` | every agent's phase, wait, and what that wait usually takes |
| `/argo` · `up` · `down` · `spend` · `check` · `reload` | the Argo gateway: status and spend; open or close the tunnel; argo-dash's report; probe which models answer; re-read the catalogue |
| `/hpc` | the hpc-bridge session: facility, block, spend |
| `/mcp` | Pi's MCP servers, their state and tools |
| `/header` · `reload` · `init` · `off` | the startup header |
| `/images [n]` | how many images are in context; send at most *n* |
| `/compat` · `/prof` · `/hover` | diagnostics: which upstream workarounds are active, what the column costs per frame, pi-cc hover mode |

---

## How it is built

```
extensions/
  statusbar     the column, footer, pin bar, /status; three upstream workarounds
  header        the startup header from header.json
  endpoints     /endpoints, endpoint labels and the ENDPOINT row
  fleet         the agent list, attach and steer, /agent-model
  rounds        /round, /review, /rounds
  outputs       /open
  liveness      phase-aware stuck detection, /stuck
  argo          Argo providers, the tunnel and Duo relay, spend
  hpc-bridge    the spend gate, credential guard, HPC row and skill for hpc-bridge
  paste-guard   unbracketed pastes
  code-panels   code blocks without fences
  image-window  /images
agents/         dev · reviewer · critic — roles with no model pins
profiles/lab/   the Globus Labs config: models.json, mcp.json, rounds.json, subagents.json, header.json, bin/
profiles/example/  a rounds.json template for everyone else
scripts/        install.sh · check.sh (parse, lockfile, boot) · check-docs.sh · liveness-replay.mjs
docs/           the setup guide; the upstream bug reports
pi-lab-profile-vault/  the project's memory: one note per extension, Pi internals, investigations
```

Extensions talk to each other through Pi's event bus — the column is a set of slots the other
extensions publish into — so most can be removed without touching the rest (the one direct
import: `argo` borrows `outputs`' pager for `/argo spend`).

Three features depend on behaviour in Pi's UI layer and pi-cc that is arguably a bug: the
transcript is measured at one width and rendered at another, pi-tui's text cache holds one width
at a time, and pi-cc's hover hit-tests at the terminal's full width. The harness works around
each one, `/compat` reports which workarounds are active, and a weekly CI job installs the
current Pi and pi-cc and runs a **canary** per bug: a failing canary means upstream fixed it and
the workaround should go. The details are in [docs/upstream-hover-width.md](docs/upstream-hover-width.md).

---

## Requirements and compatibility

- Pi ≥ 1.1.0 (pi-subagents 0.20 and later require it); verified on 1.2.0
- [pi-subagents](https://github.com/tintinweb/pi-subagents) for the fleet and `/round`, with
  `"widgetMode": "off"` and `"fleetView": false` in `~/.pi/agent/subagents.json`, since the harness
  replaces both panels. A project `.pi/subagents.json` overrides the global one; if the old widget
  reappears, that is why, and `/fleet takeover` fixes it.
- [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) is optional but assumed by the
  look. From 0.9 it draws its own footer, pinned prompt and header; the config in step 3 hands
  those to the harness.
- Two Pi internals are used on purpose — the viewport's `layoutRoot`, to put the column beside the
  transcript, and the markdown renderer's `renderToken`, to draw code panels. Both are checked
  before use; if a release changes them, that feature switches itself off and the rest of the
  session is untouched.

---

## Developing

The author's machine runs the harness straight from this working tree, so there is one copy of
everything and no sync step:

```bash
pi install ~/Projects/pi-lab-profile
ln -sf "$PWD"/agents/{dev,reviewer,critic}.md ~/.pi/agent/agents/
for f in rounds.json mcp.json header.json; do ln -sf "$PWD/profiles/lab/$f" ~/.pi/agent/$f; done
```

Then: edit → `scripts/check.sh` → `/reload` in Pi → live. A broken edit breaks your running Pi,
because there is no staging copy, so run the check *before* reloading. It parses every extension,
checks that the lockfile matches `package.json` (CI's `npm ci` refuses otherwise), and boots Pi
once, requiring a reply.

```bash
npm test                     # ~100 unit tests, plus the upstream canaries when Pi and pi-cc are installed
bash scripts/check.sh        # parse, lockfile, boot
bash scripts/check-docs.sh   # which vault notes have drifted from the code they describe
```

To see what a newcomer gets, install the published package into a throwaway agent directory:

```bash
PI_CODING_AGENT_DIR=/tmp/pi-clean pi install git:github.com/GusEllerm/pi-lab-profile
PI_CODING_AGENT_DIR=/tmp/pi-clean pi
```

## Documentation

- [docs/setup-guide.md](docs/setup-guide.md) — the full setup, written for a coding agent to follow:
  Pi, the tunnel, `models.json`, the packages, each endpoint, acceptance tests, troubleshooting,
  and how to undo it all
- `pi-lab-profile-vault/` — an Obsidian vault, the project's memory across sessions: one note per
  extension, the reverse-engineered internals of Pi, pi-tui and pi-cc that several extensions
  depend on, and the investigations behind the less obvious code. Start at `00-start-here.md`.
  Each note records the git hash of the file it documents, so `scripts/check-docs.sh` can tell you
  when the code has moved under it.

## License

MIT.
