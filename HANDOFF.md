# HANDOFF — DSH usage plugin (`@linxin666/dsh-usage`)

Last updated: 2026-10-27 (round 15 delivered).

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
node --experimental-strip-types harness/host-test.mjs       # 254 checks
node harness/render-test.mjs                                # 225 checks (jsdom)
bash patches/install-patches.sh                             # deploy + verify markers
```

`render-test.mjs` needs a real process exit (`Start-Process` + `WaitForExit` in
PowerShell) because jsdom keeps timers alive; the script calls `process.exit`.

Artifacts of the current tree (verified 2026-10-27):

| file | bytes | md5 |
| --- | --- | --- |
| `lib/index.js` | 176,807 | `0a8bb71f7eec537be4aab6499c21321e` |
| `lib/client.js` | 527,815 | `cf5844ba0b3b3b5c31b01506d1bb78b9` |
| `lib/client.js.map` | 707,139 | `04890d5fb3c19eaa586ff25af44045e5` |

## Live data (as of 2026-10-27 ~09:30, old build still running)

- `C:\Users\scrip\.dsh\dsh-usage\usage-ledger.p15-22893b.json` — still bare
  `{version, days}` with 11 days and no `machine` / `repairedAt` /
  `retentionDays`: the running host predates the repair, so the panel keeps
  over-reporting until DSH is fully restarted. The file was last written at
  01:23 UTC.
- `usage-ledger.json.migrated` holds the pre-migration history;
  `usage-ledger.izuf6gqghj119maddgtu7yz-2c08fa.json` is a peer file with no
  `machine` stamp (counted only for buckets this machine never recorded).
- Honest totals measured on the live file (08:55 sample, old build still
  writing): 58,112 calls / 6,833,370,365 tokens over 32 buckets and 11 days;
  replaying 373 transcripts (410 MB) through the current code repairs 3 buckets
  by −1,565 calls / −169,011,947 tokens.
- A copy of the live ledger driven through the current code gains
  `deviceId` / `machine` / `retentionDays`, keeps its days, and is idempotent
  across starts; the old build keeps inflating as new sessions land.

## Round 15 (this commit)

Host: a transcript replayed only inside the retained window (a lowered
`retainDays` no longer refolds transcripts it is about to prune); the repair
takes out `k` identical copies instead of exactly one (the marker records the
copy count, so a bucket duplicated twice converges instead of drifting); a
repair record without floors is treated as unusable rather than subtracting
everything twice; a BOM-prefixed repair record still guards its buckets and a
BOM-prefixed pre-migration ledger is adopted; the peer scan runs after the
repair (the repair's note no longer says a peer is unverified because it was
scanned first); the `unstampedWipe` heuristic is gone, so a shrink cannot wipe
history through the "clock jumped" path; an export carries the window it was
pruned to; quarantine copies are kept by write instant (ties broken by size,
then name); one machine under two file names counts once; a stale writer whose
peer lost calls in the interval reports `skipped` instead of `dropped 0`.

Client: a range total steps aside (`…`) while its history moves and comes back
grown; a single-day voucher states its date once; a clipboard that throws
synchronously still releases the button and says 复制失败; a local draw failure
is told apart from a request failure; an inverted custom pair keeps each typed
value in its own box.

## Open work

- Round 16 read-only audits (host / client / data) are running; fold their
  findings into the next round. The loop is the user's standing request: audit →
  fix → test → deploy → commit → audit again.
- The user must fully restart DSH for host changes to take effect (client half
  reloads with Ctrl+R / HMR).
