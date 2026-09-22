---
source: extensions/statusbar.ts
source-hash: 1d6d6b90344731504f3a70dbf1b3752d49151fd0
documented: 2026-09-20
---

# statusbar.ts — the footer, the right-hand column, the pinned prompt, and three upstream workarounds

The largest extension in the profile (~1550 lines) and the only one that rebuilds Pi's layout tree.
Everything else publishes *into* it over the event bus.

## What it owns

**The footer.** Pi joins every extension's `setStatus()` text onto one line, sorted by key, then
truncates — so statuses collide and the last ones fall off. This extension takes the footer over
entirely (`ctx.ui.setFooter`) and lays out fixed columns instead: path and branch on the left of
line 1, model · thinking · context right-aligned; endpoint | agents | images | usage on line 2.
Other extensions' statuses are counted, not printed (`+N`), and shown in `/status` under OTHER.

**The right-hand column** (the "sidebar"). In fullscreen mode on a terminal ≥ 72 columns, the
transcript is squeezed left and a 24–36 column status panel is drawn beside it: endpoint, model,
context bar, images, round, usage, total. While attached to a subagent it switches to that agent's
model, context, turns and rate instead. When the column is up the footer shrinks to just the path —
everything else has moved into the column.

**The pin bar.** One shaded row above the transcript holding your last message, so the question
stays visible while you read the answer. Clicking it jumps the transcript back to that message.

**Four commands' worth of chrome**: `/status`, `/sidebar`, `/pin`, plus the diagnostics `/prof`,
`/compat` and `/hover` that came out of the scroll-lag investigation.

Nothing in the footer or column is clickable except the pin bar. That is deliberate — they are
read-only instruments.

## Commands

| command | what it does |
| --- | --- |
| `/status` | Opens the read-only dashboard overlay (endpoint, agents, total, round, images, usage). Inside it, `e` runs `/endpoints`, `a` runs `/agents`, esc/enter/`q` close. `/status off\|on` removes or restores the footer entirely. |
| `/sidebar` | Bare toggles. `/sidebar on\|off`, `/sidebar <cols>` pins a width, `/sidebar auto` returns to width-by-terminal-size, `/sidebar min <cols>` sets the terminal width below which the column hides. |
| `/pin` | Toggles the pinned-prompt row. `/pin on\|off`. |
| `/prof` | Frame-level profiler: frames and ms each, worst frame, bytes and rows written, slow frames (>40ms) with their write time, document renders and their widths, the column's own render/cache stats, `Text` cache hit rate, dropped hover walks, GC pauses. Resets its counters each time it is run, so it measures the window since the last `/prof`. |
| `/compat` | Which of the three upstream workarounds are active, and why (or why not). |
| `/hover` | `auto` (default: pi-cc's tool hover suppressed only while the column is mounted), `on` (always hand hovering back to pi-cc), `off` (always suppress). |

## Events consumed and emitted

| event | direction | payload | why |
| --- | --- | --- | --- |
| `statusbar:ready` | out | — | Emitted at session start so publishers re-publish regardless of extension load order. |
| `statusbar:slot` | in | `{ id, text, state?, statusKey?, tokens?, details?: () => string[] }` | The generic channel. `endpoints.ts` publishes `endpoint`, `image-window.ts` publishes `images`, `fleet.ts` publishes `agents` (with `tokens`), `rounds.ts` publishes `round`. `statusKey` names the `setStatus()` key this slot stands in for, so its raw text is not repeated under OTHER. |
| `statusbar:attached` | in | `{ name, stats: () => AttachedStats }` | `fleet.ts` announcing you are attached to a subagent; switches the column and footer into attached mode. |
| `statusbar:transcript` | in | `{ component }` | `fleet.ts` supplying the subagent's transcript pane to show in place of the session's. |
| `statusbar:endpoint-labels` | in | `Record<provider, label>` | `endpoints.ts` publishing short names ("globus3", "ALCF Minerva") so the column does not have to guess from the provider id. |

Pi lifecycle hooks used: `session_start`, `session_shutdown`, `input`, `message_start`,
`message_update`, `message_end`, `turn_end`, `agent_end`, `model_select`.

## Modules

### Footer rendering

`install()` registers the footer component; the render body is inline there. Grep `renderSlot` for
the fixed-column cell (text + state mark, padded to a share of the width — `[0.22, 0.17, 0.17]`).
`sidebarShown()` decides whether the footer collapses to just the path. `stripAnsi` is used before
measuring other extensions' statuses, since their colour codes would otherwise count as width.

### Usage and speed

`sumUsage()` walks `ctx.sessionManager.getBranch()` once per assistant message (not per frame) and
totals prompt/cacheRead/output/calls/cost. `SpeedMeter` samples output tokens over a sliding
`SPEED_WINDOW_MS` (10s) window per `message_update`, and `speedText()` formats it.

Two subtleties worth keeping: the meter **restarts each reply**, so a pause for tool execution is
not averaged in as slow generation; and providers that do not report `usage.output` while streaming
(the ALCF gateway delivers the whole reply at once) fall back to a `chars/4` estimate, marked `~`.
`SpeedMeter.end()` flags `buffered` when the reply arrived in one burst — that is delivery speed,
not generation speed, and the dashboard says so rather than quietly reporting a fake number.

### The column

`drawSidebar(width, ctx)` builds the lines; `sidebar` is the `Component` wrapper that memoises
them.

**Section order is deliberate** (Sept 2026 redesign, from a screenshot where 45% of the column was
empty and `USAGE` truncated): `CONTEXT` leads, because it is the only section with a deadline
attached; `AGENTS` follows and expands only while agents run; the static `MODEL` and `ENDPOINT` sit
below; then `ROUND` (only once a round has started), `USAGE`, `TOTAL`, `OTHER`.

`CONTEXT` reports **remaining** rather than just the percentage (`92.1% · 19k left`), and carries a
trajectory: `ContextTrail` keeps a minute of once-a-second samples and yields `rate()` in tokens per
minute and `spark(width)` as a block-character sparkline. The spark is normalised to *its own
window's* min and max, not to the context size — at 92% every bar would otherwise be full, which is
precisely when the shape matters. A `full in ~N min` line appears when the rate implies one. A flat
or shrinking context (after a compaction) yields no rate and therefore no countdown. Tested in
`tests/context-trail.test.mjs`, which slices the class out of this file the way
`tests/paint-diff.test.mjs` does.

`AGENTS` renders rows from the `agents` slot's `details()` — read in the *body*, never the key. Idle,
it holds its position with one dim `none running` line so the column does not reshuffle when a round
starts.

**The command hints are anchored to the bottom row**, so slack in a tall column sits between the
sections and the hints. The anchor needs the height of the *band* the column occupies, which is not
the `vp.height` the stack's `visible()` hook reports — that is the whole viewport, dock included, and
anchoring to it puts the hints below the fold. The transcript `ScrollView` is laid out in exactly
this band, so `scrollRef.viewportHeight` supplies it, falling back to `rowHeight`. `section()` inside `drawSidebar` handles the two layouts: label-and-value on one row, or
label on its own line when the column is narrower than `SIDEBAR_COMPACT_BELOW` (30).
`sidebarWidthFor()` maps terminal width to column width (36/32/28/24 by bracket).

**The memo is the performance-critical part.** `sidebarKey(width, ctx)` builds a string from every
value the body reads, and `sidebarCache` returns the previous lines when it matches. Pi renders the
footer and column on *every* frame — every keystroke, every chunk of streaming text — while the
column's content only changes when one of its own events fires.

> The key must never **call** a slot's `details()`. `fleet.ts` builds its agent rows in there,
> through `truncateToWidth` → `Intl.Segmenter`, and the key runs on every frame even when the cache
> hits. The first version of this memo did exactly that and made things *worse*: 115% CPU while
> scrolling against 55% with the column off.

So the key uses `slotsVersion` (a counter bumped in the `statusbar:slot` handler) and
`statusesRef.size` (a count, not the text) as proxies. It also contains
`Math.floor(Date.now() / 1000)` as a staleness backstop — that caps how long anything time-derived
can be wrong, it does not carry the design.

### The pin bar

`pinBar` is a `Component` with its own `pinCache` keyed `${width}|${pinnedPrompt}` — same reasoning
as the column, since `truncateToWidth` is a Segmenter walk. `pi.on("input")` captures the prompt
(skipping anything starting with `/`), `backfillPrompt()` recovers the last user message when a
session is resumed so the bar is not blank until you next type.

`jumpToLastPrompt()` is the click target. The jump itself is Pi's: it marks prompts with OSC 133 and
`scrollToPrompt(-1)` finds the nearest one above. Two details:

- `scrollToPrompt` is **not in the public typings**, so it is called behind a `typeof` check and the
  click degrades to doing nothing if it disappears.
- Pi's marker sits at the *end* of a user message, so a raw jump lands past it — measured, the first
  rows after a jump were "Thought for 2s" and the reply. `PIN_JUMP_LIFT` (default 2) scrolls back a
  couple of rows so the message itself is on screen.

### Mounting into Pi's layout

This is the part that reaches furthest into Pi's internals, and it checks before it touches
anything. In fullscreen, Pi's layout root is `VStack[ScrollView transcript, dock]`
(pi-coding-agent `chat-viewport.js`), held in the viewport's private `layoutRoot`.

`mountSidebar(tui)` verifies that shape — `root instanceof VStack`, two children, first is a
`ScrollView` — and **does nothing at all if it does not match**, so a Pi update that changes the
layout degrades to "no column" rather than a crash. `applySidebarWidth()` then rebuilds it as
`VStack[pinBar, HStack[transcript, sidebar], dock]`.

`setLayoutRoot` is wrapped so the column re-attaches whenever Pi installs a fresh root. The wrapper
lives on the TUI under `Symbol.for("pi-statusbar:layout-hook")` with a swappable `hook.onRoot`, so a
reload **replaces the handler** rather than stacking a second wrapper that calls a dead one.

The sidebar stack entry's `visible(vp)` hook also records `rowHeight` (the column draws its divider
to the full row height) and watches for width-class changes. It reacts only to `vp.width` *changing*
— never to a mismatch between `vp.width` and `currentWidth`, because those come from different
sources (the stack's width vs `tui.terminal.columns`) and can disagree permanently by a scrollbar
column. A mismatch-triggered rebuild re-armed a timer that forced a full repaint on every layout
pass: a permanent ~8Hz repaint of the whole transcript. See `scheduleResizeSettle`.

### `/prof` instrumentation

Wrappers around the transcript document's `render`, the TUI's `doRender`, and `terminal.write`,
plus a `PerformanceObserver` on GC. All of it exists because the scroll-lag investigation needed
numbers the extension could not otherwise see. Grep `instrumentFrames`, `instrumentTranscript`,
`ensureDocWrapped`, `prof`, `sink`.

Two hard-won rules are encoded here, both in [[../investigations/scroll-lag-2026-09]]:

- These wrappers live on objects that **outlive the activation** (the TUI, the document,
  `Text.prototype`), so they are installed **once, ever**, and read their counters through a shared
  sink (`Symbol.for("pi-statusbar:prof-sink")`) that each activation repoints at its own `prof`.
  Versioning them instead caused a new wrapper to stack on each reload until every component
  rendered through four nested timers — `/prof` reported 61.6ms document renders against 2.1ms and
  `22787ms` of child time inside a 121ms render. The instrument became the effect being measured.
- `ensureDocWrapped()` re-wraps the document when pi-cc swaps it (it rebuilds the transcript as
  messages arrive), otherwise the counter silently reports zero forever.

## Upstream workarounds carried here

All three are recorded in `docs/upstream-hover-width.md`. Each states the shape it depends on and
**refuses to apply** when that shape is absent, so a workaround that stops fitting brings back a
known bug that `/prof` names rather than rendering the wrong thing silently. `/compat` reports the
state of each.

### 1. ScrollView measure stub — `stubMeasureRender` / `restoreMeasureRender`

**Bug (pi-tui):** an hstack computes `intrinsicHeights = entries.map(measureHeight)`
unconditionally, and `measureHeight` on a `ScrollView` goes through `Container.render` rather than
the scroll layout node — so it renders the *entire document*. With `align` defaulting to
`"stretch"` and a definite height, that measurement is then **discarded**. Net effect: putting
anything beside the transcript renders the whole transcript twice per frame.

**Measured:** 40 document renders per 20 frames with the column mounted, 20 without.

**Workaround:** while the split layout is mounted, the transcript ScrollView's `render` is replaced
with a stub returning `rowHeight` blank lines. Real content still renders through the scroll node
(`renderCached(context, node.component, contentWidth)`), which is the path that paints. Restored on
`/sidebar off`, attach/detach (`stubbedPane` tracks which pane is stubbed) and shutdown.

**Refuses when:** the transcript pane is not a `ScrollView`. **Off-switch:** `PI_MEASURE_STUB=off`.
**Canary:** `pi-tui hstack measures children it then stretches`.

### 2. `Text` per-width cache — `patchTextWidthCache` / `textPatchApplies`

**Bug (pi-tui):** `Text` caches exactly one `(text, width)` pair. Any second width in the tree turns
every subsequent render into a full re-render of the session.

**Workaround:** patches `Text.prototype.render` to keep a small `Map<width, {text, bg, lines}>` (max
4 entries). The bg function is keyed by **source, not identity** — pi-cc builds a fresh closure per
render for hover highlighting, and keying on identity made every highlighted `Text` miss (33% hit
rate where it should be ~100%).

**Refuses when:** `textPatchApplies()` fails its probe — it renders a scratch `Text` at two widths
and checks the second evicts the first. If pi-tui ever caches per width, the probe fails and the
patch skips itself, letting the upstream fix stand alone. **Off-switch:** `PI_TEXT_CACHE=off`.
**Canary:** `pi-tui Text still caches exactly one width`.

### 3. Hover guard — `guardHover` / `onlyMotion`

**Bug (pi-cc):** `handleFullscreenToolHover` takes its hit-test width from `tui.terminal.columns`
instead of from the layout box it just hit. With a column beside the transcript those differ, so
every mouse motion walks the message tree rendering at the wrong width — which both mis-maps rows to
components (this is why *"click to show more"* lands on nothing) and, combined with bug 2, evicted
the whole session's cached lines on every mouse move. pi-cc's own hover cache cannot absorb it: it
is keyed on the layout object, which Pi replaces every frame.

**Measured:** 4.2 seconds of accumulated child renders in one scroll window; ~130ms per motion event
for the walk plus ~130ms for the next frame's rebuild.

**Workaround:** while the column is mounted, motion-only input (`onlyMotion` — every SGR packet in
the chunk has bit 32 set and ends in `M`) is routed to Pi's own viewport handler, bypassing pi-cc's
hover. Presses, releases, wheel and keys pass through untouched, so clicks, selection and scrolling
are unchanged. What is lost is a hover highlight that was pointing at the wrong row anyway.

Two non-obvious details:

- pi-cc **reinstalls its own handler** (`restoreFullscreenViewportInput` assigns the prototype
  method onto the instance), silently removing the wrapper. `guardHover` is therefore called from
  the render path every frame and reinstalls when needed.
- The TUI is a lazy proxy, so reading the handler back does not return the same function object and
  an identity check reinstalls every frame (775 times in a 775-frame window). The wrapper carries a
  `__piHoverGuard` tag instead, which survives the proxy and makes **wrapping our own wrapper
  impossible** rather than merely unlikely.

**Refuses when:** pi-cc has not patched `handleViewportInput`. **Off-switch:** `/hover on`.
**Canary:** `pi-cc hover still hit-tests at the terminal width`.

### The hover guard, and how it crashed a session

It reinstalls itself, because pi-cc's `restoreFullscreenViewportInput` assigns the prototype method
straight onto the instance and silently removes it. Reinstalling is also how it killed a session.

An earlier version re-read `tui.handleViewportInput` on each pass and wrapped whatever it found. The
TUI is a **lazy proxy**: it never hands back the function object you assigned, so the "is it still
mine?" check failed every frame — visibly, as `775× installed` in a 775-frame window, which was read
as harmless churn. It was not churn. Each frame wrapped the previous wrapper, the chain grew by one
per frame, and the session eventually died with **Maximum call stack size exceeded**. Tagging the
wrapper with a property did not help either: the tag cannot be read back through the proxy.

That second version still compared through the proxy, so its "pi-cc has not patched" branch could
never run: it captured whatever it first read and would have overwritten a later pi-cc patch every
frame, with `/compat` reporting success (review H3).

**What holds now (22 Sept 2026): the guard never touches the proxy.** The frame wrapper is a
`function`, and pi calls it as `this.doRender()` on the *real* `TuiAltScreen`, so `this` is the real
object — captured into `sink.realTui` on the first frame, before any input exists. `guardHover` then
reads `Object.getOwnPropertyDescriptor(realTui, "handleViewportInput")`: ours on top → nothing to do;
no own property → pi-cc has not patched, leave the prototype alone (the refusal branch is reachable
for the first time); any other function → pi-cc's patch (it always chains from the prototype, so it
is never a wrapper of ours), taken as the inner handler through `sink.piccHandler`. One wrapper per
process, held on the sink so a reload repoints rather than rebuilds. Measured: `1 built, 1× installed`
where the proxy-based versions reported `775× installed` in 775 frames. `tests/hover-guard.test.mjs`
pins the order — ownership check before capture, refusal before install, one construction site.

### The resize listener (fixed 22 Sept 2026)

`process.stdout.on("resize", scheduleResizeSettle)` is registered per activation, so it is removed
per activation in `session_shutdown`. Before that `.off`, every `/reload` stacked another listener
whose closure pinned the whole dead activation — the one unbounded leak the review found — and one
resize then ran a forced full repaint per reload ever done. `scheduleResizeSettle` and its timer, and
`mountSidebar` (reached from two `setTimeout(0)` sites), now refuse when `dead`.

### 22 Sept 2026 review fixes

- `/compat` lied after the first `/reload`: `textPatchApplies()` probes through `Text.prototype`,
  which by then carries the patch, so it saw two widths cached and reported "upstream fixed". The
  already-installed check now comes *before* the probe and reports "installed by an earlier
  activation" (M6, verified live).
- `ContextTrail` is now a minute of *time*: samples older than 60 s are evicted on the next sample.
  It was sixty *samples*, taken only on frames the column drew, so after an idle stretch `rate()`
  and `full in ~N min` averaged across the gap (M7; `tests/context-trail.test.mjs` drives the clock).
- Removed: `PROF_VERSION` and `FrameHook.version` (the abandoned versioning), `noteEvent`/`lastEvent`
  (nine writers, no reader), `lastDocLines`, `prof.keyMs`; `profSince` moved onto `prof` so the
  once-ever document wrapper reads the live window; the `.component` branch in `ensureDocWrapped`
  (the ScrollView holds `child`); a `return` inside the wrapper's `finally` that would have
  swallowed the render result. `band` is in the memo key. The header comment matches the code again
  (≥ 72 columns; the pin bar in the layout; the pin bar is clickable).

## Invariants a future change must not break

1. **Nothing that can run after `session_shutdown` may touch the captured `pi` or `ctx`.** A throw
   from a timer or a render is an `uncaughtException` that takes the whole session down. Hence
   `dead`, the `alive(ctx)` guard on every render (`ctx.hasUI` throws once the activation is
   replaced), and `session_shutdown` clearing `resizeTimer`, disconnecting `gcObserver`, unsetting
   `hook.onRoot` and calling `unmountSidebar()`. This has bitten twice — once here, once in
   `fleet.ts`'s 500ms ticker.
2. **Hand Pi its own layout root back on shutdown.** Otherwise the next activation finds a root it
   does not recognise (`VStack[HStack, dock]`), declines to mount, and leaves a dead column on
   screen that crashes the next layout pass.
3. **Wrappers on long-lived objects are installed once and route through the sink.** Never version a
   wrapper and re-wrap — see `/prof` above.
4. **The memo key must never call `details()`**, or run a regex over every status.
5. **Never react to a width *mismatch*, only to a width *change*.** Mismatches between viewport
   width and terminal width are permanent and turn any repair into an infinite repaint loop.
6. **Check Pi's layout shape before rebuilding it**, and no-op if it is unfamiliar.

## Gotchas

- `ui.select(title, options: string[])` returns a **string**, not `{label, value}`.
- The column's divider height comes from the stack's `visible(vp)` hook (`rowHeight`), not from the
  render width — a column rendered before the first layout pass has height 0.
- `PI_SIDEBAR_MIN_COLUMNS`, `PI_SIDEBAR_WIDTH`, `PI_SPEED_WINDOW_MS`, `PI_PIN_JUMP_LIFT`,
  `PI_TEXT_CACHE`, `PI_MEASURE_STUB`, `PI_HOVER` all override defaults from the environment.
- The `TOTAL` section trusts `fleet.ts` to keep its agent-token figure **cumulative** — an agent
  leaving the roster must not make the total fall.
- `/prof` resets on read, so two people running it in the same window will see each other's data
  disappear.

## Related

[[fleet]] · [[endpoints]] · [[rounds]] · [[../architecture/pi-internals]] ·
[[../investigations/scroll-lag-2026-09]] · `docs/upstream-hover-width.md` ·
`tests/upstream-assumptions.test.mjs`
