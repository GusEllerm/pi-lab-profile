# Setting up Globus Harness — a runbook for a coding agent

**You are a coding agent setting up Globus Harness on the user's machine.** Work through the steps
in order. Each ends with a check: run it, and do not move on until it passes. Where a step needs
something only the user can do — an account, a login in a browser, a Duo push — stop, tell them
exactly what to do, wait, then run the check. Report what you did and what you skipped at the end.

The long-form reference, with the reasoning behind each step and a troubleshooting section, is
[setup-guide.md](setup-guide.md). This runbook is the current, shortest path; where they differ,
follow this one.

## Ground rules

1. **Look before you write.** Before changing any file — `~/.pi/agent/settings.json`, a shell rc,
   `~/.ssh/config` — read it. Merge into it; never replace it. If you must replace one, back it up
   to `<file>.bak` first and say so.
2. **Install only the pinned versions below.** Pi packages run with full access to the machine;
   these versions were source-reviewed. If one is gone, stop and ask; do not substitute `latest`.
3. **No `sudo`, and nothing on any cluster.** Everything here is client-side.
4. **Credentials are the user's.** Never ask for a password or token to be pasted to you, and never
   write one into a file. Logins happen in the user's browser or terminal.
5. **The lab GPU is shared** by the whole lab (eight requests at once in total). Keep test prompts
   tiny and never loop requests against it.
6. **Headless Pi needs stdin closed:** run `pi -p "…" </dev/null`, or it waits for input. Do not
   start the interactive TUI yourself; ask the user to.

## 0. Ask the user two things

- **Are they a Globus Labs member?** Yes → the `lab` profile (the lab's GPU, ALCF, Argo and HPC
  config). No → the `example` profile (their own providers; nothing lab-specific).
- **Which endpoints do they want now?** Any of: the lab GPUs (needs a cluster account), the ALCF
  inference gateway (needs ALCF access), Argo (needs a CELS account with Duo and Argo
  authorisation), HPC through hpc-bridge (needs a facility allocation; the Globus Labs cluster
  needs only an account). None is required; skip the ones they do not have.

## 1. Prerequisites

```bash
node -v          # ≥ v22.19
python3 --version
command -v curl git
command -v uv    # only needed for hpc-bridge (and ALCF's one-time login runs through uvx)
```

**Check:** all present. If Node is older, stop and tell the user (installing Node is their call —
nvm is the usual route). If `uv` is missing and they want HPC or ALCF, point them at
https://docs.astral.sh/uv/ and wait.

## 2. Pi

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.2.0
npm view @earendil-works/pi-coding-agent@1.2.0 dist.integrity
# expect: sha512-h/4WaVWv1VlCaY8x8qEN5U+7jbF/e7+Ck6moPeEOFn5juMTWwNAXjwgYM7gRgbBYh8Zppwt6qWvJDzNTf4GNEQ==
```

**Check:** `pi --version` prints `1.2.0`, and the integrity matches.

## 3. The two packages the harness builds on

```bash
npm view pi-cc-extensions@1.0.2 dist.integrity
# expect: sha512-Qwz+B+2Lng0qLgzin8dcdfhk7Ghx+xpm7hN2UW4WXMkvX1A2eqaBita2TQ0OlA5qSFWVkRgljbBs70xnXV9jRQ==
npm view @tintinweb/pi-subagents@0.21.0 dist.integrity
# expect: sha512-4hivkYVRaOvqF3MPA95WrBrXC3Ur6T5boJB5wMAnRL6+d4dnU892tvADefhkq/krLsdoYiBb4EIMBcTop803Ig==
pi install npm:pi-cc-extensions@1.0.2
pi install npm:@tintinweb/pi-subagents@0.21.0
```

**Check:** both lines appear under `packages` in `~/.pi/agent/settings.json`, at those versions.
If an older version of either is listed too, remove the older entry.

## 4. The harness

```bash
pi install git:github.com/GusEllerm/pi-lab-profile
git clone https://github.com/GusEllerm/pi-lab-profile ~/Projects/pi-lab-profile
cd ~/Projects/pi-lab-profile && scripts/install.sh lab      # or: scripts/install.sh example
```

The script copies the agent roles and the profile's configuration into `~/.pi/agent/` —
`models.json`, `mcp.json`, `rounds.json`, `subagents.json`, `header.json`,
`pi-cc-extensions.json` — and, for `lab`, two helpers into `~/.local/bin/` (`globus-tunnel`,
`alcf-token`). It never overwrites: a line starting `!` means a file already existed and differs.
For each such line, show the user the difference (`diff <repo file> <existing file>`) and ask
whether to merge; merge only what they agree to.

**Check:** `ls ~/.pi/agent/agents/` lists `dev.md reviewer.md critic.md`, and no `.ts` files sit
in `~/.pi/agent/extensions/` (a copy there loads twice).

## 5. Settings

Merge these keys into `~/.pi/agent/settings.json` (keep everything else in it):

```json
{
  "tuiMode": "fullscreen",
  "theme": "cc-light",
  "hideThinkingBlock": true
}
```

`tuiMode: "fullscreen"` is required — the status column cannot exist without it. The theme is
pi-cc's (`cc-dark` for a dark terminal). For the `lab` profile *and* a user with lab GPU access,
also set `"defaultProvider": "globus"` and `"defaultModel": "qwen3.8-flash-next"`.

**Check:** `python3 -m json.tool ~/.pi/agent/settings.json` succeeds, and
`~/.pi/agent/pi-cc-extensions.json` exists with `"showStartupHeader": false` (step 4 put it there;
create it from `profiles/<profile>/pi-cc-extensions.json` if it was skipped).

## 6. The launcher (lab profile with lab GPU access only)

Add the `pi()` shell function from [setup-guide.md §6](setup-guide.md#6-the-launcher-function) to
the user's `~/.zshrc` or `~/.bashrc` (read it first; append, do not replace). It opens the SSH
tunnel to the lab GPU before Pi starts, and starts Pi anyway if the tunnel cannot open.
For a demo machine, also add `export PI_SKIP_VERSION_CHECK=1` so Pi's "Update Available" box stays
off the screen.

**Check:** in a new shell, `type pi` reports a shell function.

## 7. Access — the user's part, one endpoint at a time

Only for the endpoints chosen in step 0. For each: tell the user what to do, wait for them to say
it is done, then run the check.

| endpoint | what the user does | check you run |
|---|---|---|
| **Lab GPUs** | Get a cluster account from the lab. Add a `Host globus1` block to `~/.ssh/config` with their cluster username and key (you may draft it; they confirm the hostname and username). The key must load without a prompt (agent or keychain). | `ssh -o BatchMode=yes globus1 true` succeeds; then `pi --no-session -p "Reply with just: ok" </dev/null` prints `ok` |
| **ALCF gateway** | Run `uvx --from "alcf-ai==0.10.0" alcf-ai auth login` in their terminal and finish the login in the browser (once; it lasts about six months idle). | `~/.local/bin/alcf-token --status` reports credentials present |
| **Argo** | Obtain Argo Gateway API authorisation (their division's AIOps representative) and a CELS account with an SSH key and Duo. Then in a terminal: `git clone https://github.com/GusEllerm/argo-tools ~/Projects/argo-tools && cd ~/Projects/argo-tools && ./argo-setup` — it is interactive and asks for a Duo push. | `~/.config/argo-tools/config` exists; `curl -s -m 3 http://127.0.0.1:44497/health` answers `healthy` while their tunnel is up |
| **HPC (hpc-bridge)** | Nothing in advance: the first time they ask the agent to use a facility, hpc-bridge opens a Globus login in their browser. | `pi mcp list` shows `hpc: connected, 12 tools` (the first run downloads hpc-bridge, so allow a minute) |

## 8. Acceptance

```bash
cd ~/Projects/pi-lab-profile && bash scripts/check.sh
```

**Check:** every extension parses, `lockfile: in sync`, and `boot: clean (pi replied)`. A boot
failure prints the error; [setup-guide.md §10](setup-guide.md#10-troubleshooting) covers the
common ones.

Then ask the user to start `pi` and confirm, in order:

1. the **GLOBUS HARNESS** header (lab) or their own, with the model and endpoint under it
2. a status column on the right (the terminal must be at least 72 columns wide)
3. `/endpoints` lists each machine they set up as live (an ALCF model may read `cold`; its first
   request starts it)
4. `/compat` reports the text cache, hover guard and measure stub as active
5. a one-line question gets an answer, and the column's endpoint shows ✓

## Report

Tell the user: what was installed and at which versions, which endpoints work and which were
skipped (and what each skipped one needs), every file you changed and every backup you made. Point
them at the [README](../README.md) for what to try first.

## Undo

[setup-guide.md, "Undo"](setup-guide.md#undo) removes everything this runbook added.
