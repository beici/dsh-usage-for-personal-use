# @linxin666/dsh-usage — live-profile workspace

Working copy of the `dsh-usage` plugin as it is **actually installed** in the
DSH desktop profile
(`$DSH_HOME/profiles/desktop/node_modules/@linxin666/dsh-usage`),
plus the sources, harnesses and notes behind the local modifications:

1. **Usage panel redesign** (browser half, `lib/client.js`) — the
   "设置 · 使用统计" section now offers 今日 / 昨日 / 近 7 天 / 近 30 天 / 自定义
   windows, each showing that window's totals, a per-day bar chart and the
   per-channel + per-model breakdown.
2. **Session-log backfill** (host half, `lib/index.js`) — counts usage that
   happened before the plugin mounted, read from the session logs. Now part of
   `src/`, so a plain build produces it; the old hand-applied patch is kept in
   [`patches/`](patches/) for rollback only.
3. **Multi-device ledgers** (both halves) — each machine keeps its own
   `usage-ledger.<device>.json`; the overview sums every device file, and any
   device can export its own ledger and import a peer's. Importing replaces
   that peer's file, never merges into it, so importing the same file twice
   cannot double-count. See [`docs/multi-device.md`](docs/multi-device.md).

Baseline is the published npm release **0.4.7**; this workspace is not a fork
of the upstream repo, it only carries the changes above.

## Layout

| Path | What it is |
| --- | --- |
| `packages/dsh-usage/` | The plugin package: `src/` (authoritative TS source), `lib/` (build output), `package.json`, `tsconfig*.json`, `tsdown.config.ts`, packaging assets (`cordis.patch.yml`, `icon.svg`, READMEs, `LICENSE`). |
| `shared/tsdown.client.ts` | The client-bundle preset (`clientBundle()` / `clientConfig()` from the upstream monorepo) — required by `packages/dsh-usage/tsdown.config.ts`. |
| `shared/web-platform.ts` | `PLATFORM_MODULES`: the externals the browser bundle may require from the shell. |
| `harness/render-test.mjs` | jsdom render test: mounts the built bundle with saved live fixtures and asserts 29 facts about the five windows and the device-sync card. |
| `harness/host-test.mjs` | Host-side tests, run straight off `src/` with Node type stripping: device ids, export/import, ledger summing, legacy migration, transcript backfill. |
| `harness/build-test-bundle.cjs` | Derives `harness/client.test.cjs` from the built `lib/client.js` by adding one export line the test needs. |
| `harness/make-panel-html.cjs` | Builds `harness/panel.html`, a self-contained page for headless screenshots. |
| `fixtures/` | Live `/api/dsh-usage` responses captured 2026-10-20 (overview + 4 recorded days). |
| `patches/` | The legacy backfill patch, its appliers, and the pre-change bundles for rollback. |
| `preview/` | Signed-off screenshots of the redesign. |
| `reference/upstream-0.4.7/` | Pristine published 0.4.7 `src/` + `package.json`, for upgrade diffs. |
| `docs/` | This documentation. |

## Quick start

```bash
pnpm install --frozen-lockfile                     # toolchain from pnpm-lock.yaml
cd packages/dsh-usage && ../../node_modules/.bin/tsc -b tsconfig.build.json \
  && ../../node_modules/.bin/tsdown                # build (~100 ms, exit 0)
cd ../.. && node harness/build-test-bundle.cjs && node harness/render-test.mjs
node --experimental-strip-types harness/host-test.mjs
```

Expected: `=== 29/29 checks passed ===` and `=== 48/48 checks passed ===`.
`node_modules/` is git-ignored, so a fresh clone must run the install first;
the build reproduces the committed artifacts byte-for-byte.

## Install on another machine

The profile normally pins `@linxin666/dsh-usage` to the registry version
`0.4.7`. That is a problem for this workspace: any other plugin install,
update or removal in the profile re-resolves the pin and **overwrites the
patched copy** (this already happened once, on 2026-10-20 04:17). Pointing the
profile at a git dependency instead makes the copy stable — pnpm pins the
commit, and unrelated packages no longer touch it.

```bash
cd "${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
pnpm remove @linxin666/dsh-usage
pnpm add "git+https://github.com/<you>/dsh-usage.git#path:/packages/dsh-usage"
```

`#path:/packages/dsh-usage` is required: the plugin lives in a subdirectory of
the repository, not at its root. On a machine without network access to the
remote, a local clone works the same way:

```bash
pnpm add "git+file:///E:/path/to/dsh-usage/.git#path:/packages/dsh-usage"
# or, for a plain directory that is not a git checkout:
pnpm add "file:E:/path/to/dsh-usage/packages/dsh-usage"
```

`file:` on POSIX-style paths fails (`ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`) —
pass a Windows path (`cygpath -w`) on Windows. Under pnpm's `hoisted` linker
both forms install a real copy, not a symlink, so **editing `src/` does not
update an installed machine** — rebuild, commit and re-run `pnpm add` (or
`pnpm update @linxin666/dsh-usage`).

pnpm ends these commands with `ERR_PNPM_IGNORED_BUILDS` (koffi, node-pty,
protobufjs, ...). That is pre-existing profile noise, not a failure: the
plugin is already in place, and the build is verified by hashing
`node_modules/@linxin666/dsh-usage/lib/client.js` against the table below.

Deployment, reload behaviour and rollback: [`docs/build-and-redeploy.md`](docs/build-and-redeploy.md).
Design of the new panel: [`docs/usage-panel-redesign.md`](docs/usage-panel-redesign.md).
Device files, export/import and merging: [`docs/multi-device.md`](docs/multi-device.md).
Upstream baseline and patch inventory: [`docs/upstream-and-local-patches.md`](docs/upstream-and-local-patches.md).

## Current artifact hashes

Live profile == this workspace build (verified 2026-10-20):

| File | Size | MD5 |
| --- | --- | --- |
| `lib/client.js` | 448,096 B | `731e52a538cbc32b14c2c1cac5fb075d` |
| `lib/client.js.map` | 550,349 B | `234f3c04cf11b7559b8d28567bd8ffdb` |
| `lib/index.js` | 107,900 B | `21dd77686afce84548c6a6f8ffe643cc` |

Both halves now build from `src/`, so `lib/index.js` and the installed copy are
the same artifact — no post-build patching step. Deploying is a plain copy, but
note the two hazards in the deployment doc: a `pnpm install` in the profile
resets the package to the registry tarball, and `cp` onto a pnpm hardlink
writes through to the content-addressed store.
