#!/usr/bin/env bash
# Build a self-contained Globus Harness bundle for a machine that has no Node.js or npm.
#
#   scripts/make-bundle.sh                     # harness + packages; the target already has a Pi
#   scripts/make-bundle.sh --pi linux-x64      # ...plus Pi's standalone binary for that platform
#   scripts/make-bundle.sh --ref v1.0 --out /tmp
#
# Platforms: linux-x64 linux-arm64 darwin-arm64 darwin-x64. Run it anywhere with npm, git and curl;
# copy the .tar.gz to the target, unpack it and run its install.sh (docs/no-node.md).
#
# Why a bundle: Pi's standalone binaries run without Node, but `pi install` still calls npm — for
# npm packages and to install a git package's dependencies. A *local directory* is the one source
# Pi installs without npm, so the bundle carries every package as a directory with its
# dependencies already in place. The packages Pi provides to extensions itself (@earendil-works/*,
# typebox) are left out on purpose: a bundled copy would shadow Pi's own and Pi warns about it.
set -euo pipefail

# The pins. tests/versions.test.mjs keeps these in step with docs/agent-setup.md and the README.
PI_VERSION=1.2.0
PICC_VERSION=1.0.2
SUBAGENTS_VERSION=0.21.0

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
platform="" ref="HEAD" out="$here/dist"
while [ $# -gt 0 ]; do
	case "$1" in
		--pi) platform="${2:?--pi needs a platform}"; shift 2 ;;
		--ref) ref="${2:?--ref needs a git ref}"; shift 2 ;;
		--out) out="${2:?--out needs a directory}"; shift 2 ;;
		-h|--help) sed -n '2,15p' "$0"; exit 0 ;;
		*) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
	esac
done
case "$platform" in ""|linux-x64|linux-arm64|darwin-arm64|darwin-x64) ;; *) echo "unknown platform: $platform" >&2; exit 2 ;; esac
for tool in npm git tar; do command -v "$tool" >/dev/null || { echo "make-bundle needs $tool" >&2; exit 1; }; done
[ -z "$platform" ] || command -v curl >/dev/null || { echo "make-bundle needs curl for --pi" >&2; exit 1; }

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

sha=$(git -C "$here" rev-parse --short "$ref")
if [ "$ref" = HEAD ] && [ -n "$(git -C "$here" status --porcelain -- extensions profiles scripts agents package.json)" ]; then
	echo "note: uncommitted changes are NOT in the bundle; it is built from commit $sha" >&2
fi
name="globus-harness-$sha${platform:+-$platform}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
root="$work/$name"
mkdir -p "$root/packages" "$out"

echo "harness: commit $sha"
git -C "$here" archive --format=tar --prefix=pi-lab-profile/ "$ref" | tar -x -C "$root/packages"

vendor() { # vendor <npm spec> <directory name>
	local spec=$1 dir=$2 stage="$work/stage-$2"
	mkdir -p "$stage"
	(cd "$stage" && npm pack --silent "$spec" >/dev/null && tar -xzf ./*.tgz)
	mv "$stage/package" "$root/packages/$dir"
	# --legacy-peer-deps installs no peers (Pi supplies those); --omit=peer trips an npm bug here
	(cd "$root/packages/$dir" && npm install --omit=dev --legacy-peer-deps --ignore-scripts --no-audit --no-fund --no-package-lock --loglevel=error >/dev/null)
	[ -d "$root/packages/$dir/node_modules" ] && find "$root/packages/$dir/node_modules" -type d -empty -delete
	for host in @earendil-works typebox @sinclair/typebox; do
		if [ -e "$root/packages/$dir/node_modules/$host" ]; then echo "make-bundle: $dir carries a copy of $host, which Pi provides itself" >&2; exit 1; fi
	done
	echo "$dir: $spec, $(ls "$root/packages/$dir/node_modules" 2>/dev/null | wc -l | tr -d ' ') dependencies, integrity $(npm view "$spec" dist.integrity)"
}
vendor "pi-cc-extensions@$PICC_VERSION" pi-cc-extensions
vendor "@tintinweb/pi-subagents@$SUBAGENTS_VERSION" pi-subagents

pi_sha=""
if [ -n "$platform" ]; then
	asset="pi-$platform.tar.gz"
	base="https://github.com/earendil-works/pi/releases/download/v$PI_VERSION"
	curl -fsSL -o "$work/$asset" "$base/$asset"
	curl -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS"
	expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$work/SHA256SUMS")
	pi_sha=$(sha256 "$work/$asset")
	[ -n "$expected" ] && [ "$pi_sha" = "$expected" ] || { echo "make-bundle: $asset does not match the release's SHA256SUMS" >&2; exit 1; }
	mkdir -p "$root/pi"
	tar -xzf "$work/$asset" -C "$root/pi" --strip-components=1
	echo "pi: $PI_VERSION for $platform, sha256 $pi_sha (matches the release)"
fi

cp "$here/scripts/bundle-install.sh" "$root/install.sh"
chmod +x "$root/install.sh"
cat > "$root/MANIFEST" <<EOF
HARNESS_COMMIT=$sha
PI_VERSION=$PI_VERSION
PI_PLATFORM=${platform:-none}
PI_SHA256=${pi_sha:-none}
PICC_VERSION=$PICC_VERSION
SUBAGENTS_VERSION=$SUBAGENTS_VERSION
BUILT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

file="$out/$name.tar.gz"
# macOS's bsdtar records extended attributes (com.apple.provenance on everything npm fetched) as
# pax headers that GNU tar warns about once per file on the target. Leave them out.
no_meta=()
tar --version 2>/dev/null | grep -q bsdtar && no_meta=(--no-xattrs --no-mac-metadata)
COPYFILE_DISABLE=1 tar ${no_meta[@]+"${no_meta[@]}"} -czf "$file" -C "$work" "$name"
echo
echo "built $file ($(du -h "$file" | cut -f1)), sha256 $(sha256 "$file")"
echo "on the target:  tar -xzf $name.tar.gz && $name/install.sh lab    # or: example"
