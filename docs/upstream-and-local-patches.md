# Upstream baseline and local patches

## What this package is

`@linxin666/dsh-usage` 0.4.7 — a DSH plugin with two halves:

- **host half** (`lib/index.js`, built from `src/index.ts` + `src/core/*` +
  `src/host/*`): a token-usage ledger (`~/.dsh/dsh-usage/usage-ledger.json`),
  provider balance / coding-plan probes, and the `dsh-usage.*` routes.
- **browser half** (`lib/client.js`, built from `src/client/*`): the
  设置 → 使用统计 section plus the price-glance card above the sidebar's
  Settings row.

Upstream: <https://github.com/zhu1090093659/dsh-web> (`packages/dsh-usage`).
The npm release **0.4.7 is the newest published version**, so both local
changes live here rather than in an upgrade.

## Two local modifications

| # | What | Where | Needs app restart? |
| --- | --- | --- | --- |
| 1 | Usage panel redesign (windows / breakdown / chart) | browser half, `lib/client.js` | **No** — `client-hmr` reloads it in place, a page refresh at most |
| 2 | Session-log backfill (count pre-mount usage) | host half, `lib/index.js` | **Yes** — the host's ESM module graph is cached; only a full app restart re-evaluates it |

This difference matters when deploying: a UI change is hot-reloadable, a host
change is not. See [`build-and-redeploy.md`](build-and-redeploy.md).

### 1. Usage panel redesign

Source: `packages/dsh-usage/src/client/UsageSectionCard.tsx`,
`src/client/locales.ts`, `src/client/usage.module.css`.
Full description: [`usage-panel-redesign.md`](usage-panel-redesign.md).
No host-side change was needed.

### 2. Session-log backfill

Applied by `patches/apply-patch.sh` to the **published** 0.4.7 bundle — it is
not part of this workspace's `src/`, because it patches the built host bundle
rather than the TypeScript sources. Details in
[`../patches/README-backfill-patch.md`](../patches/README-backfill-patch.md).

Summary of the three defects it fixes:

1. The upstream service only subscribes to `session/event` at mount time and
   never scans history, so everything that happened before the plugin was
   installed never reaches the ledger.
2. Events between mount and the next `request/header` are silently dropped
   (`assistant/message` requires `sessionRoutes.get(session)`).
3. It stamps `Date.now()` instead of the event's own `event.time`, so replayed
   events land on the wrong day.

The patch adds a `session-log-backfill` region (~180 lines) that walks
`~/.dsh/sessions/**/session.*.jsonl.zstd` (hand-rolled multi-frame zstd
decompression — `zstdDecompressSync` only decodes the first frame), folds
per-day/per-provider/model totals, and merges them into the ledger by
per-bucket **max**, which is idempotent and self-healing. `writeLedgerOnce()`
gained an `await this.loadPromise` so a flush cannot race the backfill.

Verification: `node patches/verify-backfill.cjs` compares the session logs
(ground truth) against `usage-ledger.json` per `day|provider` and reports
coverage; expected 100%.

## Upgrading past 0.4.7

1. Diff `reference/upstream-0.4.7/` against the new release's `src/`
   (`npm pack <pkg>@<version>` then diff) to see what upstream changed in
   `UsageSectionCard.tsx`, `locales.ts` and `usage.module.css` — the redesign
   touched all three, so expect conflicts there.
2. Replace `packages/dsh-usage/src/` with the new source, then re-apply the
   redesign on top (the `docs/usage-panel-redesign.md` design notes are the
   spec).
3. Rebuild and run the harness; a changed host wire shape will show up as
   failing tile/stat assertions.
4. Rebuild both bundles. The backfill now lives in
   `src/host/session-log-backfill.ts` and is wired into
   `usage-service.ts`, so nothing needs re-patching — verify it survived with
   `grep -c 'collectSessionLogUsage' lib/index.js`. (The hand-patch notes in
   `patches/README-backfill-patch.md` and the stored `index.patched-0.4.7.js`
   are for 0.4.7 rollback only.)
5. Refresh `reference/upstream-<version>/` with the new pristine source.

## Files that must never diverge

| Live profile file | Expected hash | Why |
| --- | --- | --- |
| `lib/client.js` | md5 `731e52a538cbc32b14c2c1cac5fb075d`, 448,096 B | the redesigned panel + the device-sync card |
| `lib/index.js` | md5 `21dd77686afce84548c6a6f8ffe643cc`, 107,900 B | host bundle, backfill and device ledgers compiled in from `src/` |
| `src/**` | identical to `packages/dsh-usage/src/` | so the live package documents itself |

A `pnpm install` / plugin update that overwrites `node_modules` destroys every
local modification; redeploy all three build artifacts plus `src/` from this
workspace afterwards (`bash patches/install-patches.sh`), then refresh the GUI.
The host half also needs a full app restart.
