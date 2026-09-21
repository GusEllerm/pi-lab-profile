---
source: extensions/image-window.ts
source-hash: c9ee65ba3ad581e69deada5bf7c4b8331a2a450b
documented: 2026-09-20
---

# image-window.ts — send only the newest N images to the model; older ones become text placeholders

## What it owns

The `context` event handler that trims the **outgoing** copy of the messages on every LLM call, the
`/images` command, a `setStatus` line and a footer slot for [[statusbar]].

Why it exists: pi re-sends the whole conversation on every call, and the lab's vLLM endpoint runs
with `--limit-mm-per-prompt '{"image":4,…}'`, counted over the entire request. Once a session holds
a fifth image, *every* later call fails with "At most 4 image(s) may be provided in one prompt" —
including text-only turns. This trims only the outgoing copy: the session file and the transcript
keep every image.

Default window is 3 (`DEFAULT_WINDOW`), overridden by `$PI_IMAGE_WINDOW`. `0` sends no images.

## Commands

| command | what it does |
|---|---|
| `/images` | report: images in the session, the current window and where it came from, and what the last call sent/dropped |
| `/images <n>` | set the window to `n` for this session, from the next call; a non-integer argument falls back to the default and says so |
| `/images default` | restore the window to `$PI_IMAGE_WINDOW`, or 3 if that is unset or invalid |

## Session entry shapes it reads

Unlike [[outputs]], this works on the **message array**, not on session branch entries — there is no
`{ type, message, timestamp }` wrapper and no timestamps.

- `Message = { role, content?, toolCallId?, … }`. Two sources: `event.messages` in the `context`
  handler (the outgoing array, which is what gets trimmed) and
  `ctx.sessionManager.buildSessionContext().messages` for the `session_start` and `/images` counts.
- `blocksOf()` returns `content` only when the message's `role !== "assistant"` **and** `content` is
  an array. Assistant messages are never scanned for images, and a string `content` is left alone.
- `{ type: "image" }` blocks are what is counted and replaced. Replacement is in place, by a
  `{ type: "text", text: placeholder(hint) }` block at the same index.
- Assistant `{ type: "toolCall", id, arguments }` blocks supply `toolCallPaths()`: the first present
  of `arguments.path`, `file_path`, `filePath`, mapped by call id. A `toolResult` message's
  `toolCallId` then names the file its dropped image came from.
- For user/custom messages the hint comes from the text blocks instead: `@file` attachments emit
  `<file name="/abs/path">` per image, in the same order as the image blocks. The regex
  `/<file name="([^"]+)">(?!\n)/g` uses the negative lookahead to exclude **text** file attachments,
  which differ only by a newline right after `>`. The names are used **only** when
  `names.length === imageCount` — pasted images carry no tag, and a mismatch would pin the wrong
  filename on an image.

## Modules

### The pure core (exported, and where the tests live)

`parseWindow()`, `placeholder()`, `countImages()`, `trimImages()` and the `TrimResult` type are all
exported so `tests/image-window.test.ts` can drive them without a running pi.

`trimImages()` walks messages **backwards**, and blocks within each message backwards, keeping the
newest `limit` images and replacing every older one in place. It returns the input array itself
when nothing is dropped, copies (`messages.slice()`, `blocks.slice()`, `{ ...message, content: next }`)
only where a change is needed, and never mutates the input. `ordinal` tracks the *forward* index of
the image being visited while walking backwards, so an attachment name is matched to the right
image.

### Wiring

`session_start` counts the images a resumed session already holds and publishes the slot, so the
footer is right *before* the first call rather than after it. The `context` handler trims, records
`last`, updates the status and slot, and returns `{ messages }` **only** when something was dropped.
`showStatus()` no-ops without a UI and clears the status key when nothing was dropped. `publishTab()`
emits `statusbar:slot` with id `images` (`idle` / `ok` / `warn`, plus a `details()` closure), and is
also registered on `statusbar:ready` so load order does not matter.

## Invariants a future change must not break

- **Determinism.** Same history plus same window must produce byte-identical trimmed messages, or
  the server's prefix cache is invalidated on every call. No timestamps, no randomness, no
  "keep whichever image is largest".
- **Never mutate the input array or its messages.** Pi owns them; the test asserts this.
- **Return the input array unchanged when `total <= limit`,** and return `undefined` from the
  `context` handler when `dropped === 0`, so pi keeps its own array.
- **Replace in place, keep `content` non-empty, keep `toolCallId`.** A tool result with empty
  content is rejected by providers; a lost `toolCallId` orphans the result.
- **Attachment names are trusted only on an exact count match.** Naming the wrong file in the
  placeholder is worse than naming none.
- **Assistant messages stay out of `blocksOf()`** — the image accounting assumes images only ever
  arrive on user, custom and toolResult messages.
- **Trim the outgoing copy only.** The session file and the transcript must keep every image.

## Gotchas

- `parseWindow` accepts `^\d+$` and nothing else: `-1`, `3.0`, `" 3 "` (after trim it is fine),
  `abc` all silently become the default 3. `/images 3.0` notifies that it used the default.
- `source` (`PI_IMAGE_WINDOW` / `default` / `/images`) is only a label for the status detail; it is
  recomputed by hand in the command handler and can drift from `limit` if either is edited alone.
- The placeholder tells the model to "read it again if you need it" — so a dropped image can come
  back, at which point it is the newest and something older drops instead.
- Changing the window mid-session moves the prefix that stays cacheable; expect one slow call after
  `/images <n>`.
- The status line only appears while the last call actually dropped something; the footer slot is
  always present and reads `images –` until the context holds any.
- `limit` is per-process session state: a resume starts again from `$PI_IMAGE_WINDOW`.

## Related

- [[statusbar]] — the `statusbar:slot` / `statusbar:ready` protocol and the `statusKey` handoff.
- [[outputs]] — also walks messages, but session branch entries rather than the outgoing array.
- [[endpoints]] — the vLLM/ALCF endpoints whose `--limit-mm-per-prompt` setting forced this.
- [[../architecture/pi-internals]] — the `context` event and `buildSessionContext()`.
