#!/usr/bin/env bash
# Audit the pnpm global store for entries this workspace's cp-over-hardlink
# mistake would have corrupted. See docs/build-and-redeploy.md hazard 2.
#
# Store entries are content addressed: files/<sha512[0:2]>/<sha512[2:]>, so the
# expected checksum is the parent directory name followed by the file name.
# Paths must be normalized with cygpath first: a backslash in a filename makes
# sha512sum prefix its output with a backslash, and every comparison fails.
set -uo pipefail

store="${LOCALAPPDATA:-$HOME/AppData/Local}/pnpm/store/v11"
pkg="${DSH_HOME:-$HOME/.dsh}/profiles/desktop/node_modules/@linxin666/dsh-usage"
if command -v cygpath >/dev/null 2>&1; then
  store="$(cygpath -u "$store")"
  pkg="$(cygpath -u "$pkg")"
fi

[ -d "$store" ] || { echo "no store at $store" >&2; exit 2; }
[ -d "$pkg" ] || { echo "no package at $pkg" >&2; exit 2; }

bad=0
while read -r f; do
  inode=$(stat -c '%i' "$f")
  sf=$(find "$store" -xdev -inum "$inode" 2>/dev/null | head -1)
  [ -z "$sf" ] && continue
  expected="$(basename "$(dirname "$sf")")$(basename "$sf")"
  actual=$(sha512sum "$sf" | cut -d' ' -f1)
  if [ "$expected" != "$actual" ]; then
    echo "POLLUTED ${f#"$pkg"/}"
    bad=$((bad + 1))
  fi
done < <(find "$pkg" -type f -links +1)

echo "polluted count: $bad"
[ "$bad" -eq 0 ]
