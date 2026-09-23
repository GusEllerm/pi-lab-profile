# pi-lab-profile

A [Pi](https://pi.dev) profile built for running a coding agent against your own inference
endpoints: a right-hand status column instead of a crowded footer, an interactive subagent list you
can **attach** to, and a `/round` command that puts a change through **dev → review → critique**
with each role on a different model.

Built against **Pi 0.86.1** and verified on **0.87.0** on macOS.

```bash
pi install git:github.com/GusEllerm/pi-lab-profile
```

That installs the extensions. Two things Pi's package manifest cannot carry — the agent roles and
your endpoint config — come from one script:

```bash
git clone https://github.com/GusEllerm/pi-lab-profile && cd pi-lab-profile
scripts/install.sh example     # roles + a rounds.json template to edit
```

Then add `"tuiMode": "fullscreen"` to `~/.pi/agent/settings.json` — the column needs it, because
regular mode draws into the terminal's own scrollback and has no layout root to rebuild.

## What you get

| Command | What it does |
|---|---|
| `/round <task>` | dev implements, a reviewer panel reads the diff, a critic verifies the review. Writes `.pi/rounds/<timestamp>.md` |
| `/round --rounds 2 <task>` | hands what survived the critic back to dev and goes again |
| `/review [focus]` | review the working tree as it stands, no dev phase |
| `/rounds` | past reports; pick one to pull back into the conversation |
| `/round status` · `/round stop` | where a run is, and how to end it |
| `/fleet` · `/attach` | the subagent list; **Enter attaches** — the transcript becomes that agent's, typing steers it, esc detaches |
| `/agent-model` | move a *running* subagent to another endpoint mid-run |
| `/endpoints` | which clusters are live, queued or cold, and which model a provider will really hit |
| `/status` · `/sidebar` | the dashboard, and the column on/off |
| `/open` | everything substantial from the session — reasoning, bash runs, diffs, writes — in full, in a picker; hand off to `$EDITOR` |
| `/pin` | the pinned copy of your last message above the transcript, on/off |
| `/images` | keep only the newest N images in context |
| `/mcp` | MCP servers started for this session and their tools — Pi has no MCP of its own; this profile adds it |
| `/hpc` | the hpc-bridge session: facility, block, spend. A billed block needs your confirmation in a dialog; headless sessions cannot start one |
| `/argo` · `/argo on` · `/argo down` | Argonne's Argo gateway (frontier models, metered) through argo-tools' tunnel: status; run `argo-up` with the Duo prompt relayed into the chat; run `argo-down` |

### The review panel

`/round` runs the reviewer role **twice, on different weights**, and shows both to the critic. Two
copies of one model share their blind spots; a second seat that differs only by endpoint mostly
buys redundancy against a flaky gateway, which the retry logic already handles.

Which model each role uses is `rounds.json` — project `.pi/rounds.json` first, then
`~/.pi/agent/rounds.json`:

```json
{
  "dev": null,
  "panel": [
    { "label": "reviewer A", "model": "openai/gpt-5" },
    { "label": "reviewer B", "model": "anthropic/claude-sonnet-5" }
  ],
  "critic": "google/gemini-3-pro"
}
```

A seat with no model inherits the session's. A model this machine cannot resolve is dropped and
that seat falls back to the inherited one, so a config written for someone else's cluster degrades
instead of failing. The role files in `agents/` carry no model pin — this file is the only place
endpoints are decided, which works because a spawn-time model option outranks agent frontmatter.

### Choosing reviewer models

From a bake-off on three diffs (two planted bugs, one clean change, every claim re-run against the
code) on one lab's gateway, as a shape to expect rather than a ranking to copy:

- The accuracy that matters is on the **clean** diff. A reviewer that invents defects wastes more
  time than one that finds none.
- One 675B model produced four high-confidence false findings and was dropped. A 31B model was as
  accurate as a 120B and six times faster.
- Size predicted depth of explanation, not correctness.

Run your own before trusting any model in the critic seat.

### Argo: frontier models, metered

With [argo-tools](https://github.com/GusEllerm/argo-tools) set up, `extensions/argo.ts` registers what
the Argo gateway serves as two providers: `argo/<claude-…>` over the Anthropic API (thinking levels
and cache accounting survive the proxy) and `argo-openai/<gpt-…|gemini-…>` over chat completions —
de-duplicated, test and embedding models dropped, frontier models first. The tunnel is never
opened on its own: `/argo on` runs `argo-up` inside a pseudo-terminal and turns the Duo prompt
into a dialog in the chat (type `1`, approve the push); `/argo down` runs `argo-down`. While the
session model is on Argo the column's `ENDPOINT` row reads `⚡ argo` in a warning colour, because
Argo is metered and argo-proxy may log every request body on a shared node — see the setup guide.
`/round` does not use Argo by default for the same reason.

### MCP servers as tools

`extensions/mcp.ts` starts every server named in `~/.pi/agent/mcp.json` or a project `.pi/mcp.json`
over stdio, registers its tools with Pi under `<server>_<tool>` using the server's own schemas, and
turns any resource you name into a skill. The lab config ships
[hpc-bridge](https://github.com/globus-labs/hpc-bridge) — drive a supercomputer from the session:
find a facility, log in to Globus once, start a billed block, run commands on it, release it. It
needs `uv` on `PATH`; the Globus Labs cluster is in its public registry as a multi-user endpoint, so
it attaches with no SSH. `extensions/hpc-bridge.ts` adds what the plugin has on no host: a billed
block is started only after you confirm it in a dialog naming the facility, partition and account
(headless sessions cannot start one), inline credentials are refused on the shell tools, and the
column shows the facility, block state and spend while connected.

```json
{ "servers": { "hpc": { "command": "uvx", "args": ["--from", "git+https://github.com/globus-labs/hpc-bridge", "hpc-bridge"],
                        "skills": [{ "uri": "hpcbridge://guidance/operations", "name": "driving-hpc" }] } } }
```

## Layout

```
extensions/     statusbar · fleet · rounds · endpoints · outputs · mcp · hpc-bridge · argo · code-panels · image-window
agents/         dev · reviewer · critic — no model pins, portable
profiles/lab/   one lab's setup: models.json (SSH-tunnelled vLLM + ALCF gateway), mcp.json (hpc-bridge), bin helpers
profiles/example/  a rounds.json template
scripts/        install.sh (roles + profile) · check.sh (parse + boot guard)
docs/           full setup guide, including the endpoint and tunnel work
```

## Compatibility

These extensions use two Pi internals deliberately: the viewport's private `layoutRoot` (to put a
column beside the transcript) and the markdown renderer's `renderToken` (to draw code blocks
without ``` fences). **Both are checked before use** — if a Pi release changes their shape, that
feature switches itself off and the rest of the session is untouched.

`scripts/check.sh` parses every extension and boots Pi once, requiring a reply. Run it after any
edit, and after any Pi upgrade; CI runs the parse half and the unit tests on every push, and a weekly
job installs the current Pi and pi-cc to run the three upstream canaries — a failing canary means
upstream fixed a bug this profile works around, and the workaround should be deleted.

## Requires

- Pi ≥ 0.86.0
- [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) for `/round` and `/fleet`,
  with `"widgetMode": "off"` and `"fleetView": false` in `~/.pi/agent/subagents.json` — this profile
  replaces both of its panels. A **project** `.pi/subagents.json` overrides the global one; if the
  old widget reappears, that is why, and `/fleet takeover` fixes it.
- `pi-cc-extensions` is optional but assumed by the screenshots (collapsed thinking, compact tool rows).

## Developing it

The author's own machine runs the profile *from this working tree*, so there is one copy of
everything and no sync step:

```bash
pi install ~/Projects/pi-lab-profile          # extensions load from the tree, not a copy
rm ~/.pi/agent/extensions/{statusbar,fleet,rounds,endpoints,outputs,code-panels,image-window}.ts
ln -sf "$PWD"/agents/{dev,reviewer,critic}.md ~/.pi/agent/agents/
ln -sf "$PWD"/profiles/lab/rounds.json ~/.pi/agent/rounds.json
```

On a fresh clone, `npm ci` first (the MCP bridge has a runtime dependency; `pi install` does this
for users). Then edit → `scripts/check.sh` → `/reload` → it is live. Commit and push to publish.

The catch is that a broken edit breaks your running Pi, because there is no staging copy — so run
the guard *before* reloading, not after. To check what a stranger actually gets, install the
published package into a throwaway agent dir instead of your own:

```bash
PI_CODING_AGENT_DIR=/tmp/pi-clean pi install git:github.com/GusEllerm/pi-lab-profile
PI_CODING_AGENT_DIR=/tmp/pi-clean pi
```

## Documentation

`pi-lab-profile-vault/` is an Obsidian vault holding the cross-session memory for this project: one
note per extension, the reverse-engineered internals of pi/pi-tui/pi-cc that several extensions
depend on, and the investigations behind the less obvious code. Start at `00-start-here.md`.

Every note that documents a source file records that file's git blob hash, so drift is detectable
rather than assumed:

```bash
bash scripts/check-docs.sh          # ok / STALE per note, with the diff command to run
bash scripts/check-docs.sh --fix    # re-record hashes once a note has been brought up to date
```

`STALE` means the code moved under the note, not that the note is wrong — read the diff before
trusting the prose.

## License

MIT.
