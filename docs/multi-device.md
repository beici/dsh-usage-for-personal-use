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
| `usage-ledger.<deviceId>.json` | One machine's own ledger. Each machine writes exactly one of these. |
| `usage-ledger.json.migrated` | The pre-split single-file ledger, renamed after its history was adopted. Only a marker; safe to delete. |
| `provider-snapshots.json` | Provider balance/plan snapshots. Unchanged, not part of the device split. |

The device id is derived from host name, platform and user name
(`sha256(host\0platform\0user)`, first 6 hex chars appended to a host-name
slug), so it is stable across restarts and fresh installs — a random id would
start a new ledger file on every launch. This machine resolves to
`p15-22893b`.

Peer files must be named `usage-ledger.<id>.json`. The file name wins over any
`deviceId` inside the document, so renaming a file is enough to correct a
mis-imported ledger.

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

Because the import replaces `usage-ledger.<peerId>.json` wholesale, importing
the same file again, or an older export from the same peer, converges instead
of accumulating. Note the consequence: importing a *stale* export from a peer
rolls that peer's row back. The peer's own file is authoritative; export it
from the peer again rather than hand-editing anything here.

## Never merged into your own ledger

Peer numbers are summed **at read time** (`UsageService.mergedLedger()`) and
never folded into `svc.ledger`. So:

- `usage-ledger.<self>.json` on disk contains only this machine's usage —
  verified by the "local ledger untouched by peers" and "flush never persists
  merged totals" checks in `harness/host-test.mjs`;
- a peer un-imported (file deleted) instantly stops contributing;
- retention pruning applies to the local ledger only.

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
- **No merge-on-import.** See the table above: a merge cannot be both exact and
  repeatable, and repeatability matters more for a backup story.

## Verification

```bash
node --experimental-strip-types harness/host-test.mjs
```

48 checks, covering device id hygiene, export envelope shape, import of valid
and invalid payloads, summing, re-import idempotence, the local-ledger
invariant, legacy migration (including that it persists before renaming the old
file away), and transcript backfill.
