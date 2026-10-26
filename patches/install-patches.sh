#!/usr/bin/env bash
# Install the locally built @linxin666/dsh-usage over the registry copy in a
# live DSH profile.
#
# Why this script exists
# ----------------------
# The live plugin lives in a pnpm profile with `nodeLinker: hoisted`, so its
# files are HARDLINKS into the global content-addressed store
# (Windows: %LOCALAPPDATA%\pnpm\store\v11\files).
#
# Consequences:
#   1. `cp <new> <live>` writes THROUGH the hardlink and corrupts the shared
#      store entry. Always `rm -f` the live file first so the write lands on a
#      fresh inode and the store keeps its pristine bytes.
#   2. Any `pnpm install` in that profile reinstalls the package from the
#      registry and silently reverts every file below. Re-run this script
#      after every plugin install/update (or pin the profile to the git
#      dependency, see README.md).
#
# Usage:
#   bash patches/install-patches.sh [dsh-usage-package-dir]
#
# Default target is the current user's desktop profile package dir.

set -euo pipefail

# DSH_HOME is a Windows path (C:\Users\...). Normalize it to the shell's own
# dialect: a backslash in a filename makes md5sum escape its whole output line,
# and it breaks any path that is later handed to a POSIX tool.
dsh_home="${DSH_HOME:-$HOME/.dsh}"
if command -v cygpath >/dev/null 2>&1; then
  dsh_home="$(cygpath -u "$dsh_home")"
fi
default_pkg="$dsh_home/profiles/desktop/node_modules/@linxin666/dsh-usage"
pkg="${1:-$default_pkg}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
built="$repo/packages/dsh-usage"

if [ ! -d "$pkg" ]; then echo "not found: $pkg" >&2; exit 2; fi
if [ ! -f "$built/lib/client.js" ]; then
  echo "missing built bundle: $built/lib/client.js (run the build first)" >&2
  exit 2
fi

ver="unknown"
if [ -f "$pkg/package.json" ]; then
  ver=$(node -e "console.log(require(process.argv[1]).version)" "$pkg/package.json")
  want=$(node -e "console.log(require(process.argv[1]).version)" "$built/package.json")
  if [ "$ver" != "$want" ]; then
    echo "NOTE: live version $ver, this build is $want; the files are replaced anyway." >&2
  fi
fi

# replace_file <source> <live-relative-path>
# Removes the live file first so we never write through a store hardlink.
replace_file() {
  local src="$1" rel="$2" dst="$pkg/$2"
  mkdir -p "$(dirname "$dst")"
  rm -f "$dst"
  cp "$src" "$dst"
  printf '  %-45s %s\n' "$rel" "$(md5sum "$dst" | cut -d' ' -f1)"
}

echo "installing built plugin into $pkg (live version $ver)"
echo

echo "[1/4] host bundle"
replace_file "$built/lib/index.js" "lib/index.js"
node --check "$pkg/lib/index.js"

echo "[2/4] client bundle"
replace_file "$built/lib/client.js"     "lib/client.js"
replace_file "$built/lib/client.js.map" "lib/client.js.map"

echo "[3/4] sources (every file under src/, so the copy stays greppable)"
while IFS= read -r rel; do
  replace_file "$built/$rel" "$rel"
done < <(cd "$built/src" && find . -type f | sed 's|^\./|src/|')

echo "[4/4] type declarations"
while IFS= read -r rel; do
  replace_file "$built/$rel" "$rel"
done < <(cd "$built/lib/types" && find . -name '*.d.ts' -type f | sed 's|^\./|lib/types/|')

echo
echo "verifying markers:"
printf '  client customPick : %s\n' "$(grep -c 'usage.range.customPick' "$pkg/lib/client.js" || true)"
printf '  client device card: %s\n' "$(grep -c 'device-card' "$pkg/lib/client.js" || true)"
printf '  host   replay     : %s\n' "$(grep -c 'replaySessionLogs' "$pkg/lib/index.js" || true)"
printf '  host   repair     : %s\n' "$(grep -c 'repairDuplicatedReplay' "$pkg/lib/index.js" || true)"
printf '  host   device split: %s\n' "$(grep -c 'usage-ledger\.' "$pkg/lib/index.js" || true)"
printf '  hardlinked files  : %s\n' "$(find "$pkg" -type f -links +1 2>/dev/null | wc -l)"
echo
echo "done. Refresh the GUI to pick up the new client bundle (HMR)."
