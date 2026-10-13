#!/bin/bash
# Parse every extension, then (unless --parse-only) boot pi headlessly and fail on any load error.
#
#   scripts/check.sh              this repo's extensions, plus a boot check
#   scripts/check.sh --parse-only parse only — no model needed, this is what CI runs
#   scripts/check.sh <dir>        check some other directory of extensions
#
# Run it after every edit. A render that throws inside Pi's layout pass is an uncaughtException
# that takes the whole session down, and a stale binding reads exactly like a memory leak.
set -uo pipefail
parse_only=0
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="$repo/extensions"
for arg in "$@"; do
	case "$arg" in
		--parse-only) parse_only=1 ;;
		*) dir="$arg" ;;
	esac
done

cd "$dir" || { echo "no such directory: $dir" >&2; exit 1; }
fail=0
# A bundle install (docs/no-node.md) has Pi but no node or npm: the parse and lockfile steps are
# for developing the profile, so they are skipped there and the boot and TUI checks still run.
if ! command -v node >/dev/null; then
	echo "parse: skipped (no node here — a bundle install; Pi's own runtime loads the extensions)"
fi
for f in *.ts lib/*.ts; do
	[ -e "$f" ] || continue
	command -v node >/dev/null || break
	# jiti resolves the pi packages and TS parameter properties at load time; plain node does
	# neither, so those two diagnostics are expected and not failures.
	out=$(node --no-warnings -e "import('./$f').catch(e=>{const m=e.message.split('\n')[0]; if(!/Cannot find package '@earendil-works|MODULE_TYPELESS/.test(m)){console.log('PARSE FAIL: '+m); process.exit(1)}})" 2>&1)
	if [ -n "$out" ]; then echo "$f: $out"; fail=1; else echo "$f: parses"; fi
done

# The lockfile must match package.json, or CI's `npm ci` refuses before running a single test.
# 12 Oct 2026: the peer range moved to >=1.1.0 without regenerating the lock, every local check
# passed (they never run npm ci), and four pushes failed in CI. `npm ci --dry-run` is the same
# validation, offline-cheap. Fix with: npm install --package-lock-only --ignore-scripts
if [ "$dir" = "$repo/extensions" ] && [ -f "$repo/package-lock.json" ] && command -v npm >/dev/null; then
	if lock=$(cd "$repo" && npm ci --omit=dev --dry-run --ignore-scripts --no-audit --no-fund 2>&1 >/dev/null); then
		echo "lockfile: in sync with package.json"
	else
		echo "lockfile: OUT OF SYNC with package.json — CI's npm ci will fail. Run: npm install --package-lock-only --ignore-scripts"
		echo "$lock" | grep -m3 "Invalid" | sed 's/^/  /'
		fail=1
	fi
fi

if [ "$parse_only" = 1 ]; then exit $fail; fi

command -v pi >/dev/null || { echo "boot: skipped (pi not on PATH)"; exit $fail; }
log=$(mktemp)
ALCF_TOKEN_OFFLINE=1 ALCF_TOKEN_TTL=604800 perl -e 'alarm 45; exec @ARGV' pi --no-session --thinking off -p "Reply with just: ok" </dev/null >"$log" 2>&1
status=$?
# Both halves are required. The first version only looked for known failure strings, so a pi that
# died on startup -- or was killed by the alarm above -- printed "boot: clean" and was believed.
# The first line of a failure names its cause ("No API key found for the selected model"); what
# follows can be a long stack trace from whatever tore down after it, so show the head, not the tail.
if [ "$status" -ne 0 ]; then
	echo "BOOT FAIL: pi exited $status$([ "$status" -eq 142 ] && echo ' (killed by the 45s alarm)')"; grep -v '^\s*$' "$log" | head -3 | cut -c1-240; fail=1
elif ! grep -qi '^ok' "$log"; then
	echo "BOOT FAIL: no reply from the model"; grep -v '^\s*$' "$log" | head -3 | cut -c1-240; fail=1
elif grep -qiE "Failed to load extension|is not defined|is not a function|ParseError|stale after session" "$log"; then
	echo "BOOT ERRORS:"; grep -iE "Failed to load|is not defined|is not a function|ParseError|stale after session" "$log" | head -5; fail=1
else
	echo "boot: clean (pi replied)"
fi
rm -f "$log"

# The headless boot above never draws the TUI, so a bug that only fires while rendering passes it
# (13 Oct 2026: the fleet ticker threw on the first frame, every test green). Start the real TUI.
if command -v python3 >/dev/null; then
	python3 "$repo/scripts/tui-smoke.py" || fail=1
else
	echo "tui: skipped (python3 not on PATH)"
fi
exit $fail
