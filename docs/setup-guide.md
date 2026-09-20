# Set up Pi for the globus inference endpoint

**For the coding agent doing the setup.** Your user has SSH access to the lab's **globus** cluster.
Your job is to install [Pi](https://pi.dev), a terminal coding agent, and point it at the lab's
shared model endpoint. When you finish, their setup should match one that was built and tested
on 2026-09-14 against **Pi 0.85.1** and **Qwen3.8-Flash-Next**.

The finished setup gives the user:

- `pi` in a terminal, using the cluster's model by default. **Running it opens the SSH tunnel
  automatically.** If the tunnel can't open, Pi prints why and starts anyway.
- The model's reasoning effort mapped correctly onto Pi's thinking levels, which Pi does not do
  on its own (see step 3).
- A layout close to Claude Code's:
  - thinking collapsed to "Thought for Xs"
  - one-line tool rows with diffs, which you click to expand
  - code blocks drawn as tinted panels instead of literal ``` fences
- Subagents: an `Agent` tool with Explore, Plan and general-purpose types, capped so they don't
  swamp the shared GPU.

Work through the steps in order. Each has a check; don't move on until it passes.

**Part 2** (section 11 onwards, at the end of this file) adds what came later: the ALCF gateway as
a second provider, a right-hand column instead of the bottom status line, an interactive subagent
list you can attach to, and a dev → review → critique round runner. Its local files ship as
`pi-lab-kit.tar.gz` next to this guide. Part 1 first.

---

## 0. Ground rules

1. **Don't overwrite user files without looking first.** Before writing any file below, check
   whether it exists. If it does, show the user and **merge** your changes in, or back it up to
   `<file>.bak` first. That applies especially to `~/.pi/agent/settings.json`,
   `~/.pi/agent/models.json` and the shell rc file.
2. **Install only the pinned versions listed here.** Pi packages run with full access to the
   machine. The two third-party packages below were source-reviewed at exactly these versions: no
   network calls and no install scripts. `pi-subagents` runs only `git` (for worktrees) and
   commands from optional workflow scripts, which this guide turns off. Check each package's
   integrity hash before installing. If a pinned version is gone, stop and ask the user. Don't
   substitute `latest` without reviewing the source yourself.
3. **Don't change anything on the cluster.** This is all client-side. No `sudo` is needed anywhere.
4. **The GPU is shared by the whole lab.** It serves 8 requests at once in total. Keep test
   prompts small and never run load tests or parallel loops against it.

## 1. Prerequisites

Check each of these and report anything missing to the user before continuing.

| Requirement | Check | Notes |
|---|---|---|
| SSH access to globus1 | `ssh globus1 true` | Must succeed **without a password prompt** (key in agent or keychain). If `globus1` isn't a configured alias, see below. |
| Node.js ≥ 22.19 | `node -v` | Required by Pi and by the UI package. |
| `python3`, `curl` | `command -v python3 curl` | Used by the tunnel helper. `lsof` is optional; it only improves one error message. |
| Shell | `echo $SHELL` | zsh or bash. The launcher function works in both. |
| Local port 8000 free | `lsof -nP -iTCP:8000 -sTCP:LISTEN` | If something else holds it, use another port. Every `8000` below must then change consistently. |

**If `ssh globus1` doesn't resolve,** add a host alias to `~/.ssh/config`. Use the user's own
cluster username and key:

```sshconfig
Host globus1
    HostName <the cluster's hostname — ask the lab>
    User <their-cluster-username>
    IdentityFile <their-key>
```

Alternatively, set `GLOBUS_TUNNEL_HOST=<user>@<cluster-host>` in the environment. The
tunnel helper honours it.

## 2. Install Pi

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.85.1
npm view @earendil-works/pi-coding-agent@0.85.1 dist.integrity
# expect: sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==
```

**Check:** `pi --version` prints `0.85.1`. A newer Pi is probably fine, but the code-panel
extension in step 7 was written against 0.85.1, so say so if you install a different version.

## 3. Tunnel, endpoint check, and the model's real parameters

### 3a. The tunnel helper

The endpoint is deliberately not exposed publicly; you reach it with an SSH port-forward to
globus1. Create `~/.local/bin/globus-tunnel` and run `chmod +x` on it:

```bash
#!/usr/bin/env bash
# globus-tunnel — keep an SSH tunnel to the globus inference endpoint open.
#
#   globus-tunnel ensure   # open it if needed, then report health (default)
#   globus-tunnel status   # report only, never connects
#   globus-tunnel stop     # close the tunnel this script opened
#
# Never blocks for long and never prompts: every failure prints one diagnosis to
# stderr and exits non-zero, so callers (the pi() shell function) can carry on.
#
# The tunnel is its own ssh master on a private socket, so it is independent of
# the ControlMaster used for interactive `ssh globus1`, and it outlives the pi
# session that opened it — concurrent pi sessions share it.

set -uo pipefail

HOST=${GLOBUS_TUNNEL_HOST:-globus1}
PORT=${GLOBUS_TUNNEL_PORT:-8000}
SOCK="$HOME/.ssh/globus-tunnel-$PORT.sock"
URL="http://127.0.0.1:$PORT/v1/models"

say() { printf 'globus-tunnel: %s\n' "$*" >&2; }

ours_alive() { [ -S "$SOCK" ] && ssh -S "$SOCK" -O check "$HOST" >/dev/null 2>&1; }

# Prints the served model id; fails if nothing answers like the endpoint.
served_model() {
    curl -fsS -m 4 "$URL" 2>/dev/null |
        python3 -c 'import sys,json; print(json.load(sys.stdin)["data"][0]["id"])' 2>/dev/null
}

port_owner() { lsof +c 0 -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"}'; }

report() {
    local model
    if model=$(served_model); then
        say "endpoint up on localhost:$PORT — serving $model"
        return 0
    fi
    if ours_alive; then
        say "tunnel is up but the endpoint is not answering."
        say "  the model may be reloading (~13 min after its 2-day requeue). check:"
        say "  ssh $HOST squeue -n qwen38-serve"
        return 3
    fi
    local owner; owner=$(port_owner)
    if [ -n "$owner" ]; then
        say "localhost:$PORT is held by $owner, and it is not answering as the endpoint."
        say "  if that is your own tunnel, the model may be reloading; otherwise free the port"
        say "  or pick another with GLOBUS_TUNNEL_PORT (and update ~/.pi/agent/models.json)."
        return 4
    fi
    say "no tunnel on localhost:$PORT."
    return 2
}

open_tunnel() {
    [ -e "$SOCK" ] && ! ours_alive && rm -f "$SOCK"   # stale socket from a dead master

    local err
    # BatchMode: never sit at a passphrase/host-key prompt. -f returns once the
    # connection and the forward are established (ExitOnForwardFailure).
    if ! err=$(ssh -f -N -M -S "$SOCK" \
            -o ControlPersist=no \
            -o BatchMode=yes \
            -o ConnectTimeout=8 \
            -o ExitOnForwardFailure=yes \
            -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
            -L "$PORT:127.0.0.1:$PORT" "$HOST" 2>&1); then
        say "could not open the tunnel to $HOST: ${err##*$'\n'}"
        case "$err" in
            *"timed out"*|*"resolve"*|*"unreachable"*)
                say "  are you on a network that can reach $HOST (VPN?)" ;;
            *"Permission denied"*|*"passphrase"*)
                say "  ssh key not available non-interactively — run 'ssh $HOST true' once" ;;
        esac
        return 2
    fi

    # The forward is bound, but give vLLM a moment to answer through it.
    local i
    for i in 1 2 3 4 5; do
        served_model >/dev/null && break
        sleep 1
    done
}

cmd=${1:-ensure}
case "$cmd" in
    ensure)
        if served_model >/dev/null; then exit 0; fi   # already fine: stay silent
        if ! ours_alive && [ -z "$(port_owner)" ]; then
            say "opening tunnel to $HOST ..."
            open_tunnel || exit $?
        fi
        report
        ;;
    status)
        report
        ;;
    stop)
        if ours_alive; then
            ssh -S "$SOCK" -O exit "$HOST" >/dev/null 2>&1 && say "tunnel closed."
        else
            rm -f "$SOCK"; say "no tunnel opened by globus-tunnel is running."
        fi
        ;;
    -h|--help)
        sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
        ;;
    *)
        say "unknown command: $cmd (ensure|status|stop)"; exit 64
        ;;
esac
```

**Check:** `~/.local/bin/globus-tunnel ensure` prints
`endpoint up on localhost:8000 — serving <model-id>`. Its exit codes: 2 means it can't connect,
3 means the tunnel is up but the model isn't answering, 4 means the port is taken.

### 3b. Confirm the served model name and which reasoning efforts it accepts

**Don't copy the values in step 4 blindly.** The cluster can swap models (the documented
rollback is `qwen3.8-27b`), and the accepted effort values differ between models.

```bash
curl -s http://127.0.0.1:8000/v1/models | python3 -m json.tool   # note data[0].id and max_model_len
```

Next, check which `reasoning_effort` values the server accepts. Each test is tiny, but run them
one at a time, not in parallel:

```bash
python3 - <<'EOF'
import json, urllib.request, urllib.error
model = json.load(urllib.request.urlopen("http://127.0.0.1:8000/v1/models"))["data"][0]["id"]
for eff in ["none", "low", "medium", "high", "xhigh", "minimal", "max"]:
    body = {"model": model, "max_completion_tokens": 16, "reasoning_effort": eff,
            "messages": [{"role": "user", "content": "Say OK."}]}
    req = urllib.request.Request("http://127.0.0.1:8000/v1/chat/completions", json.dumps(body).encode(),
                                 {"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=120); print(eff, "OK")
    except urllib.error.HTTPError as e:
        print(eff, e.code, e.read().decode()[:120])
EOF
```

**Results on 2026-09-14 (Qwen3.8-Flash-Next):** `none`, `low`, `medium` and `xhigh` return OK.
`high`, `minimal` and `max` return **400**. The cluster's own `CLIENTS.md` says `high` is an
alias; that was true for the old 27B model and is wrong now.

This is why step 4 needs a `thinkingLevelMap`, for two reasons:
- **Pi sends Pi's level names as-is.** Choosing "high" in Pi would therefore make every request
  fail.
- **For "off", Pi sends no effort at all,** so the server applies its own default and the model
  thinks anyway. "off" has to be mapped to `none` explicitly.

If your results differ, adjust the map. Point each Pi level (`off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max`) at an accepted server value, or set it to `null` to hide that level.

## 4. `~/.pi/agent/models.json`

Change `id` if step 3b found a different model, and `contextWindow` if `max_model_len` differs.

```json
{
  "providers": {
    "globus": {
      "name": "Globus cluster (vLLM on globus3)",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "api": "openai-completions",
      "apiKey": "sk-local",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsStore": false
      },
      "models": [
        {
          "id": "qwen3.8-flash-next",
          "name": "Qwen3.8 Flash-Next (globus)",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 262144,
          "maxTokens": 32768,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "thinkingLevelMap": {
            "off": "none",
            "minimal": null,
            "low": "low",
            "medium": "medium",
            "high": "xhigh",
            "xhigh": null,
            "max": null
          }
        }
      ]
    }
  }
}
```

Why the less obvious fields are there:
- **`apiKey`:** the server ignores it, but Pi won't list a model that has no key.
- **Authentication:** the SSH tunnel is the real authentication.
- **`supportsDeveloperRole: false`:** sends the system prompt as a plain `system` message, the
  chat template's native role.
- **`maxTokens: 32768`:** thinking and the answer share this budget.

**Check:** `pi --list-models` shows `globus  qwen3.8-flash-next  262.1K  32.8K  thinking yes  images yes`.

## 5. `~/.pi/agent/settings.json`

Merge these keys into whatever file already exists; Pi keeps its own keys such as
`lastChangelogVersion` in there. Leave out `packages`, because step 6 adds it through `pi install`.

```json
{
  "theme": "cc-light",
  "defaultProvider": "globus",
  "defaultModel": "qwen3.8-flash-next",
  "defaultThinkingLevel": "medium",
  "hideThinkingBlock": true,
  "tuiMode": "fullscreen",
  "markdown": { "mermaid": "final" }
}
```

What each setting does:
- **`theme`:** `cc-light` and `cc-dark` come from step 6. Ask the user whether they want light or
  dark, and use `"dark"` or `"light"` until step 6 is done.
- **`hideThinkingBlock`:** collapses thinking by default. `Ctrl+T` toggles it and saves the choice.
- **`tuiMode: "fullscreen"`:** needed for clicking to expand. Pi marks it experimental.
  - It takes over scrollback, so mouse-wheel scrolling and `Ctrl+F` search happen inside Pi.
  - Dragging to select text copies it.
  - On **iTerm2**, if trackpad scrolling is slow: Settings → Advanced → "Trackpad scrolls fast?" → No.
  - To opt out, use `"regular"`: the keyboard toggles still work, clicking doesn't.
- **`markdown.mermaid: "final"`:** draws Mermaid diagrams once when the reply finishes, instead
  of redrawing them as it streams.

## 6. The launcher function

Append this to `~/.zshrc` or `~/.bashrc`; it works in both.

**Why a function and not a wrapper script:** nvm, and some Node installs, put their own `bin`
first on `PATH`, so a `pi` script elsewhere would never run.

```sh
# pi — open the globus inference tunnel first (~/.local/bin/globus-tunnel).
# Tunnel trouble is reported, never fatal: pi still starts. Skipped for
# help/version/model listing, for a non-globus --provider/--model, or with PI_NO_TUNNEL=1.
pi() {
  local a skip="${PI_NO_TUNNEL:-}" prev=""
  for a in "$@"; do
    case "$a" in -h|--help|-v|--version|--list-models) skip=1 ;; esac
    [ "$prev" = "--provider" ] && [ "$a" != "globus" ] && skip=1
    case "$prev:$a" in --model:globus/*) ;; --model:*/*) skip=1 ;; esac
    prev=$a
  done
  if [ -z "$skip" ] && ! "$HOME/.local/bin/globus-tunnel" ensure; then
    printf '%s\n' "pi: starting anyway - requests to globus will fail until the endpoint is reachable." >&2
  fi
  command pi "$@"
}
```

**Check:**
1. `~/.local/bin/globus-tunnel stop`
2. In a new shell, `type pi` should report a shell function.
3. `pi --no-session -p "Reply with just: ok"` should open the tunnel and print `ok`.

## 7. UI packages and extensions

### 7a. `pi-cc-extensions`: Claude Code-style transcript

It adds compact tool rows, click-to-expand, split diffs, collapsed thinking, `/context`,
`/ccstyle` and the `cc-light`/`cc-dark` themes.

```bash
npm view pi-cc-extensions@0.8.71 dist.integrity
# expect: sha512-AdXHT4vH/9NCf6W3Kpj0z3ixOVmqsrp3NXRaTpmnom0pWUKAqqcdl0UYSoRcx62rigNCRpwOIZwB93BiEkU/Pg==
pi install npm:pi-cc-extensions@0.8.71
```

Create `~/.pi/agent/claude-code-style.json` so thinking collapses to a single line with no
preview. The package's default is a rolling 3-line preview:

```json
{
  "previewLines": 0
}
```

Install only **one** package that changes how tool calls are drawn. `better-claude-code-ui`,
`pi-tool-display`, `pi-claude-code-ui` and similar packages conflict with this one.

### 7b. `code-panels.ts`: code blocks without fences

Pi's markdown renderer always prints the ``` fence lines, and no setting removes them. This
small local extension draws code blocks as tinted panels with a language label instead. It
doesn't change the saved conversation or what the model sees.

It replaces the renderer's internal `renderToken` method, which isn't a documented extension
hook. If a future Pi release changes that method, the extension switches itself off and the
fences come back.

Create `~/.pi/agent/extensions/code-panels.ts`:

````ts
/**
 * code-panels — render fenced code blocks as tinted panels instead of literal ``` fences.
 *
 * Pi's Markdown renderer hard-codes the fence lines (pi-tui components/markdown.js, `case "code"`),
 * and markdown transformers run before rendering, so they cannot remove them. This wraps
 * Markdown.prototype.renderToken for code tokens only and leaves every other token untouched.
 *
 * Output per block: a panel header carrying the language label, then the syntax-highlighted code
 * with a one-column inset, each line padded to full width on a theme background. The tint is a
 * background color, not gutter characters, so copying a selection yields clean code.
 *
 * Display-only: the session and model context keep the original Markdown.
 * Written against Pi 0.85.1; if a Pi update changes renderToken, the guard below falls back to
 * Pi's own rendering rather than breaking the transcript.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// Tweak here. Backgrounds: selectedBg | userMessageBg | customMessageBg | toolPendingBg | toolSuccessBg
const PANEL_BG = "toolPendingBg" as const;
const INSET = " ";
const SHOW_LANGUAGE_LABEL = true;

const PATCHED = Symbol.for("code-panels.patched");
// Global so a /reload's fresh module instance feeds the already-installed patch.
const THEME_SLOT = Symbol.for("code-panels.theme");
const slot = globalThis as { [THEME_SLOT]?: () => Theme | undefined };

function renderPanel(token: { text: string; lang?: string }, width: number, theme: Theme): string[] {
	const bgAnsi = theme.getBgAnsi(PANEL_BG);
	// Highlighters and theme.fg emit resets; re-arm the background after any that would clear it.
	const keepBg = (s: string) => s.replace(/\x1b\[(?:0|49)?m/g, (m) => m + bgAnsi);
	const fill = (s: string) => {
		const pad = Math.max(0, width - visibleWidth(s));
		return `${bgAnsi}${keepBg(s)}${" ".repeat(pad)}\x1b[49m`;
	};

	const lang = (token.lang ?? "").trim().split(/\s+/)[0] ?? "";
	const lines: string[] = [];
	lines.push(fill(SHOW_LANGUAGE_LABEL && lang ? theme.fg("mdCodeBlockBorder", `${INSET}${lang}`) : ""));

	const inner = Math.max(1, width - INSET.length * 2);
	for (const codeLine of highlightCode(token.text, lang || undefined)) {
		const wrapped = codeLine.length === 0 ? [""] : wrapTextWithAnsi(codeLine, inner);
		for (const piece of wrapped) lines.push(fill(`${INSET}${piece}`));
	}
	lines.push(fill(""));
	return lines;
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const ui = ctx.ui;
		// Read lazily so /theme switches apply; non-TUI modes may have no theme.
		slot[THEME_SLOT] = () => {
			try {
				return ui.theme;
			} catch {
				return undefined;
			}
		};
	});

	const proto = Markdown.prototype as unknown as {
		renderToken: (token: any, width: number, nextTokenType?: string, styleContext?: unknown) => string[];
		[PATCHED]?: boolean;
	};
	if (proto[PATCHED] || typeof proto.renderToken !== "function") return; // /reload safety, API drift
	const original = proto.renderToken;

	proto.renderToken = function (token, width, nextTokenType, styleContext) {
		const theme = slot[THEME_SLOT]?.();
		if (token?.type !== "code" || typeof token.text !== "string" || !theme) {
			return original.call(this, token, width, nextTokenType, styleContext);
		}
		try {
			const lines = renderPanel(token, width, theme);
			if (nextTokenType && nextTokenType !== "space") lines.push("");
			return lines;
		} catch {
			return original.call(this, token, width, nextTokenType, styleContext);
		}
	};
	proto[PATCHED] = true;
}
````

## 8. Subagents: `@tintinweb/pi-subagents`

This adds a Claude Code-style `Agent` tool (Explore / Plan / general-purpose), `/agents`, `@agent`
mentions, and a live list of running agents. `pi-cc-extensions` already draws its tool rows.

```bash
npm view @tintinweb/pi-subagents@0.19.0 dist.integrity
# expect: sha512-DZsU33Urfb9dhEsJmsmpx0dayIHMYUbxng6AA7B6+bIgspNcTckcSnQRsbrv+QCS7jVKYJTzHIT/j1SU2B/nVQ==
pi install npm:@tintinweb/pi-subagents@0.19.0
```

Create `~/.pi/agent/subagents.json`. **These limits matter because the GPU is shared**:

```json
{
  "maxConcurrent": 3,
  "maxConcurrentForeground": 2,
  "workflowsEnabled": false
}
```

The package defaults don't suit a shared endpoint limited to 8 concurrent requests:

| Setting | Default | Set to | Reason |
|---|---|---|---|
| `maxConcurrent` | 10 | 3 | Maximum background agents running at once. |
| `maxConcurrentForeground` | unlimited | 2 | Parallel agents on a local model also hurt its reuse of cached context. |
| `workflowsEnabled` | on | false | Scripted workflows fan out to `min(16, CPU cores − 2)` agents, which is 16 on a typical workstation. |

The built-in Explore agent asks for Claude Haiku. That isn't configured here, so it falls back to
the Qwen model, which is expected.

## 9. Acceptance tests

Run these from a throwaway directory. They make a handful of small requests to the shared
endpoint.

```bash
mkdir -p /tmp/pi-accept && cd /tmp/pi-accept
printf 'def add(a, b):\n    return a - b\n\ndef mul(a, b):\n    return a * b\n' > calc.py
```

1. **Tool loop.** Run
   `pi --no-session -p "calc.py has a bug. Read it, fix it with the edit tool, then run: python3 -c 'from calc import add; print(add(2,3))' and report the output."`
   It should report `5`, and `calc.py` should now contain `a + b`.
2. **Every thinking level.** Run
   `for t in off low medium high; do pi --no-session --thinking $t -p "What is 17*23? Just the number."; done`
   Expect `391` four times and no 400 errors.
3. **Subagent.** Reset `calc.py` as above, then run
   `pi --no-session -p "Use the Agent tool (subagent_type Explore, run_in_background false) to find which function in calc.py is buggy. Do not read the file yourself. Then tell me in one sentence what it found."`
   It should name `add`.
4. **Interactive UI.** Ask the user to run `pi` and confirm:
   - The startup header lists `[Extensions] @tintinweb/pi-subagents@0.19.0…, code-panels.ts, pi-cc-extensions@0.8.71`.
   - Asking for a Python snippet shows a tinted panel labelled `python`, with no ``` lines.
   - Clicking a `✓ Read …` row, or a thinking row's **"click to show more"**, expands it.
   - `/agents` opens the agents menu.

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Error: Connection error.` in Pi | No tunnel. Run `globus-tunnel status`. If the `pi` function isn't active, open a new shell or check `type pi`. |
| `tunnel is up but the endpoint is not answering` | The model job restarts about every 2 days (2-day Slurm limit) and takes about **13 minutes** to load. Check `ssh globus1 squeue -n qwen38-serve` and wait. |
| `400 … Unexpected reasoning effort …` | `thinkingLevelMap` is sending a value this model rejects. Re-run step 3b and fix the map. |
| `400 … model … does not exist` | The cluster switched models. Update `id` in `models.json` from `/v1/models`; it reloads when you open `/model`, no restart needed. |
| Model thinks even on "off" | `thinkingLevelMap.off` isn't `"none"`. |
| `ssh key not available non-interactively` | Load the key into the agent (`ssh-add`), or run `ssh globus1 true` once interactively. |
| Port 8000 already in use | Set `GLOBUS_TUNNEL_PORT=8001` (for example) in the shell rc **and** change `baseUrl` in `models.json` to match. |
| Tool rows look wrong or doubled | More than one tool-rendering package is installed; keep only `pi-cc-extensions`. |
| Code fences are back after a Pi update | `code-panels.ts` detected an internal change and switched itself off. The rest of Pi is unaffected. |

## About the endpoint (for the user)

- **Access:** anyone who can SSH to globus1 can use it. There are no API keys and nothing else to
  set up.
- **Browser chat:** also available at <http://localhost:8080>. It needs its own forward, with
  `-L 8080:127.0.0.1:8080` added.
- **Capacity:** one GPU runs 8 requests at once, behind a proxy that shares slots fairly between
  users. Scripted bulk jobs belong in Slurm, not on this endpoint.
- **Privacy:** the cluster docs say the model server doesn't write prompts or completions to
  disk. That was verified for the previous model and is being re-checked for Flash-Next. The
  browser chat does store history, and cluster admins can read it. Pi's own sessions are stored
  locally in `~/.pi/agent/sessions/`.
- **Pi telemetry:** `enableInstallTelemetry` is on by default. It sends an anonymous install and
  update ping and provider-attribution headers. Set it to `false` in `settings.json` if the user
  prefers.

## Undo

```bash
pi remove npm:@tintinweb/pi-subagents && pi remove npm:pi-cc-extensions
rm ~/.pi/agent/extensions/code-panels.ts ~/.pi/agent/subagents.json ~/.pi/agent/claude-code-style.json
~/.local/bin/globus-tunnel stop && rm ~/.local/bin/globus-tunnel
# then remove the pi() function from the shell rc file, and optionally:
npm uninstall -g @earendil-works/pi-coding-agent   # leaves ~/.pi/agent/ in place
```

---

# Part 2 — what came after

Part 1 above is the 2026-09-14 setup against Pi 0.85.1. Everything below was added and tested on
**2026-09-20 against Pi 0.86.0**: a second inference provider (the ALCF gateway), a right-hand
column instead of the bottom "chin", an interactive subagent list you can attach to, and a
dev → review → critique round runner.

The local files for all of it ship as **`pi-lab-kit.tar.gz`** alongside this guide. Do Part 1
first; none of this replaces it.

```bash
tar xzf pi-lab-kit.tar.gz && cat pi-lab-kit/README.md
cp pi-lab-kit/extensions/*.ts ~/.pi/agent/extensions/
cp -r pi-lab-kit/agents       ~/.pi/agent/
cp pi-lab-kit/bin/*           ~/.local/bin/ && chmod +x ~/.local/bin/{globus-tunnel,alcf-token}
```

Add `"tuiMode": "fullscreen"` to `~/.pi/agent/settings.json` — the right-hand column needs it.
Regular mode draws into the terminal's own scrollback and has no layout root to rebuild, so the
column silently stays off there.

## 11. The ALCF gateway as a second provider

The lab endpoint stays the default; ALCF's clusters (Minerva, Metis, Sophia) become extra
providers, so `/model` lists both and the column always says which one a reply came from.

Authentication is a Globus access token, which expires. `bin/alcf-token` fetches one, caches it
for 10 minutes, and prints it; `models.json` runs it **per request** through Pi's `!command`
syntax, so nothing is ever stored in a config file:

```bash
uvx alcf-ai auth login          # once, interactive, opens a browser
alcf-token --status             # cache age and whether credentials exist
```

Merge one provider block per cluster into `~/.pi/agent/models.json`:

```json
"alcf-minerva": {
  "name": "ALCF Minerva · inference-api.alcf.anl.gov/…/minerva",
  "baseUrl": "https://inference-api.alcf.anl.gov/resource_server/minerva/api/v1",
  "api": "openai-completions",
  "apiKey": "!~/.local/bin/alcf-token",
  "authHeader": true,
  "compat": {
    "supportsStore": false,
    "supportsDeveloperRole": false,
    "maxTokensField": "max_tokens",
    "supportsStrictMode": false
  },
  "models": [
    { "id": "gpt-oss-120b", "name": "GPT-OSS 120B — ALCF Minerva", "reasoning": true,
      "input": ["text"], "contextWindow": 131072, "maxTokens": 32768,
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "thinkingLevelMap": { "off": null, "minimal": null, "low": "low", "medium": "medium",
                            "high": "high", "xhigh": null, "max": null } }
  ]
}
```

Repeat with `metis` and `sophia` in the URL. Sophia's model ids carry a vendor prefix
(`openai/gpt-oss-120b`); the others don't. The `compat` block matters — without it Pi sends
fields the gateway rejects with a 400.

**Check:** `/endpoints` inside Pi lists each cluster as live, queued or cold, and names the models
it will actually serve. A model listed in `models.json` but not served is shown with the reason.

## 12. The right-hand column: `statusbar.ts`

Pi prints every extension's `setStatus()` text on one line, sorted by key and truncated, so with
three or four extensions installed the last ones simply fall off. This extension takes over the
footer and, in fullscreen mode, rebuilds Pi's layout root from `VStack[transcript, dock]` into
`VStack[HStack[transcript, sidebar], dock]`.

The column shows endpoint, model and thinking level, a context bar, images, usage, and **output
tokens/s over a 10-second sliding window**. A `~` on the rate means the provider didn't report
token counts while streaming (the ALCF gateway sends a reply in one burst), so it's estimated
from characters.

Width: 36 columns at ≥150 terminal columns, down to 24, label and value stacking below 30, and
the whole column hidden below 72 — the footer comes back instead. `/sidebar` toggles it,
`/status` opens the same information as a full-screen dashboard.

If a future Pi release changes the layout root's shape, the rebuild is skipped and the footer
stays. Nothing else in the session is touched.

## 13. The subagent fleet: `fleet.ts`

Replaces `@tintinweb/pi-subagents`' own widget and FleetView (set `"widgetMode": "off"` and
`"fleetView": false` in `~/.pi/agent/subagents.json`) with a single list:

```
● Agents · 1 running · 2 done                                              ↓ select
├─ ✓ reviewer review A  ↻5 · 4 tools · 18.7k (4%) · 5s · ↗ ALCF Minerva
└─ ○ reviewer review B  ↻8 · 8 tools · 35.4k (9%) · 132 t/s · 20s · ↗ ALCF Sophia
     ⎿ → read, grep
```

Keys work when the prompt is empty: **↑/↓** select, **Enter attaches**, **s** steers, **m**
changes that agent's model mid-run. Attaching swaps the transcript for the agent's own and
repoints the column's statistics at it; typing sends a steering message; **esc** detaches.
`/agent-model` with no arguments opens a menu of agents and models.

Changing one agent's endpoint mid-run works and costs only that agent's prompt cache. The main
session is unaffected.

## 14. Review rounds: `agents/` + `rounds.ts`

Three agent files define the roles. The reviewer and critic are pinned to **different endpoints
from the dev**, so a change is never graded only by the model that wrote it:

| Role | Model | Job |
|---|---|---|
| `dev` | session default (lab endpoint) | Implements one change and verifies it |
| `reviewer` | `alcf-minerva/gpt-oss-120b` | Finds real defects; each needs a failure scenario |
| `critic` | `alcf-metis/gpt-oss-120b` | Verifies the review, throws out what doesn't hold |

```
/round <task>               dev → review → critique
/round --rounds 2 <task>    hand what survived back to dev and go again
/round --reviewers 1 <task> one reviewer instead of the two-seat panel
/round status | /round stop
/review [focus]             review the working tree as it stands (no dev phase)
/rounds                     past reports; pick one to pull back into the conversation
```

Review is a **panel**: the reviewer role runs on two endpoints at once (Minerva and Sophia) and
the critic sees both, merging findings that are the same defect. A seat that returns nothing —
gpt-oss models occasionally end a turn having produced only reasoning — is retried once, then
dropped; the round continues with one viewpoint rather than failing.

Each run writes `.pi/rounds/<timestamp>.md` with every phase in full, and posts a trimmed summary
into the session (critique in full, other phases clipped) so the main model can act on it without
the whole thing landing in the context window. The verdict — `2 confirmed · 1 rejected` — also
appears in the column.

Sequencing goes over pi-subagents' cross-extension RPC (`subagents:rpc:spawn`, then the
`subagents:completed` / `subagents:failed` events, then `subagents:rpc:consume` so the completion
notification doesn't cost the parent a turn). Nothing depends on the main model remembering to
chain the phases.

## 15. Acceptance tests for Part 2

From a throwaway git repo with an uncommitted change:

```bash
mkdir -p /tmp/pi-part2 && cd /tmp/pi-part2 && git init -q
printf 'class C:\n    def __init__(self): self.n = 0\n' > c.py
git add -A && git -c user.email=t@t -c user.name=t commit -qm x
printf 'class C:\n    def __init__(self): self.n = 0\n    def inc(self, by=1): self.n += by\n' > c.py
pi
```

1. **Endpoints.** `/endpoints` lists globus plus the three ALCF clusters, each live / queued / cold.
2. **Column.** The right-hand column shows ENDPOINT, MODEL, CONTEXT, USAGE. Narrow the terminal
   below 72 columns: it becomes a two-line footer. Widen it: the column returns.
3. **Round.** `/review` runs two reviewers and a critic — the fleet list should show three agents
   on three different endpoints (`↗ ALCF Minerva`, `↗ ALCF Sophia`, `↗ ALCF Metis`) — then prints
   a verdict and writes `.pi/rounds/<timestamp>.md`.
4. **Attach.** While a round is running, press ↓ then Enter on an agent row: the transcript
   becomes that agent's and the column shows its model and context. Esc detaches.
5. **Stop.** Start `/review` again and run `/round stop` — running agents stop, and a partial
   report is still written.

A model that takes both `reasoning` and tool calls is required for the reviewer roles. If one
cluster is cold, `/round --reviewers 1` uses a single seat.
