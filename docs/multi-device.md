# Multi-device usage: one ledger per machine

The plugin can aggregate usage across machines without any server and without a
sync service. Each machine writes only its own file; the overview adds up
whatever device files it finds. Moving data between machines is an explicit
export/import, and importing is safe to repeat.

## Why one file per device

A backup/restore round trip has to answer "whose numbers win?", and every answer
to that question loses data:

| Policy | What breaks |
| --- | --- |
| Overwrite on restore | The restoring machine's own usage disappears. |
| Sum on import | Importing the same backup twice double-counts. |
| `max` per bucket | Two machines on one account undercount the same day. |

So there is no merge policy. A device writes **only** its own file, and the
totals are a function of the *set* of files present — not of how many times one
of them arrived. That is what makes re-syncing idempotent by construction.

## Files on disk

All in `$DSH_HOME/dsh-usage/`:

| File | Meaning |
| --- | --- |
| `usage-ledger.<deviceId>.json` | One machine's own ledger. Each machine writes exactly one of these. It also carries the `machine` id it was written under, the `repairedAt` stamp of the last ledger repair, and the `retentionDays` window it was pruned to. |
| `usage-ledger.<deviceId>.json.lock` | Present only while a flush is reading, merging and writing that file. A lock older than the stale timeout is broken by the next writer, so a crashed process cannot block the ledger. |
| `machine-id.json` | This machine's pinned id, minted once. Deleting it only loses the name: the next launch mints another and adopts the file's own id again. |
| `usage-ledger.json.migrated` | The pre-split single-file ledger, renamed after its history was adopted. Only a marker; safe to delete. |
| `provider-snapshots.json` | Provider balance/plan snapshots. Unchanged, not part of the device split. |

The machine id is minted once and pinned in `machine-id.json`, so a host rename, a
user rename or a plugin reinstall keeps the same ledger — those are exactly the
events that change a derived identity. Two other ids also count as this machine:
any id this profile wrote under before (a lost pin is re-minted while the files on
disk keep the old stamp) and the derived id `sha256(host\0platform\0user)` with the
first 6 hex chars appended to a host-name slug, which builds before the pin stamped
into their files. That derived id is only the fallback for a profile that cannot
pin one, and accepting it always means two machines whose host name, user and
platform are identical share one history — an undercount, which is the lesser evil
next to a permanently doubled one. This machine resolves to `p15-22893b`.

Peer files must be named `usage-ledger.<id>.json`. The file name wins over any
`deviceId` inside the document, so renaming a file is enough to correct a
mis-imported ledger.

A file written before this build stamped a machine id carries no proof of which
machine wrote it, and a copy of *this* machine's own export has exactly the same
shape. Summing such a file whole counts our own history twice — that is how one
export put 2,766 calls / 330 M tokens on one day a second time — so it is added
bucket by bucket, and only the part beyond what this machine already recorded: a
day both files hold is not a day to add twice, and a bucket the peer has larger
than ours contributes the difference. The panel says so by name (`unverified:…`,
with the number of days and calls it did add). A peer that this build wrote
carries the `machine` digest and is summed in full.

Two DSH processes on one machine (two windows, or the CLI beside the desktop app)
share that one file. Each flush reads the file, adds only the calls it folded
since its own last write, and writes the merged document; the read-merge-write
runs under the lock file, so neither window's calls are lost. Buckets merge field
by field — never "the larger total wins", because the total ignores fields like
`reasoningTokens` and `cost`. A file whose stamp predates a repair this process
loaded is never re-adopted whole: those buckets are the ones the repair removed.
The flush writes its own document instead, takes only days it does not hold at
all, and says so in the panel — losing a handful of calls that window is
recoverable by the next replay, while a resurrected copy is permanent.

## Export and import

The usage panel's 设置 · 使用统计 tab shows a **多端汇总** ("Devices") card above
the settings row whenever the host exposes `devices`:

- one row per device, marking which is 本机 (local) and which are 已导入
  (imported);
- **导出本机用量** downloads this machine's own ledger as
  `dsh-usage-ledger-<deviceId>.json`;
- **导入其他设备** reads a file exported by another machine;
- **重新扫描** re-reads the persist directory without restarting — handy after
  dropping a file into the folder by hand;
- **复制标识** copies this machine's device id to the clipboard.

With no peer files the card still renders, with a 只有本机数据 line — so the
export button is discoverable before any other device exists.

The export envelope:

```json
{
  "schema": "dsh-usage-ledger",
  "version": 1,
  "deviceId": "p15-22893b",
  "exportedAt": "2026-10-20T07:00:00.000Z",
  "ledger": { "version": 1, "days": { "2026-10-20": { "buddy": { "m": { "...": 0 } } } } }
}
```

An import merges into the peer file already on disk instead of replacing it (an
older export of a device that kept counting would otherwise drop the days this
machine can no longer fetch), and it keeps what that file already recorded: the
`machine` id it was written under, and the `retentionDays` window its days were
pruned to — an export from an older build carries neither, and copying this
machine's window over the peer's would relabel history that was pruned to a
different one. The merge and the write run under the same lock as every other
ledger write, so two imports of one peer cannot lose each other's merge.

The pre-split migration follows the same rule: `usage-ledger.json` and
`usage-ledger.json.migrated` are max-merged into one document before it is
adopted, because `.migrated` is written as a superset of the legacy file and
absorbing both would count their shared days twice — permanently, since the
repair pass only knows replay duplicates.

Routes (all behind the same `isUsageAllowed` guard as the rest of the API):

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/dsh-usage/export` | GET | Own ledger, as a download. |
| `/api/dsh-usage/import` | POST | Body is an exported file, raw JSON. |
| `/api/dsh-usage/overview` | GET | Summed totals, plus `deviceId` and `devices`. |
| `/api/dsh-usage/day?date=` | GET | One day, summed across devices. |
| `/api/dsh-usage/refresh` | POST | Poll providers now. |

`import` is a stream-read with an 8 MB cap: `413` when the body is too large
(the cap is enforced while streaming, so an oversized upload is never buffered),
and `400` with a specific message for each kind of bad input — empty body,
non-JSON, missing `deviceId`, a `deviceId` unusable as a filename (`../etc`), a
payload that is not a ledger, and an attempt to import *this* machine's own
export. A `403` means the request did not come from loopback.

An import **merges into** `usage-ledger.<peerId>.json` instead of replacing it,
and the merge never lowers a bucket: importing the same file twice converges,
and importing an *older* export from a peer that kept counting keeps the days
the file already held (the panel notes how many) rather than dropping them. The
receiving machine has no way to fetch those days again, so the file on disk is
the authority and the import only ever adds. A file exported by an older build
carries no `machine` id; the peer file's own id is kept in that case, because
dropping it would turn a device this machine can attribute into an "unverified"
one and its days would then be counted only where this machine has no record.

**重新扫描** posts to `/refresh`, not `/overview`: the overview route answers with
the ledger the process already holds, while `/refresh` is the one that rescans
the persist directory and replays the transcripts before answering.

## Never merged into your own ledger

Peer numbers are summed **at read time** (`UsageService.mergedLedger()`) and
never folded into `svc.ledger`. So:

- `usage-ledger.<self>.json` on disk contains only this machine's usage —
  verified by the "local ledger untouched by peers" and "flush never persists
  merged totals" checks in `harness/host-test.mjs`;
- a peer un-imported (file deleted) instantly stops contributing;
- retention pruning applies to the local ledger only.

Peer files are scanned **after** the transcript replay, not before: whether a
peer's day is already recorded here is judged against this machine's ledger, and
a ledger that has not been replayed yet is missing exactly the days the
transcripts rebuild — so scanning first counted the peer's copy of them twice.
A peer file with no `machine` stamp contributes only the days this machine has
never recorded, because it cannot be told apart from a copy of our own history.

## Workflow across machines

1. On machine A: 导出 → a `dsh-usage-ledger-A.json` file.
2. Move that file to machine B by any means (cloud drive, `scp`, chat).
3. On machine B: 导入其他设备 with that file. The 多端汇总 card now lists A as
   an imported peer, and the overview includes A's usage.
4. Repeat in the other direction with B's export.

Each machine keeps its own history; nothing is ever overwritten. To retire a
peer, delete its `usage-ledger.<id>.json` and press 重新扫描.

## Not implemented on purpose

- **No automatic sync.** No network calls, no shared folder watching, no
  credentials. The design brief was manual import/export only; a sync service
  would need its own auth story and conflict policy.
- **No merge-on-import that lowers a bucket.** The import merges day by day and
  never lowers a number, so re-importing is safe and an older export cannot roll
  a peer back; the trade-off is that a peer that genuinely deleted usage keeps
  its old figure here.

## Verification

```bash
node --experimental-strip-types harness/host-test.mjs
```

241 checks, covering device id hygiene, the export envelope shape, import of
valid and invalid payloads, merging rather than replacing a peer file, summing,
re-import idempotence, the local-ledger invariant, legacy migration (including
that it persists before renaming the old file away), transcript backfill, the
loopback fence and the DeepSeek peak clock.
