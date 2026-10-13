# Development: how it is built, and working on it

## Layout

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
  lib/          what more than one extension needs: bus (the event names and payload types),
                lifecycle (the shutdown guard), paths (the agent dir, reading JSON)
agents/         dev · reviewer · critic — roles with no model pins
profiles/lab/   the Globus Labs config: models.json, mcp.json, rounds.json, subagents.json,
                header.json, pi-cc-extensions.json, bin/ (globus-tunnel, alcf-token)
profiles/example/  the same shape for everyone else, with no lab endpoints
scripts/        install.sh · check.sh · check-docs.sh · tui-smoke.py · liveness-replay.mjs ·
                make-banner.py · make-bundle.sh + bundle-install.sh (docs/no-node.md)
docs/           these pages, the setup guide and runbook, the upstream bug reports
pi-lab-profile-vault/  the project's memory (below)
```

Extensions talk to each other through Pi's event bus — the column is a set of slots the others
publish into — so most can be removed without touching the rest. The event names and what rides
on each are `extensions/lib/bus.ts`; an emit or a listener that disagrees with it is a type
error. The one direct import between extensions: `argo` borrows `outputs`' pager for `/argo spend`.

Anything that can still run after `session_shutdown` — a timer, a promise continuation, an event
handler — must not touch the captured `pi` or `ctx` without a guard: after `/reload` every ctx
getter and `pi.events.emit` throw, and from a timer that is an uncaughtException that takes Pi
down. `extensions/lib/lifecycle.ts` is the guard: `const life = lifecycle(pi)` at the top of the
factory, then `life.dead()`, `life.emit()`, `life.alive(ctx)`, `life.onShutdown()`. A test fails
if an extension grows its own copy.

## What it depends on

- **Two Pi internals, on purpose:** the viewport's `layoutRoot`, to put the column beside the
  transcript, and the markdown renderer's `renderToken`, to draw code panels. Both are checked
  before use; if a release changes them, that feature switches itself off and the rest of the
  session is untouched.
- **Three upstream behaviours it works around:** pi-tui's hstack measures the transcript at one
  width and renders it at another, pi-tui's text cache holds one width at a time, and pi-cc's
  tool hover hit-tests at the terminal's full width. Together they made scrolling stall with the
  column up. `/compat` says which workarounds are active, and a weekly CI job installs the current
  Pi and pi-cc and runs a **canary** per behaviour: a failing canary means upstream fixed it and the
  workaround should go. Write-ups ready to file upstream: [upstream-hover-width.md](upstream-hover-width.md).
- **pi-subagents runs every extension again, in-process, for each subagent.** So an extension's
  factory must not take process-global state or block on the network; the ones that need either
  do it once per process or only in the activation that has a UI.

## Working on it

The author's machine runs the harness straight from this working tree — one copy, no sync step:

```bash
pi install ~/Projects/pi-lab-profile
ln -sf "$PWD"/agents/{dev,reviewer,critic}.md ~/.pi/agent/agents/
for f in rounds.json mcp.json header.json; do ln -sf "$PWD/profiles/lab/$f" ~/.pi/agent/$f; done
```

Edit → `scripts/check.sh` → `/reload` in Pi → live. A broken edit breaks your running Pi, because
there is no staging copy, so run the check *before* reloading.

```bash
npm test                     # ~120 unit tests, plus the canaries when Pi and pi-cc are installed
bash scripts/check.sh        # parses; lockfile in sync; Pi boots and replies headless; the TUI comes up clean
bash scripts/check-docs.sh   # which vault notes have drifted from the code they describe
```

`check.sh`'s last two steps start the real Pi, so they need what a session needs: a default model
that answers (the lab profile's tunnel or an ALCF token; your own provider on the example
profile — [providers.md](providers.md)) and `"tuiMode": "fullscreen"` in `settings.json`. CI runs
only the first two steps (`--parse-only`). A `BOOT FAIL: No API key found` on a fresh checkout
is that, not a broken checkout.

`check.sh`'s lockfile step exists because CI's `npm ci` refuses a lockfile out of sync with
`package.json`, and nothing else run locally would notice. After changing `package.json`:
`npm install --package-lock-only --ignore-scripts`.

To see what a newcomer gets, install the published package into a throwaway agent directory:

```bash
PI_CODING_AGENT_DIR=/tmp/pi-clean pi install git:github.com/GusEllerm/pi-lab-profile
PI_CODING_AGENT_DIR=/tmp/pi-clean pi
```

The pinned versions of Pi, pi-cc-extensions and pi-subagents are written in four places — the
top of `scripts/make-bundle.sh`, the README, `agent-setup.md` and `setup-guide.md` — and
`tests/versions.test.mjs` fails if they disagree, so an upgrade changes all four.

Upgrading Pi or a package: stage the new version in a scratch prefix and a scratch
`PI_CODING_AGENT_DIR` first, run the canaries, `check.sh` and a session against it, and only then
install for real — the vault's `investigations/review-2026-10-12.md` is a worked example.

## The vault

`pi-lab-profile-vault/` is an Obsidian vault holding the project's memory across sessions: one
note per extension, the reverse-engineered internals of Pi, pi-tui and pi-cc that several
extensions depend on, and the investigations behind the less obvious code. Start at
`00-start-here.md`. Each note records the git hash of the file it documents, so drift is
detectable rather than assumed:

```bash
bash scripts/check-docs.sh          # ok or STALE per note, with the diff command to run
bash scripts/check-docs.sh --fix    # re-record hashes once a note has been brought up to date
```

`STALE` means the code moved under the note, not that the note is wrong — read the diff before
trusting the prose.
