# Build, test and redeploy

Everything runs from the project root (the directory containing this `docs/`
folder) in Git Bash. The toolchain comes from `pnpm-lock.yaml`; `node_modules/`
is a normal pnpm store-linked tree, so rebuilds need no network.

## First checkout on a new machine

`node_modules/` is git-ignored, so a fresh clone has no toolchain and every
`../../node_modules/.bin/*` path below is missing. Install once:

```bash
node --version                        # must satisfy engines: ^22.19 || >=24
pnpm install --frozen-lockfile
```

`--frozen-lockfile` is deliberate: the committed lockfile is what reproduces the
artifact hashes below, and a floating install can pull a newer `tsdown` or
`lightningcss` and change the CSS class prefix or minifier output.

A first install that dies part-way leaves `node_modules/.pnpm/` populated but no
top-level links and no `node_modules/.modules.yaml` — the next command then
fails with `No such file or directory: ../../node_modules/.bin/tsc`. Re-running
`pnpm install` finishes it; that is a pnpm hiccup, not a repo problem.

Builds are verified reproducible: two independent clones of this repo, installed
and built from scratch, produced `lib/index.js`, `lib/client.js` and
`lib/client.js.map` byte-identical to the committed artifacts.

## Build

```bash
cd packages/dsh-usage
../../node_modules/.bin/tsc -b tsconfig.build.json   # optional: lib/types/*.d.ts
../../node_modules/.bin/tsdown                        # lib/index.js + lib/client.js(+.map)
```

`tsdown` reads `tsdown.config.ts` → `shared/tsdown.client.ts`'s
`clientBundle('@linxin666/dsh-usage', ['src/index.ts'], {})`, which emits both
halves:

- `lib/index.js` — the host bundle (plain ESM, `//#region` markers).
- `lib/client.js` — the browser bundle, wrapped in
  `window.__ModuleLoader__.load({ id: "@linxin666/dsh-usage", factory: (require) => {...} })`,
  with the CSS module compiled by lightningcss (class prefix `cvtkAW_`) and
  inlined as a `<style data-plugin-css>` string.

Expected output (upstream 0.4.8 + local changes): `lib/index.js` **108,672 B** =
md5 `1d68e04b3c5781bb9738f389f9577720`, `lib/client.js` **450,874 B** = md5
`5b4af24ec632d3637590dd340eda4e21`, `lib/client.js.map` **554,260 B** = md5
`94628b6db1b419b8d74446cd43ea5242`. The build is deterministic — these hashes
reproduce byte-for-byte here. Benign warnings: `@deepseek-ai/dsh-credentials`
and `@deepseek-ai/dsh-brand` unresolved imports (host peers, resolved at
runtime), deprecated `external`/`noExternal` option names, the `deps.onlyBundle`
hint, and the CJS format recommendation.

The sourcemap embeds `sourcesContent` verbatim, so **it is only reproducible from
LF sources**: a worktree whose `src/` files carry CRLF produces the same
`client.js` but a larger map with a different hash. Check with
`git ls-files --eol | grep w/crlf` and normalise before hashing a build.

Both halves build from `src/`. The host bundle **includes** the session-log
backfill and the device-ledger code now, so there is no post-build patch step:
the artifact you build is the artifact you deploy.

Typecheck (must print nothing):

```bash
cd packages/dsh-usage && ../../node_modules/.bin/tsc --noEmit -p tsconfig.json
```

## Test

```bash
cd "$(git rev-parse --show-toplevel)"
node harness/build-test-bundle.cjs    # derives harness/client.test.cjs from lib/client.js
node harness/render-test.mjs          # must end: === 99/99 checks passed ===
node --experimental-strip-types harness/host-test.mjs   # 168/168 checks passed
```

`render-test.mjs` takes 1–2 minutes (jsdom + the full bundle); give it a
timeout rather than assuming it hung.

Regression rule: **any change to the window logic, its copy, the peak badge, or
the device card must keep all 99 render checks green**, and a new behaviour
needs a new `check(...)` line. `host-test.mjs` is the guard on everything a
render test cannot reach: device id validation, export/import, ledger summing,
legacy migration, transcript backfill (including the cross-file dedupe by
`data.message.id` and the one-time repair of already-inflated buckets), the live
fold (a call with no header event, a mid-session route switch, the record's own
day bucket), the range aggregate, ledger quarantine and write-guard behaviour,
two processes flushing one file, the repair's own repeatability (a second start
must not subtract again, a bucket that only grew keeps its new calls), restoring
a ledger from an `/export` envelope, refusing another device's export, peer
identity checks (a backup copy of this device's own ledger is not a device), the
loopback fence and the peak clock.
It runs the TypeScript sources directly via
Node's type stripping, against a throwaway `DSH_HOME`, so it needs no build.

Visual check without a browser (headless Edge):

```bash
cd "$(git rev-parse --show-toplevel)" && node harness/make-panel-html.cjs    # -> harness/panel.html
URL=$(cygpath -m "$PWD/harness/panel.html")
SHOT=$(cygpath -w "$PWD/preview/check.png")
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --disable-gpu --hide-scrollbars --window-size=820,1500 \
  --screenshot="$SHOT" --virtual-time-budget=4000 "file:///$URL"
```

`panel.html` accepts `?tab=last30|yesterday|custom|plan|bank` to script an
interaction before screenshotting. Ignore the
`external_registry_loader_win.cc … .crx does not exist` stderr noise.

## Deploy to the live profile

The live plugin directory is
`~/.dsh/profiles/desktop/node_modules/@linxin666/dsh-usage`
(`$DSH_HOME/profiles/desktop/...`).
Both halves build from `src/` now, so **all three artifacts are deployable as
built** — the old "copy the client half but never the host half" rule is gone,
because `lib/index.js` no longer needs a post-build patch to carry backfill.

Copy `src/**` too when you want the live package to stay self-documenting
(the source is what the next maintainer diffs against). Keep it identical or the
workspace stops being trustworthy.

```bash
P="${DSH_HOME:-$HOME/.dsh}/profiles/desktop/node_modules/@linxin666/dsh-usage"
W="$(git rev-parse --show-toplevel)/packages/dsh-usage"   # or the absolute project path
# rm first: these live files are pnpm store hardlinks (hazard 2 below)
rm -f "$P/lib/client.js" "$P/lib/client.js.map" "$P/lib/index.js"
cp "$W/lib/client.js" "$W/lib/client.js.map" "$W/lib/index.js" "$P/lib/"
rm -rf "$P/src" && cp -r "$W/src" "$P/src"   # sources, wholesale
diff -rq "$P/src" "$W/src" && echo SRC_SYNC_OK
md5sum "$P/lib/index.js" "$P/lib/client.js"   # must equal the build hashes
```

Easier: `bash patches/install-patches.sh` does all of the above (both halves
plus all of `src/` and every `lib/types/**/*.d.ts`) with the hardlink-safe
`rm`-before-`cp` order, then prints five markers and the number of files still
hardlinked into the store.

`patches/apply-patch.sh`, `patches/index.patched-0.4.7.js` and
`patches/verify-backfill.cjs` are **legacy**: they exist for rolling back to —
or auditing — the hand-patched 0.4.7 host bundle. A fresh build of
`lib/index.js` needs no patching.

### Does the change go live immediately? Yes — no app restart

The web app always mounts `@deepseek-ai/dsh-client-hmr`
(`@deepseek-ai/dsh-web-app/cordis.patch.yml` inside the app's `app.asar`), whose
host half stat-polls every plugin's client bundle every 500 ms
(`bundleStat` = `{mtimeMs, ctimeMs, size}`). When the file changes it:

1. re-snapshots the artifact and derives a new `rev`
   (`sha1` over `framedHash("plugin-artifact", [mtimeMs, ctimeMs, size])`,
   first 12 hex chars);
2. calls `clientModules.rebuilt(id)`;
3. broadcasts SSE `{type:'rebuilt', id, rev}` on `/plugins/events`.

The browser half then tears down the plugin's fiber (`tearDownEntryFiber`,
which unmounts its React roots and removes its styles) and re-imports the new
bundle. So: rebuild → copy into the profile → **a GUI page refresh at most**.
No restart, no session loss. If the panel still shows the old UI, reload the
page once; the SSE connection may have missed the frame while the window was
hidden.

To confirm the host is serving the new bytes without touching the user's
browser (both routes are loopback-exempt, no auth):

```bash
PORT=3271   # the port the host prints on startup; it changes when 3463 is taken
curl -sN "http://127.0.0.1:$PORT/plugins/events" | head -c 400000 > "$TEMP/graph.txt"
grep -o '"id":"@linxin666/dsh-usage"[^}]*' "$TEMP/graph.txt"   # read the rev
curl -s "http://127.0.0.1:$PORT/plugins/??@linxin666/dsh-usage/client.js&rev=<rev>"   | grep -c 'usage.range.customPick'                       # 1 -> new UI is served
```

Read the rev from the plugin's own entry, not from the graph's top-level `rev`.
`/plugins/<pkg>/client.js?rev=...` (the non-combo form) is 404 by design; only
the exact `chunkUrl` or the `plugins/??…` combo resolves. The served bytes
differ from the file on disk only in the rewritten `sourceMappingURL`, so compare
sizes rather than md5s, and write scratch files under `$TEMP`, never `/tmp`.

## Installing the build after any plugin update

```bash
cd "$(git rev-parse --show-toplevel)"
bash patches/install-patches.sh          # both bundles + all of src/ + *.d.ts
```

This is the safe path: it removes each live file before copying, so the write
never travels through a pnpm store hardlink (see hazard 2 below), and it ends by
printing five markers plus the count of files still hardlinked into the store
(only files this workspace never modifies — `package.json`, `LICENSE`, the
READMEs, `cordis.patch.yml`, `icon.svg`).

The script reports the deployed hashes, so you can compare them against the
build table above. It works against any baseline version; the hashes change
whenever the source does, not only when upstream releases.

## An installed package is not a loaded plugin

Deploying files only puts them on disk. The host decides what to load from
`dsh.profile.bundles`, never from `node_modules`:

```js
const bundles = readProfileManifest(binName, dir).dsh?.profile?.bundles ?? [];
for (const packageName of bundles) { /* resolve bundle, read dsh.bundle.patch */ }
```

A package missing from that list contributes no patch layer, so none of its
routes or UI rows exist — silently, with no error anywhere. Verify membership
before debugging anything else:

```bash
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
node -e 'const m=require(process.argv[1]);console.log(m.dsh.profile.bundles.includes("@linxin666/dsh-usage"))' \
  "$PROFILE/package.json"
```

The plugin manager, the market and `dsh plugin add` all do both halves; a bare
`pnpm add` does only the dependency. `dsh plugin add` reconciles the bundle list
only when pnpm exits 0 — it silently skips that step on `ERR_PNPM_IGNORED_BUILDS`
(the constant noise on this profile), leaving the package installed and unloaded.
`README.md` has the two-line repair.

## Rollback

| To undo | Do |
| --- | --- |
| Everything, back to stock 0.4.7 | Reinstall the package in the profile (any `pnpm install` there does it), or restore the two stored bundles below. |
| Only the host half | `cp patches/index.orig-0.4.7.js` → `lib/index.js` (drops backfill and the device split). |
| Only the panel | `cp patches/backup-client-pre-range-ui/client.js.orig-0.4.7` → `lib/client.js` (plus the matching `.map`). |

Same HMR rules apply: a GUI refresh picks the rollback up. The host half only
reverts with a full app restart — its ESM module graph is cached.

## Two hazards that silently revert everything

### 1. `pnpm install` in the profile wipes the patches

The live package is a plain registry dependency
(`$DSH_HOME/profiles/desktop/package.json` line 8 pins the registry version), so
**any** install in that profile — installing, updating, or uninstalling *any
other plugin* — reinstalls this package from npm and restores all four stock
files. Observed 2026-10-20 04:17:33: uninstalling `dsh-infinite-gen-5` triggered
`.plugin-manager/logs/operation-V0N1KU/pnpm.log` ("reused 288, added 289"),
which reset `lib/client.js` to 417,595 B / `16ffb1fa…` and `lib/index.js` to
83,496 B / `fc126892…` — the whole redesign and backfill were gone.

Detect it:

```bash
L="${DSH_HOME:-$HOME/.dsh}/profiles/desktop/node_modules/@linxin666/dsh-usage"
md5sum "$L/lib/client.js" "$L/lib/index.js"
# patched: 5b4af24ec632d3637590dd340eda4e21 / 1d68e04b3c5781bb9738f389f9577720
grep -c 'usage.range.customPick' "$L/lib/client.js"   # must be 3, stock is 0
grep -c 'device-card' "$L/lib/client.js"              # must be >= 1, stock is 0
grep -c 'backfillSessionLogs\|collectSessionLogUsage' "$L/lib/index.js"   # must be > 0, stock is 0
```

Fix: re-run `bash patches/install-patches.sh`, then refresh the GUI. The host
half needs a full app restart (its ESM module graph is cached); the client half
hot-reloads. An unpatched stock `lib/index.js` is 83,496 B / md5
`fc12689238e1f4088e7fb852bd35f8da` — seeing that hash means the package was
reinstalled from the registry.

A faster fix that stops the recurrence: switch the profile dependency from the
registry pin to a git dependency, so pnpm pins a commit instead of a version and
unrelated plugin installs no longer re-resolve it (see "Install on another
machine" in the [README](../README.md)).

### 2. `cp` into the profile corrupts the pnpm store

The profile uses `nodeLinker: hoisted`, so every installed file is a
**hardlink** into the global store
(`%LOCALAPPDATA%\pnpm\store\v11\files` on Windows). `cp new.js $P/lib/client.js`
opens the existing inode and writes through it, rewriting the shared store
entry — a content-addressed file whose name no longer matches its hash. The
corruption is invisible to the plugin and only surfaces later as odd
"file changed on disk" behaviour for unrelated installs.

Rules:

- **Always `rm -f` the live file before copying** (what
  `install-patches.sh` does). The copy then lands on a fresh inode and the
  store keeps its pristine bytes.
- Never edit a live plugin file in place with an editor that saves by writing
  the original inode either.

To audit the store after a manual copy, remember the layout: a store file's
name is the **tail** of its sha512, and the **parent directory** holds the
first two hex chars (`files/f8/efb5789…` ⇒ sha512 starts `f8efb5789…`):

```bash
S="${LOCALAPPDATA:-$HOME/AppData/Local}/pnpm/store/v11"
L="${DSH_HOME:-$HOME/.dsh}/profiles/desktop/node_modules/@linxin666/dsh-usage"
find "$L" -type f -links +1 | while read f; do
  I=$(stat -c '%i' "$f"); SF=$(find "$S" -xdev -inum "$I" 2>/dev/null | head -1)
  [ -z "$SF" ] && continue
  D=$(basename "$(dirname "$SF")"); B=$(basename "$SF")
  [ "$D$B" != "$(sha512sum "$SF" | cut -d' ' -f1)" ] && echo "POLLUTED ${f#$L/}"
done
```

To repair a polluted entry: copy the pristine file back over the store path
(the filename tells you which release file it was), then `rm -f` the live copy
and write the patched content fresh.
`npm pack @linxin666/dsh-usage@<the-version-in-your-lockfile>` gives you a
known-good source tree for any file under `lib/` or `src/`.

## Gotchas collected while doing this

- **Never hardcode `/tmp/...` in a Node script.** Git Bash's `/tmp` is
  `$TEMP` (e.g. `C:\Users\<you>\AppData\Local\Temp`), but Node resolves the literal string
  `/tmp/x` as `C:\tmp\x` → `ENOENT`. Use `process.cwd()`, `__dirname`, or
  `import.meta.url`.
- `node -e 'require(process.cwd() + "/package.json")'` breaks in Git Bash: MSYS
  rewrites the `/package.json` fragment inside the payload to
  `C:/Program Files/Git/package.json`. Read JSON files with a separate script
  file or the editor, not inside `-e`.
- `npm install` fails here (`Cannot read properties of null (reading
  'edgesOut')`, npm 10.9.7 arborist bug). Use **pnpm**.
- `rsync -a --delete` and `rm -rf <dir outside cwd>` are blocked by the CC
  Safety Net. Use `cp -r "$SRC/." "$DST/"` and unique scratch dir names instead
  of deleting.
