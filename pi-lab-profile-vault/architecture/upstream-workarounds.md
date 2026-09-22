---
source: extensions/statusbar.ts
source-hash: 116ed9b365050b014e42d1b41628a8e6dd8b5c6e
documented: 2026-09-20
---

# Upstream bugs, and the workarounds carried here

Three patches in [[../extensions/statusbar]] reach into code this profile does not own. Each one exists
because of a specific upstream bug, each states the shape it depends on and **refuses to apply** if
that shape is gone, and each has a canary test that fails when upstream fixes the bug.

Found while chasing [[../investigations/scroll-lag-2026-09]]. Written up for filing in
`docs/upstream-hover-width.md`; **not yet filed** (the user has not decided to open the issues).

`/compat` reports what is currently active and why. Off-switches: `PI_TEXT_CACHE=off`,
`PI_MEASURE_STUB=off`, `/hover on`.

## 1. pi-cc hit-tests hover at the terminal width

**The bug.** `pi-cc-extensions/extensions/renderer/mouse/interaction.ts`, in
`handleFullscreenToolHover`:

```ts
const width = Math.max(1, Number(tui.terminal?.columns) || 80);
const contentWidth = fullscreenContentWidth(hit.box, width);
```

The width comes from the terminal; `hit.box` is the layout box that was just hit and knows its own
width. With nothing beside the transcript these are equal and the bug is invisible. With a status
column they differ (187 against 151 here), and two things break:

- **Rows map to the wrong components**, because `componentAtLocalRow` renders each child to measure its
  height and gets the heights wrong. *This is why "click to show more" lands on nothing.* No local
  patch fixes it — only the real width will.
- **Every mouse motion re-renders the session**, twice: once in the walk at the wrong width, then again
  on the next frame at the real width, because of bug 2 below. Measured: **4.2 seconds** of accumulated
  child renders in one scroll window.

Its own cache cannot absorb this — it is keyed on the layout object, which pi replaces every frame.

**Suggested fix:** `fullscreenContentWidth(hit.box, hit.box.rect.width)`.

**Workaround here.** While the column is mounted, motion-only input goes straight to pi's own viewport
handler and never reaches the hover. Presses, releases and wheel events are untouched, so clicks,
selection and scrolling are unchanged; what is lost is a hover highlight that was pointing at the wrong
row anyway. With the column off, pi-cc is left alone — its assumption holds there.

Two things this cost to learn, both in [[pi-internals]]: pi-cc **overwrites** the handler slot
(`restoreFullscreenViewportInput`) so the guard must reinstall itself, and the TUI is a **lazy proxy**
so the wrapper must be identified by a tag, not by identity.

## 2. pi-tui `Text` caches exactly one width

**The bug.** `pi-tui/dist/components/text.js` holds `cachedText` / `cachedWidth` / `cachedLines` — a
single entry. Any render at a second width evicts the first, so one stray render at another width turns
the next full render into a total rebuild. At 2,850 lines that is **~130ms**, producing identical
output, with no invalidation and no GC — which is exactly what made the stall so hard to identify.

**Suggested fix:** a small per-width map (2–4 entries).

**Workaround here.** `Text.prototype.render` is patched to keep a few widths per instance. Nothing
renders differently; both widths simply coexist. Two details that matter:

- The key must compare `customBgFn` **by source, not identity** — pi-cc rebuilds that closure per
  render for hover highlighting, and keying on identity made every highlighted `Text` miss (33% hit
  rate where it should be ~100%).
- It **probes before patching**: it renders a scratch `Text` at two widths and checks the second evicts
  the first. If pi-tui ever fixes the cache, the probe fails, the patch skips itself, and the upstream
  fix stands alone.

**Residual risk, and the reason the real fix belongs upstream:** this patch assumes `text` plus
`customBgFn` fully determine the output. If pi-tui adds a third input to rendering, the cache could
serve stale lines — a failure that cannot be detected from outside. It is the one thing here that could
go silently wrong.

## 3. pi-tui hstack measures children it then stretches

**The bug.** In `layout.js`, `intrinsicHeights` is computed for every child unconditionally, but with a
definite height and the default `align: "stretch"` it is never read. `measureHeight` on a `ScrollView`
goes through `Container.render` rather than the scroll layout node, so it renders the **entire
document** — and caches it under the ScrollView while the paint path caches under the document, so the
per-frame cache does not dedupe them.

Any hstack containing a ScrollView renders its document twice per frame. Measured on a 1,500-line
transcript over 15 keystrokes: **40 document renders with a column, 20 without.**

**Suggested fix:** skip the measure when the height is already known and the children are stretched.

**Workaround here.** While the split layout is mounted, the transcript's *measurement* render is stubbed
to blank lines of the right height. The real content still renders through the scroll node, which is the
path that actually paints. Verified against a sidebar-off control that page-up scrolling is unchanged.

## The canaries

`tests/upstream-assumptions.test.mjs` asserts each bug is **still present**:

```
ok 1 - pi-tui Text still caches exactly one width
ok 2 - pi-tui hstack measures children it then stretches
ok 3 - pi-cc hover still hit-tests at the terminal width
```

They are inverted deliberately. **A failing canary means upstream fixed something and the matching
workaround should be deleted**, not repaired. They skip cleanly where pi is not installed, so CI
passes without it.

Verified against pi-coding-agent 0.86.1, pi-tui 0.86.1, pi-cc-extensions 0.8.71.

(The `source-hash` here tracks `extensions/statusbar.ts`, which carries all three patches, so this
note goes stale whenever that file changes for any reason — re-read the patches, then `--fix`.)
