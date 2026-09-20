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
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../extensions" && pwd)"
for arg in "$@"; do
	case "$arg" in
		--parse-only) parse_only=1 ;;
		*) dir="$arg" ;;
	esac
done

cd "$dir" || { echo "no such directory: $dir" >&2; exit 1; }
fail=0
for f in *.ts; do
	# jiti resolves the pi packages and TS parameter properties at load time; plain node does
	# neither, so those two diagnostics are expected and not failures.
	out=$(node --no-warnings -e "import('./$f').catch(e=>{const m=e.message.split('\n')[0]; if(!/Cannot find package|parameter property is not supported|MODULE_TYPELESS/.test(m)){console.log('PARSE FAIL: '+m); process.exit(1)}})" 2>&1)
	if [ -n "$out" ]; then echo "$f: $out"; fail=1; else echo "$f: parses"; fi
done

if [ "$parse_only" = 1 ]; then exit $fail; fi

command -v pi >/dev/null || { echo "boot: skipped (pi not on PATH)"; exit $fail; }
log=$(mktemp)
ALCF_TOKEN_OFFLINE=1 ALCF_TOKEN_TTL=604800 perl -e 'alarm 45; exec @ARGV' pi --no-session --thinking off -p "Reply with just: ok" </dev/null >"$log" 2>&1
if grep -qiE "Failed to load extension|is not defined|is not a function|ParseError|stale after session" "$log"; then
	echo "BOOT ERRORS:"; grep -iE "Failed to load|is not defined|is not a function|ParseError|stale after session" "$log" | head -5; fail=1
else
	echo "boot: clean"
fi
rm -f "$log"
exit $fail
