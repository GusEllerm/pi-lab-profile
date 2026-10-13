#!/usr/bin/env bash
# Install a Globus Harness bundle (made by scripts/make-bundle.sh) on a machine without Node or npm.
#
#   ./install.sh lab        Globus Labs members
#   ./install.sh example    everyone else
#
# Copies the bundle to $GLOBUS_HARNESS_HOME (default ~/.local/share/globus-harness), puts the
# bundled Pi on PATH if the bundle has one, installs every package as a local directory — the one
# kind of source Pi installs without npm — and runs the profile's own installer. Nothing you
# already have is overwritten, and running it again with a newer bundle updates in place.
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
profile="${1:-}"
case "$profile" in lab|example) ;; *) echo "usage: $0 lab|example" >&2; exit 2 ;; esac
# shellcheck disable=SC1091
. "$src/MANIFEST"
dest="${GLOBUS_HARNESS_HOME:-$HOME/.local/share/globus-harness}"
mkdir -p "$dest"

# Settings refer to the packages by path, so they live somewhere permanent, not where the bundle
# was unpacked; an update swaps each directory whole.
replace() {
	rm -rf "$dest/$1.new"
	cp -R "$src/$1" "$dest/$1.new"
	rm -rf "$dest/$1"
	mv "$dest/$1.new" "$dest/$1"
}
echo "Globus Harness $HARNESS_COMMIT → $dest"
replace packages

if [ -d "$src/pi" ]; then
	replace pi
	mkdir -p "$HOME/.local/bin"
	ln -sf "$dest/pi/pi" "$HOME/.local/bin/pi"
	echo "  + Pi $PI_VERSION ($PI_PLATFORM) → ~/.local/bin/pi"
	case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "  ! ~/.local/bin is not on your PATH — add it in your shell rc" ;; esac
	PI="$HOME/.local/bin/pi"
elif command -v pi >/dev/null; then
	PI="$(command -v pi)"
else
	echo "No Pi found, and this bundle carries none. Build one with: scripts/make-bundle.sh --pi <platform>" >&2
	exit 1
fi
have=$("$PI" --version 2>/dev/null || echo unknown)
[ "$have" = "$PI_VERSION" ] || echo "  ! Pi here is $have; this bundle was verified with $PI_VERSION"

for p in pi-cc-extensions pi-subagents pi-lab-profile; do
	"$PI" install "$dest/packages/$p" </dev/null >/dev/null
	echo "  + $p (local package, no npm)"
done

echo
GLOBUS_HARNESS_BUNDLE=1 "$dest/packages/pi-lab-profile/scripts/install.sh" "$profile"

# The column cannot exist without fullscreen mode; add the key only if it is missing. Pi and the
# profile's installer both honour PI_CODING_AGENT_DIR, so this must too.
settings="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/settings.json"
if command -v python3 >/dev/null; then
	python3 - "$settings" <<'EOF'
import json, os, sys
p = sys.argv[1]
s = json.load(open(p)) if os.path.exists(p) else {}
if "tuiMode" not in s:
    s["tuiMode"] = "fullscreen"
    json.dump(s, open(p, "w"), indent=2)
    print("  + settings.json: tuiMode fullscreen")
EOF
else
	echo "  ! add \"tuiMode\": \"fullscreen\" to $settings (python3 is not here to do it)"
fi

docs="$dest/packages/pi-lab-profile/docs"
echo
echo "Next:"
if [ "$profile" = example ]; then
	echo "  - point Pi at your model:            $docs/providers.md"
else
	echo "  - get access to the lab's endpoints: $docs/endpoints.md"
fi
echo "  - check it:  pi --no-session -p \"Reply with just: ok\" </dev/null"
echo "               python3 $dest/packages/pi-lab-profile/scripts/tui-smoke.py"
echo "  - the rest of the setup (shell launcher, theme): $docs/agent-setup.md"
