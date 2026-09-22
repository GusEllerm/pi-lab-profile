# Start here

This vault is the cross-session memory for **pi-lab-profile**: a customised profile for the Pi coding
agent, used to run a research lab's work across a local Slurm cluster and several ALCF clusters.

If you are an agent picking this project up cold, read this note, then the note for whatever you are
about to touch. Fifteen minutes here saves a day of rediscovery — most of what is written down was
learned the expensive way.

## What the project is

A Pi profile that adds four things to a stock Pi session:

| | |
|---|---|
| **A right-hand status column** | model, context, endpoint, agents, token totals, plus a pinned copy of your last message — [[extensions/statusbar]] |
| **A subagent fleet** | live roster, attach to a running subagent and watch it work, per-agent model selection — [[extensions/fleet]] |
| **Review rounds** | dev → review panel → critic, deliberately spread across different clusters and models so the reviewers are not the dev — [[extensions/rounds]] |
| **An output picker** | `/open` lists reasoning, bash runs, diffs and writes from the session, in full — [[extensions/outputs]] |

Plus [[extensions/mcp]] (MCP servers as Pi tools — Pi has none built in; the lab config ships
hpc-bridge), [[extensions/hpc-bridge]] (an enforced spend gate and an HPC row for it),
[[extensions/endpoints]] (inference endpoints and their health), [[extensions/code-panels]]
and [[extensions/image-window]].

## Where things live

```
~/Projects/pi-lab-profile/          the repo — public, github.com/GusEllerm/pi-lab-profile
  extensions/*.ts                   the extensions, listed in package.json under "pi".extensions
  agents/{dev,reviewer,critic}.md   subagent definitions
  profiles/lab/rounds.json          the round config that ships with the profile
  tests/                            node --test; includes the upstream canaries
  scripts/check.sh                  parse + boot guard (CI runs --parse-only)
  scripts/check-docs.sh             are these vault notes still current?
  pi-lab-profile-vault/             you are here
```

The machine loads the profile **from this working tree**, via `pi install ~/Projects/pi-lab-profile`.
So an edit to `extensions/*.ts` is live at the next `/reload` — there is no build step and no copy to
keep in sync. Two consequences worth internalising:

- `~/.pi/agent/extensions/` is **empty by design**. If you find yourself editing files there, you are
  in the wrong place.
- `~/.pi/agent/agents/{dev,reviewer,critic}.md` and `~/.pi/agent/rounds.json` are **symlinks** into
  this repo. Editing either edits the repo.

Third-party extensions live alongside, installed as npm packages in `~/.pi/agent/npm/`:
`pi-cc-extensions` (the Claude-Code look, and the source of several bugs documented here),
`@tintinweb/pi-subagents` (what the fleet drives), `pi-agent-browser-native`, and an ask-user plugin.

## Before you change anything

**Check the notes still describe the code.** Every note that documents a source file carries that
file's git blob hash:

```bash
bash scripts/check-docs.sh          # ok / STALE per note
bash scripts/check-docs.sh --fix    # after you have re-read and updated a note
```

A `STALE` line means the code moved under the note. It does not mean the note is wrong, only that it
is unverified — read the diff it prints before trusting the prose.

**Run the tests.** `npm test`. Three of them are [[architecture/upstream-workarounds|canaries]] that
assert an upstream bug is *still present*; if one fails, upstream fixed something and a workaround
here should be deleted rather than repaired.

## The invariants that bite

These are not style preferences. Each one is a bug that already happened, twice in some cases.

1. **Anything that can run after `session_shutdown` must not touch the captured `pi` or `ctx`.**
   `/reload` replaces the activation; every getter on the old context then throws. A throw inside a
   *slash-command handler* is caught by the host — but a throw from a timer, a process or event
   callback, a render, or a promise nobody awaits is not, and pi has **no `unhandledRejection`
   handler**, so it exits the process. Timers must be cleared on shutdown, pending waits settled,
   process listeners removed, fire-and-forget promises given a `.catch`, and every continuation
   must check `dead` first. This killed sessions twice, and the 22 Sept review found four more
   instances — `tests/shutdown-discipline.test.mjs` now pins the guards.

2. **A wrapper installed on an object that outlives the activation must be installed once, ever.**
   The TUI, the transcript document and `Text.prototype` all survive `/reload`. Versioning a wrapper
   and re-installing a new version *stacks* it on the old one — four reloads put every message behind
   four nested wrappers and made the profiler itself the slowest thing in the session. Install once,
   tag the wrapper so it cannot wrap itself, and route counters through a shared sink that each
   activation repoints. See [[investigations/scroll-lag-2026-09]].

3. **Never call an expensive function from a memo key.** The sidebar's cache key runs on every frame,
   including on a hit. An early version called each slot's `details()` from the key, which built the
   agent rows through `Intl.Segmenter` — making the memo slower than no memo at all.

4. **Prefer measuring to reasoning.** This codebase has burned eight plausible, confidently-argued
   hypotheses that measurement then killed. `/prof` exists for this; use it before theorising.

## Working notes

- **Architecture of the host**: [[architecture/pi-internals]] — how pi-tui's layout and render caching
  actually work, who invalidates what, how pi-cc patches the TUI. Reverse-engineered; you will need it
  before changing anything in the layout.
- **Upstream bugs and the workarounds carried here**: [[architecture/upstream-workarounds]].
- **The scroll-lag investigation**: [[investigations/scroll-lag-2026-09]] — worth reading as method,
  not just conclusion.
- **hpc-bridge as a packaged tool**: [[investigations/hpc-bridge-integration]] — what the plugin is,
  what Pi offers to meet it, three options and a recommendation. Nothing built yet.
- **Full review, 22 Sept 2026**: [[investigations/review-2026-09-22]] — five highs, seventeen mediums,
  every one verified against the code, and all closed the same day except one unverified low. Read
  it for the host facts it established and for the shape of the bugs this codebase tends to grow.

## Conventions for this vault

- One note per source file, named after it, with `source:` and `source-hash:` frontmatter.
- **Reference code by symbol name, never by line number.** Line numbers rot within a session.
- Record *why*, not *what*. The code says what it does; the note should say what it cost to learn.
- When you fix something the hard way, add it to the investigation notes. The trail is the value.
