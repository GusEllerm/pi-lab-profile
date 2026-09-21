---
source: extensions/code-panels.ts
source-hash: a3374cbf5c9026a36554b9336e0a0a7f93225f1e
documented: 2026-09-20
---

# code-panels.ts — fenced code blocks drawn as tinted panels instead of literal ``` fences

## What it owns

One monkey-patch: `Markdown.prototype.renderToken` from pi-tui, applied to `code` tokens only and
delegating everything else untouched. Pi's Markdown renderer hard-codes the fence lines (pi-tui
`components/markdown.js`, `case "code"`), and markdown *transformers* run before rendering, so
there is no supported hook that can remove them — patching the renderer is the only route.

Output per block: a header line carrying the language label, then syntax-highlighted code with a
one-column inset, every line padded to full width over a theme background colour. The tint is a
background, not gutter characters, so copying a selection yields clean code.

Display-only. The session file and the model's context keep the original Markdown.

## Commands

| command | what it does |
|---|---|
| — | none; the extension registers no commands and no statusbar slot |

Tuning is by editing the constants at the top: `PANEL_BG` (a theme background key —
`selectedBg`, `userMessageBg`, `customMessageBg`, `toolPendingBg`, `toolSuccessBg`), `INSET`, and
`SHOW_LANGUAGE_LABEL`.

## Session entry shapes it reads

None. It never touches the session, the message list or the transcript document. Its only input is
the markdown token pi-tui hands to `renderToken`:

- `{ type: "code", text: string, lang?: string }` — `lang` is trimmed and reduced to its first
  whitespace-separated word, so an info string like `ts title="x"` still highlights as `ts`.
- `nextTokenType?: string` — used only to append one blank spacer line when the next token is
  anything other than `"space"`.
- Any token whose `type !== "code"`, or whose `text` is not a string, is passed straight through to
  the original renderer, as is everything when no theme is available.

## Modules

### `renderPanel()`

Builds the panel lines. `theme.getBgAnsi(PANEL_BG)` gives the tint; `keepBg()` re-arms that
background after every reset sequence the highlighter or `theme.fg` emits (it rewrites `\x1b[0m`
and `\x1b[49m`), and `fill()` pads each line to the full width and then closes with `\x1b[49m`.
Code comes from `highlightCode()` and is wrapped with `wrapTextWithAnsi()` to `width - 2*INSET`;
an empty source line becomes a single empty rendered line rather than disappearing.

### The theme slot

`Symbol.for("code-panels.theme")` holds a **getter** on `globalThis`, installed in `session_start`.
It is a getter, not a value, so `/theme` switches apply immediately, and it is wrapped in try/catch
because non-TUI modes have no `ui.theme` at all. It lives on a global symbol so that after a
`/reload` the fresh module instance feeds the patch that is already installed on the prototype.

### The patch guard

`Symbol.for("code-panels.patched")` on the prototype. Activation returns early if the flag is
already set **or** if `renderToken` is not a function — that second check is the API-drift guard the
README advertises: a pi release that changes the renderer's shape switches this feature off rather
than breaking the transcript. Inside the wrapper, a `try/catch` falls back to
`original.call(this, token, width, nextTokenType, styleContext)` on any rendering failure.

## Invariants a future change must not break

- **Patch once, ever.** The prototype outlives the activation; re-installing on `/reload` stacks
  wrappers. The `PATCHED` symbol is what prevents that — see invariant 2 in [[../00-start-here]].
- **Keep the symbols `Symbol.for`-global,** not module-local, or a reloaded module will patch a
  second time and the already-installed patch will lose its theme.
- **Delegate on anything unexpected**: non-`code` tokens, a non-string `text`, a missing theme, or a
  throw inside `renderPanel` must all call the original with the *same four arguments*, including
  `styleContext`, which is otherwise unused here.
- **Never mutate the token.** This is a render-time patch; the session and the model context must
  keep the original Markdown.
- **`keepBg` must run over highlighter output.** Without it, the first reset in a highlighted line
  drops the tint for the rest of the row.

## Gotchas

- The patch is never uninstalled — there is no `session_shutdown` cleanup and no way to turn the
  panels off in a running session short of restarting pi.
- Between module load and `session_start` the theme slot is unset, so anything rendered in that
  window falls back to plain fences.
- The file header says "Written against Pi 0.85.1" while the README claims the profile is tested
  against Pi 0.86.1; treat the header as the version the patch was actually reverse-engineered on.
- `docs/setup-guide.md` (§7b) embeds a **copy** of this extension's source for readers installing by
  hand. Edits here do not propagate there; the two can drift.
- The panel background comes from a theme key, so a theme without a usable `toolPendingBg` gives a
  panel you cannot see. That is a theme change, not a bug here.
- If code fences reappear after a pi upgrade, the guard fired: nothing is broken, the feature simply
  declined to patch a renderer it no longer recognises.

## Related

- [[../architecture/pi-internals]] — pi-tui's markdown renderer and how pi-cc patches the TUI.
- [[../architecture/upstream-workarounds]] — the other internals this profile leans on, and the
  canary tests in `tests/upstream-assumptions.test.mjs` (note: no canary covers `renderToken`; the
  runtime guard is the only protection).
- [[statusbar]] — the other extension that uses a pi internal deliberately (the viewport's private
  `layoutRoot`).
- [[outputs]] — display-side too, but with no patching at all.
