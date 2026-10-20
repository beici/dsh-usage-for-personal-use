# Upstream baseline and local patches

## What this package is

`@linxin666/dsh-usage` — a DSH plugin with two halves, tracking upstream **0.4.8**
plus local changes:

- **host half** (`lib/index.js`, built from `src/index.ts` + `src/core/*` +
  `src/host/*`): a token-usage ledger (`~/.dsh/dsh-usage/usage-ledger.<device>.json`),
  provider balance / coding-plan probes, and the `dsh-usage.*` routes.
- **browser half** (`lib/client.js`, built from `src/client/*`): the
  设置 → 使用统计 section plus the price-glance card above the sidebar's
  Settings row.

Upstream: <https://github.com/zhu1090093659/dsh-web> (`packages/dsh-usage`).
The npm release **0.4.8 is the newest published version** and it is merged here.

## Local modifications

| # | What | Where | Needs app restart? |
| --- | --- | --- | --- |
| 1 | Usage panel redesign (windows / breakdown / chart) | browser half | **No** — `client-hmr` reloads it in place, a page refresh at most |
| 2 | Session-log backfill (count pre-mount usage) | host half | **Yes** — the host's ESM module graph is cached; only a full app restart re-evaluates it |
| 3 | Multi-device ledgers + export/import | host + browser halves | **Yes** (new host routes) |
| 4 | Proxy-aware loopback guard (upstream 0.4.8) | host half | **Yes** |

This difference matters when deploying: a UI change is hot-reloadable, a host
change is not. See [`build-and-redeploy.md`](build-and-redeploy.md).

### 1. Usage panel redesign

Source: `packages/dsh-usage/src/client/UsageSectionCard.tsx`,
`src/client/locales.ts`, `src/client/usage.module.css`.
Full description: [`usage-panel-redesign.md`](usage-panel-redesign.md).
No host-side change was needed.

### 2. Session-log backfill

Lives in `packages/dsh-usage/src/host/session-log-backfill.ts` and is wired into
`usage-service.ts` — it is part of the source, **not** a patch applied to a built
bundle. (The hand-patch notes in `patches/README-backfill-patch.md` and the
stored `index.patched-0.4.7.js` are kept for 0.4.7 rollback only.)

Summary of the three defects it fixes:

1. The upstream service only subscribes to `session/event` at mount time and
   never scans history, so everything that happened before the plugin was
   installed never reaches the ledger.
2. Events between mount and the next `request/header` are silently dropped
   (`assistant/message` requires `sessionRoutes.get(session)`).
3. It stamps `Date.now()` instead of the event's own `event.time`, so replayed
   events land on the wrong day.

It walks `~/.dsh/sessions/**/session.*.jsonl.zstd` (hand-rolled multi-frame zstd
decompression — `zstdDecompressSync` only decodes the first frame), folds
per-day/per-provider/model totals, and merges them into the ledger by
per-bucket **max**, which is idempotent and self-healing. `writeLedgerOnce()`
gained an `await this.loadPromise` so a flush cannot race the backfill.

Verification: `node patches/verify-backfill.cjs` compares the session logs
(ground truth) against the device ledger per `day|provider` and reports
coverage. Note it only sees **retained** transcripts; pruned days make coverage
exceed 100%, which is expected rather than a defect.

### 3. Multi-device ledgers

One ledger file per device (`usage-ledger.<deviceId>.json`); the overview
sums them without ever writing merged totals back. Details:
[`multi-device.md`](multi-device.md).

### 4. Proxy-aware loopback guard

Upstream 0.4.8 added `isProxiedRequest()` to `src/host/loopback.ts`: a request
carrying `x-forwarded-for` or `cf-connecting-ip` is no longer treated as
loopback. Without it, a reverse proxy (Cloudflare tunnel / frp / nginx) makes the
loopback fence pass for requests originating on the public internet. Merged in
commit `a54e7a0`.

That guard lives in the **host** half, so it is only live once the host process
has restarted after the deploy. Check it against the running host rather than the
files on disk:

```bash
# both must stop returning 200 once the new host bundle is loaded
curl -s -o /dev/null -w '%{http_code}\n' -H 'x-forwarded-for: 203.0.113.7' \
  http://127.0.0.1:<port>/api/dsh-usage/export
curl -s -o /dev/null -w '%{http_code}\n' -H 'cf-connecting-ip: 203.0.113.7' \
  http://127.0.0.1:<port>/api/dsh-usage/export
```

While the host is still running the pre-0.4.8 bundle both answer `200`; after the
restart they answer `401` (the fence rejects before routing), and the plain
loopback request still answers `200`.

## Upgrading past 0.4.8

1. Diff `reference/upstream-0.4.8/` against the new release's `src/`
   (`npm pack <pkg>@<version>` then diff) to see what upstream changed in
   `UsageSectionCard.tsx`, `locales.ts` and `usage.module.css` — the redesign
   touched all three, so expect conflicts there.
2. Merge the new source over `packages/dsh-usage/src/`. Keeping `src/` under git
   with upstream committed as a branch makes this a `cherry-pick` rather than a
   manual rediff.
3. Rebuild and run the harness; a changed host wire shape will show up as
   failing tile/stat assertions.
4. Verify our features survived: `usage.device.*` locale keys, the export/import
   routes, and `collectSessionLogUsage` in `lib/index.js`.
5. Refresh `reference/upstream-<version>/` with the new pristine source.

## Files that must never diverge

| Live profile file | Expected hash | Why |
| --- | --- | --- |
| `lib/client.js` | md5 `5b4af24ec632d3637590dd340eda4e21`, 450,874 B | the redesigned panel + the device-sync card + the peak badge |
| `lib/index.js` | md5 `1d68e04b3c5781bb9738f389f9577720`, 108,672 B | host bundle, backfill, device ledgers and the proxy-aware loopback guard compiled in from `src/` |
| `src/**` | identical to `packages/dsh-usage/src/` | so the live package documents itself |

A `pnpm install` / plugin update that overwrites `node_modules` destroys every
local modification; redeploy all three build artifacts plus `src/` from this
workspace afterwards (`bash patches/install-patches.sh`), then refresh the GUI.
The host half also needs a full app restart.
