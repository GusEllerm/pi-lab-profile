# Installing without Node.js

For a machine where Node.js is not available and cannot be installed — an HPC login node, a locked-
down workstation, a container image you do not control. You build a bundle on any machine that
*does* have npm, copy one file across, and install it with no network access to npm needed.

## Why it takes a bundle

Pi itself needs no Node: every [Pi release](https://github.com/earendil-works/pi/releases) ships
standalone binaries (`pi-linux-x64`, `pi-linux-arm64`, `pi-darwin-arm64`, `pi-darwin-x64`) with
their own runtime. But `pi install` still calls npm — for npm packages, and to install a git
package's dependencies. The one source Pi installs without npm is a **local directory**. So the
bundle carries everything as directories with their dependencies already in place:

| in the bundle | |
|---|---|
| `packages/pi-lab-profile/` | the harness, at a pinned commit |
| `packages/pi-cc-extensions/` | pi-cc-extensions 1.0.2, its dependencies vendored |
| `packages/pi-subagents/` | pi-subagents 0.21.0, its dependencies vendored |
| `pi/` (with `--pi`) | Pi 1.2.0's standalone binary for one platform, checked against the release's SHA256SUMS |
| `install.sh`, `MANIFEST` | the installer, and what was bundled at which versions |

The packages Pi provides to extensions itself (`@earendil-works/*`, `typebox`) are deliberately left
out — a bundled copy would shadow Pi's own — and the build fails if one slips in.

## 1. Build the bundle (on a machine with npm)

```bash
git clone https://github.com/GusEllerm/pi-lab-profile && cd pi-lab-profile
scripts/make-bundle.sh --pi linux-x64          # the target's platform; omit --pi if it already has Pi
```

It prints the path of the bundle (`dist/globus-harness-<commit>-linux-x64.tar.gz`, about 40 MB with
Pi, 5 MB without) and its sha256. `--ref <tag-or-commit>` builds a specific version of the harness.

## 2. Install it (on the target)

Copy the file across, then:

```bash
tar -xzf globus-harness-<commit>-linux-x64.tar.gz
globus-harness-<commit>-linux-x64/install.sh lab        # Globus Labs members; anyone else: example
```

The installer copies the bundle to `~/.local/share/globus-harness` (set `GLOBUS_HARNESS_HOME` to
put it elsewhere) — the unpacked directory can be deleted afterwards — links the bundled Pi to
`~/.local/bin/pi`, installs the three packages as local directories, runs the profile's own
installer, and adds `"tuiMode": "fullscreen"` to `settings.json` if it is missing. It never
overwrites a file you already have.

## 3. Finish

The same as any install, from [agent-setup.md](agent-setup.md) step 5 on: the settings, and either
[your own model](providers.md) or the [lab's endpoints](endpoints.md#getting-access). Then:

```bash
pi --no-session -p "Reply with just: ok" </dev/null
python3 ~/.local/share/globus-harness/packages/pi-lab-profile/scripts/tui-smoke.py
```

## What the target still needs

- **Nothing for the core**: Pi, the column, the fleet, rounds, `/stuck` run on Pi's bundled runtime.
- **`python3`** for `/argo up` (it relays the Duo prompt through a pseudo-terminal), for Argo's
  price table, and for `tui-smoke.py`.
- **`uv`** for hpc-bridge, which Pi starts with `uvx`.
- **`ssh`** for the lab GPU tunnel; **`curl`** for `globus-tunnel`'s health check.

## Updating

Build a new bundle and run its `install.sh` again: each package directory is replaced whole, and
since the paths do not change, `settings.json` needs nothing. `pi update` does not apply here —
it would reach for npm — so a new Pi version also arrives by bundle.

Tested on 13 Oct 2026 in a Debian container with no Node, npm or bun: the bundle installed, a
headless turn answered, the TUI came up with the column, `/compat` reported all three workarounds
active (which needs pi-cc loaded) and pi-subagents' `/agents` was present.
