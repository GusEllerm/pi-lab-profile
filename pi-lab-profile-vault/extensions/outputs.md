---
source: extensions/outputs.ts
source-hash: d2a53362c6e874c40db4cfa3be7a0591cbd6644a
documented: 2026-09-20
---

# outputs.ts — `/open`: re-read anything the session holds, from the session rather than the transcript

## What it owns

- The `/open` command: one picker over everything substantial that happened this session —
  reasoning blocks, `!bash` runs, edits (as diffs), writes (as the content written), and other tool
  results — then either an in-TUI pager or a handoff to `$EDITOR`.
- Two overlay components, `Picker` and `Pager`, both drawn through `ctx.ui.custom`.
- One temp directory per pi process, used only for the editor handoff and removed on
  `session_shutdown`.

It patches nothing, publishes no statusbar slot, emits no events and reads no other extension's
state. The only host API it depends on is `ctx.sessionManager.getBranch()`, and even that is
called through optional chaining.

**The reason it reads the session, not the transcript:** the display collapses a 4,000-line command
result to a single line and that truncation is permanent in the rendered view, but the session
entry still holds the whole thing. So `/open` can show output the transcript threw away, and it
works on blocks that scrolled off long ago. Anything that "fixes" this by reading the transcript
document instead destroys the feature's whole point.

## Commands

| command | what it does |
|---|---|
| `/open` | collect the session's items, show the picker; Enter opens the highlighted one in the pager (≤ `OPEN_IN_EDITOR_LINES`) or in `$EDITOR` (longer) |
| `/open <text>` | same, but pre-filters items on label, detail, owning prompt and **full text** before the picker opens; notifies `Nothing matching "<text>"` if none survive |

Two environment knobs, read at module load: `PI_OPEN_EDITOR_LINES` (`OPEN_IN_EDITOR_LINES`,
default 40) is the pager/editor threshold, and `PI_OPEN_MIN_THINKING` (`MIN_THINKING_CHARS`,
default 200) is the floor below which a reasoning block is not worth listing.

## Session entry shapes it reads

`collect()` walks `ctx.sessionManager?.getBranch?.() ?? []`. Both links are optional, so a host
without a session manager gives an empty picker instead of a throw.

**Entry wrapper:** `{ type?: string; message?: any; timestamp?: string }`. Everything whose
`type !== "message"`, or that has no `message`, is skipped. `timestamp` is an ISO string; it is
`Date.parse`d into `at` and only ever used for the `ago()` column on group headings.

Four message roles matter, and each has a different shape:

**`role: "user"`** — `content` is either a plain string or an array of blocks, in which case the
`type: "text"` blocks are joined with a space. The text becomes `prompt`, the group heading every
later item is filed under, truncated to 70 characters. A message whose text starts with `/` does
**not** update the heading, so items produced by a slash command stay filed under the last real
thing you said.

**`role: "assistant"`** — iterate `m.content`:
- `{ type: "toolCall", id, name, arguments }` → stored in a `calls` Map keyed by `id`. This is the
  **only** place a tool's arguments exist; the result message does not carry them, which is why
  the map has to be built during the same walk.
- `{ type: "thinking", thinking: string }` → an item, but only if `thinking.trim().length >=
  MIN_THINKING_CHARS`. A one-line aside is readable where it already is; listing every one of
  them buries the blocks actually worth reopening.

**`role: "bashExecution"`** — a `!command` you ran yourself. This is its **own message role**, not
a toolResult and not an assistant tool call, and the fields live directly on the message:
`output` (string; the item is skipped when it is blank), `command` (string, shown as the picker
detail) and `exitCode` (number; non-zero sets `isError`, which draws the row's `✗`). An earlier
version only looked at `toolResult` and so showed an empty picker in a session that was mostly
`!bash` — this branch is the fix and must not be folded back into the toolResult handling.

**`role: "toolResult"`** — `content` is a string, or blocks whose `.text` are joined with newlines;
`toolCallId` links back to the `calls` map; `toolName` names the tool (falling back to the call's
`name`, then `"tool"`); `isError` is a boolean; `details` is an object populated by some tools.
Three branches, tried **in this order**, each ending the entry:

1. **`details.patch`** (string, non-blank after trim) → a `diff` item. This is a real unified diff
   that pi computes for an edit, the same data pi-cc renders inline, so this extension needs no
   differ of its own. The edit's *result* text is a useless one-liner
   (`Successfully replaced 1 block(s)…`) and is discarded. The file path comes from the **call's**
   `args.path`, not from the patch; the body is `# <path>\n\n<patch>`; the `+N −M` counts in the
   picker are line counts that explicitly exclude `+++` and `---` headers.
2. **`tool === "write"` with a string `call.args.content`** → a `tool` item whose text is the
   content that was written. A write result carries **no `details` at all**, so the call arguments
   are the only copy of what went into the file; the suggested filename is the written file's
   basename so the editor highlights it correctly.
3. **otherwise** the result text itself, skipped entirely when empty.

> Correction to a common belief: `details.firstChangedLine` is **not** read — the string
> `firstChangedLine` appears nowhere in this repo. `patch` is the only key taken off `details`.
> The file's header comment notes pi also computes `details.diff`, the same diff with line numbers
> prepended; that variant is deliberately unused, because the numbers would break `paintDiff`'s
> prefix matching.

## Modules

### `collect()`

The single pass described above, producing `Item[]` in session order. An `Item` carries `kind`
(`"tool" | "thinking" | "bash" | "diff"`), `label` (what produced it), `detail` (the command, file
or preview shown in the picker), the full `text`, a precomputed `lines` count, a `suggestedName`
for the editor, `isError`, the owning `prompt`, and `at`. The running counter `n` numbers the
suggested filenames in session order and is incremented only when an item is actually pushed.

Helpers: `nameFor()` builds a filename that gives the editor a chance at syntax highlighting —
`NN-<basename>` when the call had a `path` or `file` argument, `NN-reasoning.md` for thinking,
`NN-<tool>.txt` otherwise. `preview()` deliberately skips the opening line of a reasoning block,
because they nearly all start "We need to…" / "Let's…" / "Okay…" and that makes a useless label;
it takes the first line longer than 25 characters that does not match that pattern. `oneLine()`
flattens whitespace and ellipsises. `ago()` renders `Ns/Nm/Nh ago`.

### `rowsFor()` and grouping

Reverses the items (newest first) and inserts a `{ kind: "group" }` row whenever the owning
`prompt` changes, so the picker reads as "the message you sent, then what happened after it" —
which is how you actually remember an output.

### `Picker`

A `Component` over `Row[]`. Three things it does that a flat list cannot: groups under the owning
message; previews the highlighted item's text in a right-hand pane so you confirm before
committing; and filters on `label`, `detail`, `prompt` **and the full text**, so something you
remember it *saying* will find it.

`rebuild()` re-applies the filter and then keeps only the newest `MAX_ENTRIES` (40) matches — the
picker is for finding something recent, not browsing all of history. `move()` skips group rows and
scrolls `top` to keep the cursor inside the `height - 4` list rows. `render()` splits the width
into a list pane (42% of the inner width, clamped to 30–64 columns) and a preview pane; the
selected row is marked `→`, an errored one `✗`. The title line tells you in advance which way
Enter will go: `enter → editor` or `enter → pager`.

`handleInput` maps escape (close with nothing), enter (close with the current item), up/down,
backspace, and any single printable ASCII character as a filter keystroke. `handleMouse` returns
`{ handled: true }` so clicks are swallowed rather than falling through to the transcript.

### `Pager`

A plain bordered overlay that renders **all** its lines at once — there is no scrolling. That is
only safe because `show()` sends anything over `OPEN_IN_EDITOR_LINES` to the editor instead.
Escape, enter or `q` closes it. Exported since 23 Sept 2026: [[argo]] pages `/argo spend`
through it (argo-dash's report is ~40 lines, under the limit).

### `paintDiff()`

The unified-diff colouring, using the same theme entries the transcript's diffs use. Order is
load-bearing: `^\+\+\+|^---` is tested **first** so file headers come out `dim` rather than being
mistaken for added/removed lines, then `@@` → `accent`, `+` → `toolDiffAdded`, `-` →
`toolDiffRemoved`, `#` → `dim` (this is the `# <path>` header `collect()` prepends to a diff body),
and everything else → `toolDiffContext`. Covered by `tests/paint-diff.test.mjs`, which extracts the
function body out of the source between `function paintDiff` and the `/** A bordered read-only
page` doc comment above `Pager`, strips the TS annotations and evals it — so **renaming
`paintDiff` or moving or re-commenting `Pager` breaks that test** (exporting the class did, once).
It was written this way because driving a model into making a real edit took ~90s per run.

### Editor handoff and the temp-file lifecycle

`dir` is `join(tmpdir(), "pi-open-<pid>")` — one directory per pi process, so the editor's open
tabs stay valid for as long as the session does. It is created lazily on the first handoff
(`dirMade`) and removed in the `session_shutdown` handler, inside a try/catch, because a leftover
temp dir is not worth a crash on the way out.

`editorCommand()` prefers `$VISUAL`, then `$EDITOR`, split on whitespace so `code -w` works; with
neither set it probes `code`, `cursor`, `subl`, `zed` via `spawnSync("command", ["-v", …], { shell:
true })` and takes the first that exists.

`openInEditor()` writes `item.text` (adding a trailing newline if missing) to
`dir/item.suggestedName`, then spawns the editor `detached` with `stdio: "ignore"` and `unref()`s
it, so the editor window outlives the command and you keep working in the terminal. With no editor
found it just notifies the path; an editor that fails to start notifies the path too. Nothing is
ever left without the user being told where the file is.

### 22 Sept 2026 review fixes

- `$EDITOR` set to a terminal editor (`vim`, `nano`, …) was spawned detached with no TTY, so nothing
  opened while the user was told `→ vim`. Known terminal editors now get "Wrote <file> — open it from
  another shell"; GUI editors are still launched (M9).
- `session_shutdown` no longer deletes the handoff directory on a `/reload` (`event.reason ===
  "reload"`): it is per pid and the next activation reuses it, and editors still had the files open
  (M10). On a crash the directory leaks; on a genuine exit it is removed.
- `?? "change"` / `?? "file"` / `?? "written.txt"` could never fire (`"".split("/").pop()` is `""`,
  not `undefined`), so names came out as `NN-.diff`; they are `||` now. `PI_OPEN_EDITOR_LINES=""`
  gave 0 and a non-number gave `NaN` (silently inverting behaviour); knobs are finite-or-default.
  `collect()` treats a non-array `content` as empty instead of throwing and emptying the picker; the
  child-process `error` listener — the one continuation here the host does not catch — is guarded.

### `/open` follows the attached agent (22 Sept 2026)

The collector is `collectFrom(branch)`, pure and exported. `/open` feeds it the parent's branch —
or, while attached to a subagent through [[fleet]], that agent's: fleet's `statusbar:attached`
event carries a live `branch()` accessor (read at call time, never captured, since the branch keeps
growing), and an empty payload on detach restores the parent. The notify says whose session it is
looking at. Tested in `tests/outputs-collect.test.mjs` through fleet's event. A `bashExecution`
item carries the command as `detail` and the output as `text`.

## Invariants a future change must not break

- **Read the session branch, never the rendered transcript.** The whole value of `/open` is showing
  content the display truncated.
- **Keep the optional chaining on `sessionManager?.getBranch?.()`.** A host without one must yield
  an empty picker, not an exception inside a command handler.
- **Keep the `role: "bashExecution"` branch.** `!bash` never arrives as a toolResult; dropping this
  silently empties the picker for whole classes of session.
- **Keep the three toolResult branches in order** (patch → write → generic text), each `continue`ing.
  Reordering them turns an edit back into a one-line status message and a write back into
  "Successfully wrote …".
- **Build the `calls` map in the same forward pass.** Arguments exist only on the assistant's
  `toolCall` block; a result reached before its call would lose its path and its write content.
- **`paintDiff` must test `+++`/`---` before `+`/`-`,** and must keep the `#` case that dims the
  `# <path>` header `collect()` adds.
- **The temp dir must be removed on `session_shutdown`,** and files must only ever be written inside
  it.
- **`suggestedName` must keep a meaningful extension** — it is the only thing giving the editor a
  shot at syntax highlighting.
- **The pager must only ever receive short content.** It renders every line with no scrolling.

## Gotchas

- `PI_OPEN_EDITOR_LINES` is read at load, so raising it past the terminal height makes the
  non-scrolling `Pager` overflow the screen. The 40-line default is what keeps it honest.
- Reasoning blocks shorter than `MIN_THINKING_CHARS` (200) are dropped entirely and cannot be found
  by filtering; there is no "show everything" escape hatch.
- The picker caps at 40 rows **after** filtering, and takes the newest 40 — an old item that matches
  your filter can still be pushed out by newer matches.
- `/open <arg>` filters first and the picker filters again; the same predicate is written out twice,
  in the command handler and in `Picker.rebuild()`. Change one, change the other.
- The generic tool item's `detail` is `Object.values(call.args).map(String).join(" ")`, so an object
  argument renders as `[object Object]`.
- If a `write` result ever grows a `details.patch`, branch 1 wins and it becomes a diff — arguably
  fine, but it is why the write branch can look dead in some sessions.
- `dir` is keyed on `process.pid`, not a session id. It is correct in practice because a pi process
  is a session, but a crash (no `session_shutdown`) leaves the directory behind in `$TMPDIR`.
- Filter input accepts only single printable ASCII characters, so a bracketed paste or any non-ASCII
  key is ignored rather than inserted.
- `git hash-object` this file after any edit and run `bash scripts/check-docs.sh --fix`; the hash in
  this note's frontmatter is what makes the staleness check work.

## Related

- [[statusbar]] — the other big overlay consumer; `/open` deliberately publishes **no** slot to it.
- [[code-panels]] — the other display-side extension, and a contrast: it patches a pi internal,
  this one does not.
- [[image-window]] — also walks messages, but the *outgoing* `context` array, a different shape.
- [[../architecture/pi-internals]] — session branch, `ctx.ui.custom`, component contract.
- [[../00-start-here]] — vault conventions and the shutdown/`/reload` invariants.
