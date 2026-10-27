# HANDOFF — DSH usage plugin (`@linxin666/dsh-usage`)

Last updated: 2026-10-27 (round 21 delivered).

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
node --experimental-strip-types harness/host-test.mjs       # 280 checks
node harness/render-test.mjs                                # 225 checks (jsdom)
bash patches/install-patches.sh                             # deploy + verify markers
```

`render-test.mjs` needs a real process exit (`Start-Process` + `WaitForExit` in
PowerShell) because jsdom keeps timers alive; the script calls `process.exit`.

Artifacts of the current tree (verified 2026-10-27):

| file | bytes | md5 |
| --- | --- | --- |
| `lib/index.js` | 190,628 | `3424ccbcf98bdca2d11253003653ba3c` |
| `lib/client.js` | 536,663 | `eb35435016e27dd05d97a756e4b76df5` |
| `lib/client.js.map` | 727,360 | `14bdabdc29059f4f6a6c63960c23d7d1` |

## Live data (as of 2026-10-27 ~12:40, old build still running)

- `C:\Users\scrip\.dsh\dsh-usage\usage-ledger.p15-22893b.json` — still bare
  `{version, days}`, 11 days / 32 buckets / 62,718 calls / 7,438,071,855 tokens,
  no `machine` / `repairedAt` / `retentionDays`: the running host predates the
  repair, so the panel keeps over-reporting until DSH is fully restarted.
- Driven through the current code the same file repairs to 61,153 calls /
  7,269,520,911 tokens (3 buckets, marker `removedTokens: 168,550,944`) and is
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

## Round 19 (this commit)

Host: the peer scan now runs *after* the repair is judged, so the startup that
repairs cannot pull the same machine's pre-repair copy back over its own result.
The repair record (v3) is keyed by `(day, provider, model)` and carries the clean
totals it corrected: a peer holding the pre-repair value is refused, a bucket
that really grew still counts, and a record whose corrected buckets are all zero
is never used as a clean base. The rename clamp is keyed on the file's own
contents rather than a shared timestamp, whole multiples of a copy are taken out
(three copies of one call are corrected, a partial residue is not), and an entry
the reader had to leave out (an impossible day key, a bucket that is not an
object) is named once in the panel instead of the history shrinking in silence.

Client: no changes this round (round-17 client fixes remain green at 225/225).

## Round 20 (this commit)

Host: the repair is now judged *before* this machine's own renamed files are
folded in, and the buckets it corrected are clamped to their clean value when such
a file is folded in — a peer written from the same session could otherwise carry
the pre-repair value back in and be locked there by the record. The clamp only
applies to the buckets the record names (a bucket that really grew keeps its
growth). A machine id found in the ledger is only remembered as an alias when this
profile already has a pin or the id is already this machine's — otherwise a
machine's id would be adopted from a ledger that may not be its own. The marker
keys are sorted before they are written; a note that reports history going missing
is never pushed off the five-note line by routine ones; and a peer file that
contributes nothing is no longer listed as a device.

Client: the history stamp is position sensitive — a rolling hash over each past
day's own numbers, so a bucket moved between two days invalidates the cached
windows instead of serving the old split. A failed share now has its own sentence
(not "保存失败"), a stalled encoder is released by a watchdog, a draw failure
disables both buttons instead of letting a save of a broken canvas through, a
share failure is not stored as a save failure, and the voucher canvas is named
with its value and window instead of the bare widget title.

## Round 21 (this commit)

Host: a same-machine copy is now merged with a case/spacing-insensitive key, so a
peer file spelling `Buddy/M1` beside this machine's `buddy/m1` merges instead of
billing the day twice; the note registry evicts only routine keys, so a
`ledger-dropped` / `repair-short` line survives twenty-five peers; a foreign
writer's newer `repairedAt` no longer drops what a peer fold contributed (the fold
is remembered and merged in that branch); a repair that stood down on the lock is
recorded so the next flush does not put its subtraction back; a correction for a
future day is ignored; counters that are not finite numbers are read as zero and
the affected entry is named once; a ledger whose `days` is not an object is
quarantined rather than emptied; the quarantined file is described on the note
line; and dead assignment in the repair writer was removed.

Client: the history stamp now folds the whole-ledger total as well, so a backfill
into a day older than the thirty-day trend window invalidates the cached 近 6 个月
/ 全部 answers; a stalled encoder is called a draw failure instead of a request
failure (it is no longer fed through `describeError`); the share watchdog is
disarmed before the share sheet opens, so a user reading the sheet is not told at
fifteen seconds that the share failed; the two voucher buttons keep their own busy
labels; a null blob, a `canShare` refusal and a throw each say which step failed;
every voucher error line is a `role="status"`; model mode gives tokens that have no
model split their own slate segment (and a legend entry) instead of drawing a bar
shorter than its own total; the device card gives an import 75 s instead of 20 s to
cover the host's sixty-second merge budget; a rejected settings write shows the
host's own sentence instead of "请求失败"; the voucher error is cleared when the
data changes; the dead bar `onFocus`/`onBlur` handlers and their stale stylesheet
comment are gone; and the button row and settings row wrap on a narrow panel.

Tests: host-test 288/288 (nine new: an unreadable entry reported, a copy spelled
differently not billed twice, the next flush not putting the copies back, a
reasoning-only bucket surviving the delta, an absurd counter read as zero and
reported, a ledger with no `days` key quarantined rather than emptied, a
quarantined ledger described on the note line, a correction for a future day
ignored). render-test 232/232 (seven new: a stalled encoder called a draw failure,
a stalled encoder handing the button back, a share button offered only when the
sheet is supported, two buttons keeping their own busy label during a share, an
open share sheet not called a failure, a day without a model split still drawing
its tokens, and a legend naming the unclassified remainder).

## Open work

- Round 21 is delivered; the next step in the user's standing loop (audit → fix →
  test → deploy → commit → audit again) is round 22's three read-only audits.
- The user must fully restart DSH for host changes to take effect (client half
  reloads with Ctrl+R / HMR).
