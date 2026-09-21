# Upstream: hover hit-test uses the terminal width, not the layout box

Two bugs, one wrong variable. Filed from a session where the transcript shares the screen with
a right-hand column, so the transcript's layout width (151) differs from the terminal width (187).

## pi-cc (`extensions/renderer/mouse/interaction.ts`, `handleFullscreenToolHover`)

```ts
const width = Math.max(1, Number(tui.terminal?.columns) || 80);
const contentWidth = fullscreenContentWidth(hit.box, width);
const componentHit = cachedFullscreenComponentAtRow(layout, hit.box.component, hit.localRow, contentWidth);
```

The width comes from the terminal, but `hit.box` is the layout box that was just hit and knows
its own width. When anything occupies columns beside the transcript the two disagree, and:

1. **Hit-testing maps rows to the wrong components.** `componentAtLocalRow` renders each child to
   measure its height, so at the wrong width the heights are wrong and the row → component
   mapping drifts. This is why "click to show more" lands on nothing in a split layout.

2. **Every mouse motion re-renders the whole session, twice.** `componentAtLocalRow` calls
   `child.render(width)`, and pi-tui's `Text` caches exactly one `(text, width)` pair, so a walk
   at the wrong width evicts every cached line in the transcript. The next frame rebuilds all of
   them at the real width.

Suggested fix: derive the width from the box, e.g. `fullscreenContentWidth(hit.box, hit.box.rect.width)`.

### Measured

A ~2850-line session, scrolling with a trackpad (motion events interleaved with frames):

```
frames: 112, 31.4ms each, worst 149.7ms, write 1% of frame time
slow transcript renders: 139ms @151col, 2846 lines (same), no invalidate, no GC >15ms
slow render spent it in: ToolExecutionComponent 79ms, AssistantMessageComponent 43ms, Text 8ms
rendered at the wrong width: Container at 187 (doc is 151):
  componentAtLocalRow ← cachedFullscreenComponentAtRow ← handleFullscreenToolHover ← tui.handleViewportInput
```

The render produces identical output — same line count, same width, no `invalidate()`, and V8
reports no GC pause over 15ms — so the cost is purely cache misses. It reproduces to the
millisecond, which is what pointed at an eviction rather than a pause.

`cachedFullscreenComponentAtRow` cannot absorb this: it is keyed on the layout object, and
`TuiAltScreen.doRender` assigns a fresh `currentLayout` every frame, so the cache is discarded
every frame while scrolling.

## pi-tui, two contributing designs

**`Text` keeps a single cache entry** (`cachedText`/`cachedWidth`/`cachedLines`). Any second
width in the tree turns every render into a full re-render. A small per-width map (2-4 entries)
removes a whole class of stall; a session rendered at two widths is not unusual once anything
shares the screen with the transcript.

**`hstack` measures children it then stretches.** In `layout.js`:

```js
const intrinsicHeights = entries.map((entry, index) => measureHeight(context, entry.component, Math.max(1, widths[index])));
const allocatedHeight = height === undefined ? Math.max(...intrinsicHeights) : Math.max(0, height);
const childHeight = node.align === "stretch" ? allocatedHeight : Math.min(allocatedHeight, naturalChildHeight);
```

`intrinsicHeights` is computed unconditionally, but with a definite `height` and the default
`align: "stretch"` it is never read. `measureHeight` on a `ScrollView` goes through
`Container.render` rather than the scroll layout node, so it renders the **entire document** —
and caches it under the ScrollView while the paint path caches under the document, so the
per-frame `renderCache` does not dedupe them. Any hstack containing a ScrollView renders its
document twice per frame.

Measured, 1500-line transcript, 15 keystrokes: 40 document renders with a column beside the
transcript, 20 without. Skipping the measure when the height is already known and the children
are stretched would remove it.

## Workaround carried in this profile

`statusbar.ts` keeps motion-only input away from pi-cc's hover while the column is mounted
(`/hover auto|on|off`), and gives pi-tui's `Text` a small per-width cache. Both are worked around
rather than fixed: the hover still hit-tests at the wrong width whenever it does run, which is the
part only the upstream one-liner can fix.
