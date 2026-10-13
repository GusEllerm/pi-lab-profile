---
source: extensions/header.ts
source-hash: 51475e51fd43996758612a8d20a63d47987d8afe
documented: 2026-10-12
---

# header.ts — the startup header, from a file you edit

Asked for on 12 Oct 2026: the block Pi opens with (logo, `pi v1.1.0`, key hints, "There are many
agent harnesses, but this one is yours.") should be editable. That block was **pi-cc's**, not
Pi's: `feature/shell/startup-header.ts` in pi-cc-extensions hard-codes the logo and the tagline and
offers only `showStartupHeader` on/off. Pi's extension API replaces the header with
`ctx.ui.setHeader(factory)`, so this extension does that, from JSON.

## What it owns

- **The file.** `headerPath(cwd)`: `<cwd>/.pi/header.json` if present (a project's, e.g. a demo
  directory), else `<agent-dir>/header.json`. With neither, the slot is left alone and the stock
  header shows. On this machine `~/.pi/agent/header.json` is a symlink to
  `profiles/lab/header.json`, like `rounds.json` and `mcp.json`, so edits are versioned;
  `scripts/install.sh lab` copies it for everyone else. `readHeader` validates and returns an error
  that names the file and the field; a bad file is reported once at startup and the stock header
  stays.
- **The markup.** `renderMarkup`: `{style:text}` (nestable) with any theme colour name or
  `bold`/`italic`; `{name}` values — `version` (Pi's exported `VERSION`), `model`, `provider`,
  `endpoint` (the short label endpoints.ts publishes on `statusbar:endpoint-labels`), `thinking`,
  `cwd`, `branch` (read from `.git/HEAD` once, no subprocess), `user`, `host`, `date`, and `hints`
  (Pi's compact key hints from `getKeybindings()` in pi-tui, so a rebinding shows). Backslash
  escapes braces. An unknown colour draws plain; an unknown value stays as written, so a typo is
  visible where it is.
- **The layout.** `layout`: art in the left column, lines beside it, vertically centred, one blank
  row above and below; under `artWidth + gap + 24` columns the art moves above the lines.
- **Colours and layout** (12 Oct 2026, for the lab wordmark). `#rrggbb` works wherever a colour
  does (`hexColor`: a 24-bit foreground with a default-foreground reset, so it nests);
  `artColors` colours the art row by row, the last repeating; `"layout": "stacked"` puts the art
  above the lines (the default `"beside"` still stacks under `artWidth + gap + 24` columns). Art
  wider than the terminal is dropped, not truncated — a wordmark cut mid-letter reads as noise.
- **The lab header** (`profiles/lab/header.json`) is the Globus cluster's login banner from
  `globus-admin/roles/motd/templates/00-globus-banner.j2`: the six-row "ANSI Shadow" GLOBUS
  wordmark and its gradient `42;120;214` → `27;175;122` (the Grafana dashboards' two hues), with
  `H  A  R  N  E  S  S` in place of `C  L  U  S  T  E  R` — the same 19 characters, so it sits where
  the original did. The rows and colours were copied from the template programmatically, not
  retyped; a test pins the subtitle, the end colours and the width (51 columns).
- **`/header`** (status, the style and value lists, a warning if pi-cc's header is on),
  **`/header reload`** (re-read after an edit), **`/header init`** (write the starter, which
  reproduces the old header, to `<agent-dir>/header.json` if absent), **`/header off`**.

## Why it is shaped this way

- **pi-cc's header must be off.** Both set the header at `session_start`; with pi-cc's on, its
  handler runs after this one and wins (measured: the replacement never appeared). With
  `"showStartupHeader": false` the replacement is in place **from the first frame** (0.68–0.88 s
  after launch, Pi 1.1.0) — Pi paints after `session_start`, so there is no flash of another
  header. pi-cc reaches the first frame by patching `InteractiveMode.prototype.init`; that was not
  needed here, so this extension touches no host internals. It warns once if pi-cc's is on.
- **Render is cached** by width, model and endpoint label: the header draws every frame, and the
  rows change only with those.
- **No subprocess, no network**: the branch comes from `.git/HEAD`, the rest from memory.

### 13 Oct 2026 review

`agentDir()` and the endpoint-label map are the shared ones (`lib/paths.ts`, `lib/bus.ts`); the `dead` flag is `lib/lifecycle.ts`. The example profile now ships a `header.json` (the `STARTER` design, a test keeps them equal), so a non-lab install opens with Pi's mark, the model and the endpoint instead of the built-in header.

## Invariants

- With no `header.json`, never call `setHeader` — leave whatever header is there.
- A bad file must never blank the header: report it, keep the stock one.

## Verified

`tests/header.test.mjs` (5): markup (nesting, values, escapes, typos), layout (beside, stacked,
empty), the starter, the file lookup and validation, the branch. Live on the real setup: the first
frame showed this header; editing the tagline to `{date}`/`{user}@{host}`/`{branch}` and running
`/header reload` changed it in place.

## Related

[[statusbar]] · [[endpoints]] (the `{endpoint}` label) · [[../00-start-here]]
