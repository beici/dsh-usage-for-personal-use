#!/usr/bin/env bash
# Re-apply the dsh-usage session-log backfill patch (host half only) after a
# plugin update.
#
# Usage: bash apply-patch.sh [dsh-usage-package-dir]
#
# The default target is the current user's desktop profile. Override it as the
# first argument when working against another profile or a copied package.
#
# Note: prefer install-patches.sh, which restores BOTH halves (client UI +
# host backfill) and also severs the pnpm store hardlink before writing. This
# script exists for the narrow case where only the host bundle needs redoing.
set -euo pipefail

dsh_home="${DSH_HOME:-$HOME/.dsh}"
if command -v cygpath >/dev/null 2>&1; then
  dsh_home="$(cygpath -u "$dsh_home")"
fi
default_pkg="$dsh_home/profiles/desktop/node_modules/@linxin666/dsh-usage"
pkg="${1:-$default_pkg}"
src="$pkg/lib/index.js"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cur="$here/index.patched-0.4.7.js"

if [ ! -f "$src" ]; then echo "not found: $src" >&2; exit 2; fi
if [ ! -f "$cur" ]; then echo "missing patched bundle: $cur" >&2; exit 2; fi
if grep -q "session-log-backfill" "$src"; then
  echo "already patched: $src"; exit 0
fi

ver="unknown"
if [ -f "$pkg/package.json" ]; then
  ver=$(node -e "console.log(require(process.argv[1]).version)" "$pkg/package.json")
  if [ "$ver" != "0.4.7" ]; then
    echo "WARNING: version $ver != 0.4.7; the stored patched bundle may not match this release." >&2
  fi
fi

cp "$src" "$(dirname "$src")/index.js.orig"
# Remove before copying: the live file is a hardlink into the pnpm store, so a
# plain `cp` over it would rewrite the shared store entry (see the hazard notes
# in docs/build-and-redeploy.md).
rm -f "$src"
cp "$cur" "$src"
node --check "$src" && echo "patched: $src (from $ver, backup lib/index.js.orig)"
