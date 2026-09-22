#!/usr/bin/env bash
# Are the vault notes still describing the code that exists?
#
# Every note that documents a source file carries its path and the git blob hash of the content it
# was written against. This recomputes those hashes and reports the notes whose source has changed
# since. It cannot tell whether a note is *wrong*, only that the code moved under it -- which is the
# cheap half of the problem and the half that rots silently.
#
#   bash scripts/check-docs.sh          report, exit 1 if any note is stale
#   bash scripts/check-docs.sh --fix    rewrite the recorded hashes to match the current code
set -uo pipefail
cd "$(dirname "$0")/.."
if [ ! -d pi-lab-profile-vault ]; then
	# an npm-packed install ships scripts/ without the vault; that is not a stale vault, it is no vault
	echo "no vault here (pi-lab-profile-vault/ is absent), nothing to check"
	exit 0
fi

fix=0
[ "${1:-}" = "--fix" ] && fix=1
stale=0
checked=0

while IFS= read -r note; do
	# frontmatter only: the first --- ... --- block, so a "source:" in the body is not mistaken for it
	source_path=$(awk 'NR==1&&$0!="---"{exit} NR>1&&$0=="---"{exit} NR>1&&sub(/^source: */,""){print; exit}' "$note")
	recorded=$(awk 'NR==1&&$0!="---"{exit} NR>1&&$0=="---"{exit} NR>1&&sub(/^source-hash: */,""){print; exit}' "$note")
	[ -n "$source_path" ] || continue
	checked=$((checked + 1))
	if [ ! -f "$source_path" ]; then
		echo "GONE    ${note#./} -> $source_path no longer exists"
		stale=$((stale + 1))
		continue
	fi
	current=$(git hash-object "$source_path")
	if [ "$current" = "$recorded" ]; then
		echo "ok      ${note#./}"
	elif [ "$fix" = "1" ]; then
		# BSD and GNU sed disagree about -i, so write through a temp file. A note that has a source
		# but no hash yet gets the line inserted after its source: line -- rewriting a line that is
		# not there used to print "updated" and change nothing.
		if [ -n "$recorded" ]; then
			sed "s/^source-hash: .*/source-hash: $current/" "$note" > "$note.tmp" && mv "$note.tmp" "$note"
		else
			awk -v h="$current" 'BEGIN{done=0} {print} !done && /^source: /{print "source-hash: " h; done=1}' "$note" > "$note.tmp" && mv "$note.tmp" "$note"
		fi
		echo "updated ${note#./} -> $current"
	else
		echo "STALE   ${note#./}"
		echo "        $source_path changed since this note was written"
		echo "        documented $recorded, now $current"
		echo "        git diff $recorded $current -- $source_path"
		stale=$((stale + 1))
	fi
done < <(find pi-lab-profile-vault -name "*.md" | sort)

echo
echo "$checked notes checked, $stale stale"
# --fix repairs hashes; it cannot repair a note whose source is gone, so that still fails
[ "$stale" -eq 0 ]
