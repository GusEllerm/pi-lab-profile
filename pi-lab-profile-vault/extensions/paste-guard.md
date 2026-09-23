---
source: extensions/paste-guard.ts
source-hash: 09face65144c81958889731a3ba9859e318bec93
documented: 2026-09-23
---

# paste-guard.ts — a paste that arrives without bracketed-paste markers stays a paste

## What it owns

One `onTerminalInput` handler and a burst detector, `PasteBurst`. Nothing else: no commands, no
events, no slot.

## The problem, measured

Pi's editor relies on the terminal wrapping a paste in `ESC[200~ … ESC[201~`. Without the markers
the first carriage return submits what came before it and every later line goes to the model as its
own prompt. Upstream knows: #7321 (Termux, no bracketed paste at all), #2376 (tmux 3.6a with
`extended-keys on` + `csi-u`, markers lost in pi-tui's strip/re-wrap), #767 (Windows). On 23 Sept
2026 the user pasted a transcript into a session in iTerm2 and every line went out as a request.

Three measurements decided the design:

1. A pexpect harness sending `ESC[200~ a\nb\nc ESC[201~` into Pi **with the whole profile loaded**
   kept the paste in the editor and submitted it as one prompt on Enter. pi-cc's editor and this
   profile do not lose markers; the markers had not arrived from the user's terminal.
2. The same three lines sent **without** markers into `pi --no-extensions` reproduced the symptom
   exactly: the first line submitted, the model answered it, the third line sat in the editor.
3. A first version keyed on chunk shape (a newline with text after it in one read) never fired:
   Pi hands extensions the input **one key at a time** — the handler saw `"f"`, `"i"`, `"r"`… — so
   no chunk can ever look like a paste. Only timing is left.

## How it works

`PasteBurst.feed(key, now)`: three keys inside `BURST_MS` (80) start a burst; from then on every
key is held (carriage returns become newlines) and the handler returns `{ consume: true }`. The
first two keys were typed into the editor before the burst was known and stay there. `QUIET_MS`
(60) after the last key, `flush()` appends the held text to the editor with `setEditorText`.

**Pi does not render after a timer.** `setEditorText` from the flush changed the editor's text and
drew nothing until the next key — measured: the editor read the whole paste, the screen showed
`fi`. A status write is the one API an extension has that asks for a frame, so the flush sets and
clears `setStatus("paste-guard")`.

Anything containing an escape byte — arrows, mouse reports, a real bracketed paste — is never held
and ends a burst (flushing what was held first). A paste whose first line is two characters long can
still submit early; that is the price of having no marker.

## Invariants a future change must not break

- Never hold an escape sequence; never hold at human typing speed (the tests pin 120 ms gaps as
  typing).
- The flush must ask for a frame, or the paste is invisible until the next key.
- `session_start` may fire again on `/reload`; the previous handler is unsubscribed first, and the
  timer is cleared on `session_shutdown`.

## Verified

`tests/paste-guard.test.mjs` (4): the burst threshold and the held text, typing at human speed,
escape sequences, and the extension consuming a burst and appending it after the quiet gap. Live,
23 Sept 2026: an unbracketed three-line paste into Pi with the profile produced three lines in the
editor and no request; a bracketed paste still behaves as before.

## Related

[[statusbar]] · [[fleet]] (the other `onTerminalInput` users) · [[../00-start-here]]
