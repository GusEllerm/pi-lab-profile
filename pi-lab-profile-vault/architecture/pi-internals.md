---
verified-against:
  pi-coding-agent: 0.87.0
  pi-tui: 0.87.0
  pi-cc-extensions: 0.8.71
  pi-subagents: 0.19.0
documented: 2026-09-20
---

# How the host actually works

Reverse-engineered while chasing [[../investigations/scroll-lag-2026-09|a scroll stall]]. None of this
is in the published docs, and several extensions here depend on it, so check the versions above before
trusting any of it. Everything below was read from the installed source, not inferred.

Where to read it yourself:

```
$(npm root -g)/@earendil-works/pi-coding-agent/dist/modes/interactive/   # readable, not minified
$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/
~/.pi/agent/npm/node_modules/pi-cc-extensions/extensions/                # TypeScript source, shipped
```

The bundle at `dist/bundle/chunks/chunk-*.js` is what actually runs; the readable `dist/modes/` tree
mirrors it. Stack traces name original functions, so grep the readable tree for names you see.

## The frame

`TuiAltScreen.doRender()` is one frame. It:

1. calls `renderLayoutFrame(root, width, height, requestRender)`,
2. composites overlays, search highlights, selection and flashes onto the resulting lines,
3. diffs against `previousScreen` **per row**, and writes only changed rows as
   `\x1b[<row>;1H\x1b[2K<line>`, in one `terminal.write()` per frame.

A full clear (`\x1b[2J`) happens only on a resize, on first paint, or when a row containing an image
changes. Measured on a real session: ~29 rows repainted per frame at ~330 bytes each, and
`terminal.write` is **1–3% of frame time** — the terminal is essentially never the bottleneck, which
is worth remembering before blaming it.

### The render cache is per frame

```js
// pi-tui/dist/layout.js
export function renderLayoutFrame(root, width, height, requestRender) {
    const context = { viewport: {...}, renderCache: new Map(), ... };
```

`renderCache` is created **fresh every frame** and keyed by `(component, width)`. So:

- Every frame re-renders the **entire** ScrollView document, not just the visible rows —
  `scrollContentLines: renderCached(context, node.component, contentWidth)` — and `paintBox` then
  slices out the ~45 rows you can see. A 2,850-line transcript is rebuilt 60 times a second.
- Nothing carries over between frames at this level. All real memoisation lives **inside** components.

### Components memoise themselves, and that is where the traps are

- **`Text`** (pi-tui/dist/components/text.js) caches exactly **one** `(text, width)` pair. Render it at
  a second width and the first is evicted. This is the single most consequential detail in this
  document — see [[upstream-workarounds]].
- **`Container.render`** does not cache at all. It calls `child.render(width)` for every child and
  concatenates. Cheap only because the leaves cache.
- **`AssistantMessageComponent.invalidate()`** calls `updateContent(this.lastMessage)`, which
  **re-parses the message's markdown**. `Container.invalidate()` cascades to every child. So a single
  `invalidate()` on the document re-parses the entire session — ~130ms at 2,850 lines.

Who invalidates everything, in practice:

| trigger | where | when |
|---|---|---|
| cell-dimension reply (`CSI 16 t`) | `tui.js`, `setCellDimensions` then `this.invalidate()` | once, from `start()` |
| alt-screen entry with iterm2 images | `tui-alt-screen.js` | on entering the alt screen |
| theme file changed | `interactive-mode.js`, `onThemeChange` | custom themes only |
| syntax grammars finished loading | `interactive-mode.js`, `loadAllHighlightLanguages().then` | once at startup |

Note what is *not* there: nothing invalidates on scroll, and nothing invalidates per frame. If you see
a full-session re-render, suspect a **width change** evicting `Text` caches, not an invalidation.

## Layout

`layoutComponent` walks the tree. A component either has a layout node (stacks, scroll views) or is a
leaf rendered through `renderCached`.

**The hstack measures children it then stretches.** In `layout.js`:

```js
const intrinsicHeights = entries.map((entry, index) => measureHeight(context, entry.component, widths[index]));
const allocatedHeight = height === undefined ? Math.max(...intrinsicHeights) : Math.max(0, height);
const childHeight = node.align === "stretch" ? allocatedHeight : Math.min(allocatedHeight, naturalChildHeight);
```

`align` defaults to `"stretch"`, and the height is usually already known, so `intrinsicHeights` is
computed and then **discarded**. `measureHeight` on a `ScrollView` goes through `Container.render`
rather than the scroll layout node, so it renders the whole document — and caches it under the
ScrollView while the paint path caches under the document, so the per-frame cache does not dedupe
them. Any hstack containing a ScrollView therefore renders its document **twice per frame**.
Worked around here; see [[upstream-workarounds]].

**A vstack entry with a numeric `basis` skips the measure entirely** — useful when you need a child
not to be rendered for measurement.

### The layout root

`chat-viewport.js` builds `VStack[ScrollView(transcript), dock]` and hands it to `setLayoutRoot`.
[[../extensions/statusbar]] replaces that root with its own split layout, reusing the same transcript
ScrollView and dock components. `setLayoutRoot` is patched (once per TUI, under a shared symbol) so the
column can re-mount when pi replaces the root.

## Mouse

`dispatchMouseToLayout` finds the boxes under the pointer and dispatches with `width: box.rect.width`
— the **layout** width, which is correct. Two things downstream are not:

- `Container.handleMouse` re-renders every child at `event.width` whenever its cached `mouseLayout`
  width does not match. Cheap when the widths agree; a full document render when they do not.
- **pi-cc's hover takes its width from `tui.terminal.columns`**, not from the box it just hit. With
  anything beside the transcript those differ, and every mouse *motion* re-renders the session at the
  wrong width. This is the bug behind both the scroll stall and "click to show more" landing on
  nothing. See [[upstream-workarounds]].

## How pi-cc attaches

`pi-cc-extensions` patches the TUI **instance**, not the prototype:

```ts
function patchFullscreenViewportInput(tui: any): void {
    if (tui[FULLSCREEN_VIEWPORT_PATCH] || !isLazyProxyTui(tui)) return;
    const original = Object.getPrototypeOf(tui)?.handleViewportInput;   // always chains from the prototype
    tui.handleViewportInput = function (data) { ... };
}
```

Three things follow, all of which cost time to learn:

- It is **symbol-guarded**, so it patches once — it does not fight you for the slot.
- It always chains from the **prototype**, never from whatever is currently installed, so your wrapper
  is not chained to; it is **overwritten**. `restoreFullscreenViewportInput` does exactly that,
  assigning the prototype method back onto the instance.
- **The TUI is a proxy** (`createInteractiveTuiReference` in `tui-renderer.js`): its `get` mints a
  **new arrow per read of any function-valued property**, `set` forwards to the real TUI, and
  non-function values — including symbol-keyed hook objects — pass straight through. So identity
  checks on methods are impossible through it, *and so are tags on the function* (they are not on
  the object you read back). Symbol-keyed hook objects work. The one handle on the real object: inside
  a wrapper you installed, `this` is the real `TuiAltScreen`.
- **`TuiAltScreen` registers `handleViewportInput` as an input listener in its own constructor**,
  ahead of every extension listener, and it consumes mouse packets. No `onTerminalInput` handler can
  see mouse input. (`TerminalInputHandler` returns `{ consume?, data? }`; `consume` short-circuits.)
- **`setExtensionFooter` and `setExtensionWidget` invoke their factories synchronously at
  registration** — so anything pi-cc patches from its widget factory is in place the moment its
  `session_start` returns.

## Extension API, as used here

`pi.on("session_start" | "session_shutdown" | "input" | "ui_prompt_start" | "ui_prompt_end" |
"turn_end" | "agent_end" | "message_start" | "message_update" | "message_end" | "model_select")`,
`pi.events` for the cross-extension bus, `pi.registerCommand`, `pi.sendMessage`.

Context: `ctx.ui.setFooter/setWidget/setStatus/custom/select/input/notify/onTerminalInput`,
`ctx.sessionManager.getBranch()`, `ctx.getContextUsage()`, `ctx.modelRegistry`, `ctx.model`, `ctx.cwd`.

Sharp edges:

- **`ui.select(title, options: string[])` returns a string**, not `{label, value}`.
- After `session_shutdown` every getter on the captured `ctx` **throws**, and so do `pi.events.on`,
  `pi.events.emit` and `pi.sendMessage`; `runner.invalidate()` also unsubscribes every `pi.events.on`
  the old activation registered and clears its terminal-input listeners and widgets. A throw inside a
  slash-command handler is **caught by the host** (`_tryExecuteExtensionCommand`); a throw from a
  timer, a process/event callback, a render or an un-awaited promise is not, and pi has **no
  `unhandledRejection` handler**, so it exits. The event bus wraps listeners in try/catch, so the only
  throw `emit` can produce is the stale assert. See invariant 1 in [[../00-start-here]].
- The `pi` manifest in `package.json` supports only `extensions`, `skills`, `prompts` and `themes`.
  Agents and model configs are **not** installable that way — hence the symlinks into `~/.pi/agent/`.

## Subagents (pi-subagents 0.19.0)

RPC over the event bus: `subagents:rpc:spawn` with `{requestId, type, prompt, options}`, and a
`subagents:rpc:consume` that must fire within 200ms. Lifecycle events are `subagents:created`,
`:started`, `:completed`, `:failed` — but **RPC spawns emit no `subagents:created`**, so a roster built
only from that event will miss them.

Spawn-time `model: "provider/modelId"` **outranks** the agent file's frontmatter model.

`session_shutdown` calls `manager.abortAll()`, so **`/reload` kills every running subagent**. This is
upstream behaviour, not a bug here, and it explains round phases that die for no visible reason.
