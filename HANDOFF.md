# HANDOFF — DSH usage plugin (`@linxin666/dsh-usage`)

Last updated: 2026-10-27 (round 16 delivered).

## What this is

A DSH host+client plugin that reports token usage for this machine, reads the
session transcripts under `$DSH_HOME/sessions`, keeps a per-day ledger, and draws
a usage panel (tabs: 用量 / 套餐 / 鲸元; device export/import; trends).
Everything runs locally; the loopback route guards peer access.

- Repo: `E:\ai-space\dsh\dsh-usage` (branch `main`, remote `origin`).
- Package: `packages/dsh-usage` — `src/host/` (ledger, service, routes, device
  ledger, session-log backfill), `src/client/` (panel, trend chart, device card,
  palette, locales, CSS), built `lib/` (committed), tests in `harness/`.
- Deployed copy: `C:\Users\scrip\.dsh\profiles\desktop\node_modules\@linxin666\dsh-usage`
  (hardlinks into `lib/`, so `patches/install-patches.sh` is the way to deploy).

## Build, test, deploy

```bash
cd packages/dsh-usage
../../node_modules/.bin/tsc -b tsconfig.build.json          # types + emit, exit 0
../../node_modules/.bin/tsdown                              # bundles, exit 0
cd ../..
node harness/build-test-bundle.cjs                          # derives harness/client.test.cjs
node --experimental-strip-types harness/host-test.mjs       # 262 checks
node harness/render-test.mjs                                # 225 checks (jsdom)
bash patches/install-patches.sh                             # deploy + verify markers
```

`render-test.mjs` needs a real process exit (`Start-Process` + `WaitForExit` in
PowerShell) because jsdom keeps timers alive; the script calls `process.exit`.

Artifacts of the current tree (verified 2026-10-27):

| file | bytes | md5 |
| --- | --- | --- |
| `lib/index.js` | 179,284 | `bb1518048d95a3e3a97d12974d6656b9` |
| `lib/client.js` | 528,487 | `7f953820bc4bcb499fb0e2c0274d302b` |
| `lib/client.js.map` | 709,158 | `f89f3374637620f938f16d92084ca00a` |

## Live data (as of 2026-10-27 ~09:44, old build still running)

- `C:\Users\scrip\.dsh\dsh-usage\usage-ledger.p15-22893b.json` — still bare
  `{version, days}`, 11 days / 32 buckets / 58,838 calls / 6,922,973,827 tokens,
  no `machine` / `repairedAt` / `retentionDays`: the running host predates the
  repair, so the panel keeps over-reporting until DSH is fully restarted.
- Driven through the current code the same file repairs to 57,367 calls /
  6,766,453,008 tokens (3 buckets, marker `removedTokens: 168,550,944`) and is
  idempotent across starts; an independent recount of the transcripts gives
  55,800 unique calls / 6,604,279,098 tokens, and the remaining difference is
  fully accounted for (ledger-only history from `.migrated`, a provider rename,
  and a peer residue).
- `usage-ledger.json.migrated` holds the pre-migration history;
  `usage-ledger.izuf6gqghj119maddgtu7yz-2c08fa.json` is a peer file with no
  `machine` stamp (counted only for buckets this machine never recorded).

## Round 16 (this commit)

Host: an unverified peer whose residual has no calls left contributes no bucket
(no more "zero-call, pure-token" rows spliced out of two machines); the
duplicate replay uses the ledger's own window for its clean base, so a day the
ledger still keeps is repaired even when it sits outside the replay window; the
`repair-skipped` note no longer claims the ledger "holds more than the duplicate
set" when the skip was really "no such bucket" or "already clean"; a shrink is
recognised on the very first load (`retentionSeen` starts from the file's own
`retentionDays`, not the setting); a partial slab prune says so.

Client: the history stamp covers calls and cost as well as tokens (a repriced
bucket or a moved day no longer keeps serving the old split and the old ¥), and
a range aggregate is bound to the span it was fetched for.

## Open work

- Round 17 read-only audits (host / client / data) are running; fold their
  findings into the next round. The loop is the user's standing request: audit →
  fix → test → deploy → commit → audit again.
- The user must fully restart DSH for host changes to take effect (client half
  reloads with Ctrl+R / HMR).
