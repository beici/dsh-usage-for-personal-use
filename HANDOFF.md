# HANDOFF — DSH usage plugin (`@linxin666/dsh-usage`)

Last updated: 2026-10-27 (round 18 delivered).

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
node --experimental-strip-types harness/host-test.mjs       # 271 checks
node harness/render-test.mjs                                # 225 checks (jsdom)
bash patches/install-patches.sh                             # deploy + verify markers
```

`render-test.mjs` needs a real process exit (`Start-Process` + `WaitForExit` in
PowerShell) because jsdom keeps timers alive; the script calls `process.exit`.

Artifacts of the current tree (verified 2026-10-27):

| file | bytes | md5 |
| --- | --- | --- |
| `lib/index.js` | 182,010 | `703f36280926196f0bf94a612430a004` |
| `lib/client.js` | 530,518 | `732f41a7dbd54d37c4b2d1e6d3426059` |
| `lib/client.js.map` | 712,984 | `a0924748c72631a805758b5807ece6ca` |

## Live data (as of 2026-10-27 ~10:20, old build still running)

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

## Round 18 (this commit)

Host: the repair no longer keeps a floor of the values it wrote — the record now
names the buckets it *corrected*, so a bucket is judged once and a bucket that
grew afterwards is not mistaken for a fresh copy (and a backup restored over a
repaired ledger is judged again, since its file predates the repair). A bucket
holding fewer calls than the duplicate-free replay is stated as short, never as
inflated; a ledger whose `days` is not a plain object is quarantined instead of
being read as empty and overwritten; a negative counter is read as zero; a
renamed file of this machine is clamped only when its mtime predates the repair,
so calls that arrived after it survive; and a stale lock is only broken after
re-reading its token, so a lock this process did not take is left alone.

Client: no changes this round (the round-17 client fixes were already green).

## Open work

- Round 19 read-only audits (host / client / data) are running; fold their
  findings into the next round. The loop is the user's standing request: audit →
  fix → test → deploy → commit → audit again.
- The user must fully restart DSH for host changes to take effect (client half
  reloads with Ctrl+R / HMR).
