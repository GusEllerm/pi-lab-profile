#!/usr/bin/env bash
# Install the parts of this profile that Pi's package manifest cannot carry:
# agent roles, and (optionally) a profile's models.json / rounds.json / bin helpers.
#
#   scripts/install.sh              roles only — safe anywhere
#   scripts/install.sh lab          roles + the globus/ALCF profile (lab machines)
#   scripts/install.sh example      roles + a template rounds.json to edit
#
# Nothing is overwritten. An existing file is left alone and reported, so re-running is safe.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
profile="${1:-}"

copy() { # copy <src> <dest>
	if [ -e "$2" ]; then
		if cmp -s "$1" "$2"; then echo "  = $2 (already current)"; else echo "  ! $2 exists and differs — left alone"; fi
	else
		mkdir -p "$(dirname "$2")"; cp "$1" "$2"; echo "  + $2"
	fi
}

echo "Agent roles → $agent_dir/agents"
for f in "$here"/agents/*.md; do copy "$f" "$agent_dir/agents/$(basename "$f")"; done

case "$profile" in
	lab)
		echo "Lab profile (globus tunnel + ALCF gateway)"
		copy "$here/profiles/lab/rounds.json" "$agent_dir/rounds.json"
		copy "$here/profiles/lab/subagents.json" "$agent_dir/subagents.json"
		copy "$here/profiles/lab/models.json" "$agent_dir/models.json"
		mkdir -p "$HOME/.local/bin"
		for f in "$here"/profiles/lab/bin/*; do copy "$f" "$HOME/.local/bin/$(basename "$f")"; chmod +x "$HOME/.local/bin/$(basename "$f")" 2>/dev/null || true; done
		echo "  → needs: an 'ssh globus1' host alias, and 'uvx alcf-ai auth login' once"
		;;
	example)
		echo "Example profile"
		copy "$here/profiles/example/rounds.json" "$agent_dir/rounds.json"
		echo "  → edit $agent_dir/rounds.json to name models you actually have"
		;;
	"") echo "No profile requested; roles only. Pass 'lab' or 'example' for endpoint config." ;;
	*) echo "Unknown profile: $profile (expected 'lab' or 'example')" >&2; exit 2 ;;
esac

echo
echo "Extensions come from the package itself:  pi install git:github.com/GusEllerm/pi-lab-profile"
echo "If you previously copied these .ts files into $agent_dir/extensions, delete them — otherwise"
echo "they load twice and you get two status bars."
