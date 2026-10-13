# Customising

## The startup header

The block Pi opens with comes from a file: `~/.pi/agent/header.json`, or a project's
`.pi/header.json`, which wins — handy for a demo directory. Edit it and run `/header reload`;
`/header init` writes a starter if you have none, and `/header off` restores the built-in header
for the session.

```json
{
  "art": ["██████  ", "██  ██  ", "████  ██", "██    ██"],
  "artColors": ["#2a78d6", "#1baf7a"],
  "layout": "stacked",
  "lines": [
    "  {bold:pi} {dim:v{version}} {dim:·} {model} {dim:via} {endpoint}",
    "  {hints}",
    "  {accent:Globus Labs demo · {date}}"
  ]
}
```

| key | |
|---|---|
| `art` | lines drawn left of the text, or above it with `"layout": "stacked"`; left out on a terminal narrower than the art rather than cut mid-letter |
| `artStyle` · `artColors` | one theme colour for the art, or a colour per row (`#rrggbb` or theme names; the last repeats) — a gradient |
| `lines` | the text, in a small markup: `{style:text}` with any theme colour (`accent`, `muted`, `dim`, `mdLink`, `success`, …), `#rrggbb`, `bold` or `italic`, nestable |
| values | `{version}` `{model}` `{provider}` `{endpoint}` `{thinking}` `{cwd}` `{branch}` `{user}` `{host}` `{date}`, and `{hints}` — Pi's key hints from your own keybindings |

`\{` and `\}` are literal braces (`"\\{"` in a JSON string). The lab's header is the Globus
cluster's login wordmark with HARNESS for CLUSTER; `scripts/make-banner.py` draws the README's
banner from it.

pi-cc draws its own header and sets it after this one, so it must be off
(`"showStartupHeader": false` in `~/.pi/agent/pi-cc-extensions.json`); `/header` warns when it is on.

## pi-cc-extensions

[pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) gives the transcript its
Claude Code look — compact tool rows you click to expand, split diffs, collapsed thinking. From
0.9 it also ships a footer, a sticky prompt and a header; the harness owns those rows, so the
profiles install `~/.pi/agent/pi-cc-extensions.json` with them off:

```json
{ "previewLines": 0, "enableCustomFooter": false, "stickyUserMessage": false, "showStartupHeader": false }
```

`/ccstyle` is pi-cc's own settings panel for everything else.

## Smaller things

- **Code blocks** are drawn as tinted panels labelled with their language, without the ``` fences
  Pi otherwise prints.
- **`/images <n>`** sends at most the newest *n* images, so screenshots do not eat the context;
  `/images` shows the counts.
- **Pasting.** Pi needs the terminal to bracket a paste; without that, the first newline submits
  and every following line is sent as its own prompt. The harness catches a paste the terminal
  left unbracketed — keys arriving within a few milliseconds of each other, which typing never
  does — and puts it in the editor whole, with one notice naming the terminal setting to fix (in
  iTerm2: Profiles › Terminal › "Terminal may enable paste bracketing").
- **`PI_SKIP_VERSION_CHECK=1`** keeps Pi's "Update Available" box off the screen; useful for a demo.
