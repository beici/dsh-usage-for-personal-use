# HANDOFF — DSH usage plugin (`@linxin666/dsh-usage`)

Last updated: 2026-10-27 (round 13 delivered).

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
node --experimental-strip-types harness/host-test.mjs       # 226 checks
node harness/render-test.mjs                                # 187 checks (jsdom)
bash patches/install-patches.sh                             # deploy + verify markers
```

`render-test.mjs` needs a real process exit (`Start-Process` + `WaitForExit` in
PowerShell) because jsdom keeps timers alive; the script calls `process.exit`.

Artifacts of the current tree (verified 2026-10-27):

| file | bytes | md5 |
| --- | --- | --- |
| `lib/index.js` | 171,479 | `baa248cd365be2f9b871c2ce46d257a8` |
| `lib/client.js` | 522,189 | `f3c80ebc50dcceea3a016f253128c4ee` |
| `lib/client.js.map` | 694,627 | `95f84eeb7e63290352af13aef7914422` |

## Live data (as of 2026-10-27 ~07:20, old build still running)

- `C:\Users\scrip\.dsh\dsh-usage\usage-ledger.p15-22893b.json` — bare
  `{version, days}`, no `machine` / `repairedAt` / `retentionDays`: the running
  host is still the pre-repair build, so the panel over-reports by
  1,565 calls / 168,550,944 tokens until DSH is fully restarted.
- `usage-ledger.json.migrated` holds the pre-migration history;
  `usage-ledger.izuf6gqghj119maddgtu7yz-2c08fa.json` is a peer file with no
  `machine` stamp (counted only for days this machine never recorded).
- Honest totals once the repair runs: 50,435 calls / 5,910,068,224 tokens over
  48 buckets, from 354 transcripts (383 MB) — measured independently twice.

## Round 13 (this commit)

Host: load retry keeps calls folded while it waited; a bucket the repair cannot
finish is reported instead of passed over; an unverified peer loses only the
buckets it shares; quarantine copies keep the newest (the one the error names);
retention note stops blaming the clock for a shrink; `availableDays` covers every
day the totals count; BOM-prefixed exports import; stale-writer note names the
calls it did not re-adopt; a writer that gave up on the lock stands down.

Client: per-card `useId` for tab/panel/select ids (two cards no longer collide),
day picker label bound to its own select, trend chart exposed as one group,
hidden tabs do not paint, plan sub-bar share matches its width, copy button
describes what it copies, voucher/plan/device errors carry a described-by detail.

## Open work

- Round 14 read-only audits (host / client / data) are running; fold their
  findings into the next round. The loop is the user's standing request: audit →
  fix → test → deploy → commit → audit again.
- The user must fully restart DSH for host changes to take effect (client half
  reloads with Ctrl+R / HMR).
