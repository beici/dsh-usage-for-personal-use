# Usage panel redesign

## Requirement

User request (2026-10-20): make 设置 → 使用统计 show, intuitively, the
**per-channel and per-model usage for 今日 / 昨日 / 近一周 / 30 天 and a custom
range**. The pre-existing panel only offered a single-day `<select>` and a
"近 30 天" bar list, so comparing windows meant clicking through days.

## What the host already serves

Nothing in `lib/index.js` had to change. The loopback-fenced API already
returns everything needed:

| Endpoint | Payload |
| --- | --- |
| `GET /api/dsh-usage/overview` | `usage.today` (full per-provider/per-model day view), `usage.availableDays` (every retained day key), `usage.days` (last-30 trend rows), `usage.range` / `usage.all` (aggregates), `providers` (60 routes with `displayName`, credentials, balances), `current`. |
| `GET /api/dsh-usage/day?date=YYYY-MM-DD` | One retained day: totals + per-provider + per-model rows. |
| `POST /api/dsh-usage/refresh` | Forces a host probe cycle. |

Note `overview.usage.range` is the aggregate over the last 30 **recorded**
days, not a calendar window, and the host offers no arbitrary-range route.

## How the client assembles windows

`src/client/UsageSectionCard.tsx`:

- **Today rides the live overview** (`usage.today`), so it keeps updating with
  the 10 s poll without any extra request.
- **Every other window is merged in the browser** from one
  `GET /api/dsh-usage/day` request per *recorded day inside the window*
  (`overview.usage.availableDays` is the candidate list). Only days the ledger
  actually has data for are fetched — a 30-day window with 4 recorded days
  costs 3 requests (today excluded), not 30.
- Requests are bounded by `DAY_FETCH_CONCURRENCY = 6` (`mapPool`), deduplicated
  in flight (`dayRequests`), and cached for the session (`DayCache`). A manual
  刷新 clears the cache and refetches, because a late backfill can still change
  a past day.
- The four fixed windows are all inside 近 30 天, so one load
  (`last30Days = useWindowDays(..., recordedIn(last30Window, ...))`) feeds all
  of them; each tile slices the same loaded set.
- The custom range gets its own load keyed by the picked pair.

## Window definitions

`todayDate = overview.usage.today.date`; all shifts are local-date keys via
`shiftDateKey()` (noon-anchored to survive DST):

| Tile | Window |
| --- | --- |
| 今日 | `[today, today]` |
| 昨日 | `[today-1, today-1]` |
| 近 7 天 | `[today-6, today]` |
| 近 30 天 | `[today-29, today]` |
| 自定义 | user pair; see below |

**Custom range semantics** (the part that needed the most care):

- `customPicked = customFrom !== undefined || customTo !== undefined`.
- While untouched, the tile shows `选择日期` / `Pick dates` — *not* the default
  window's total, which would just duplicate the 近 7 天 tile — and the detail
  card shows an explanatory prompt instead of fetching anything.
- Picking one end only: the other defaults to today (`from` missing) or to
  `end - 6` (`to` missing), so a half-picked pair still renders a real window.
- An inverted pair is swapped rather than rejected.
- Both ends feed `<input type="date">` with `min`/`max` cross-constraints.
- `dateKeysBetween()` caps a window at `CUSTOM_MAX_DAYS = 366` so a malformed
  pair cannot walk off the calendar.

## Components (`src/client/UsageSectionCard.tsx`)

| Component | Renders |
| --- | --- |
| `RangeStrip` | The five window tiles (totals + `<n> 次调用` meta, active outlined via `aria-pressed`), plus the two date inputs when 自定义 is active. |
| window card | Title `<window>用量`, span line `{from} ~ {to}`, `TotalsRow` (6 cells), optional 消费（估算） row, `DailyChart`, then `各渠道 / 各模型`. |
| `TotalsRow` | 总 tokens / 输入 / 输出 / 缓存读 / 缓存写 / 调用次数. |
| `DailyChart` | One bar per calendar day (`height` proportional to that day's total), axis labels first/last day. |
| `ChannelBreakdown` | Per-channel bar with share %, then the channel's model sub-bars — **every** model the host returned (wire cap 12/provider) instead of only the top 3. |
| `VoucherCard` / `PlanCard` / `SettingsRow` | Unchanged in behaviour (Token 银行 / 个人套餐 / 设置). |

Constants worth knowing: `DAILY_CHART_MAX_DAYS = 45` (wider windows drop the
chart), `DAILY_CHART_MIN_DAYS = 2` (a single day would paint one full-width
bar that reads as a solid block, so 今日/昨日 show totals + breakdown only),
`WINDOW_MODEL_CAP = 12` (mirrors the host's `summarizeDays` cap),
`SECTION_POLL_MS = 10_000`.

`data-dsh-part` attributes (`range-tiles`, `range-card`, `window-card`,
`daily-chart`, `channel-breakdown`, `model-rows`, `custom-range`,
`custom-prompt`, `bank-card`, `tabs`, ...) exist so the harness can assert
structure without depending on hashed CSS class names.

## Localization

`src/client/locales.ts` gained 16 keys in **both** `zh` and `en`, right after
`usage.trend`:

`usage.range.title` 统计窗口 / `today` 今日 / `yesterday` 昨日 / `last7` 近 7 天 /
`last30` 近 30 天 / `custom` 自定义 / `customFrom` 开始 / `customTo` 结束 /
`customPick` 选择日期 / `customPrompt` 选择开始与结束日期… / `span` `{from} ~ {to}` /
`detail` `{label}用量` / `channels` 各渠道 / 各模型 / `cost` 消费（估算） /
`empty` 该时间范围内没有用量记录 / `loading` 正在加载… / `error` 部分日期加载失败：{error}

The dictionary is picked at runtime (`document.documentElement.lang` starts
with `en` → English), so both must stay complete.

## Styling

`src/client/usage.module.css` gained a block before `.muted`: `.rangeGrid`,
`.rangeTile`, `.rangeTile:hover`, `.rangeTile:focus-visible`, `.rangeTileActive`,
`.rangeTileLabel`, `.rangeTileValue`, `.rangeTileMeta`, `.rangeControls`,
`.dateInput` (+`:focus-visible`), `.windowHead`, `.spanLine`, `.dailyWrap`,
`.dailyChart`, `.dailyBar`, `.dailyFill`, `.dailyBar:hover .dailyFill`,
`.dailyLabels`, `.modelRows`.

They follow the file's existing idiom — `color-mix(in srgb, currentColor N%,
transparent)` borders/fills and opacity-based hierarchy, no hardcoded theme
colours — so the panel adapts to light/dark without new tokens.

## Verification

- `node harness/render-test.mjs` — jsdom, real bundle, saved live fixtures,
  **35/35 checks** (21 window facts + 8 device-card facts + 6 peak-badge facts): five tiles with correct labels/values/`aria-pressed`, six
  stat cells, no chart for single-day windows, 30 calendar bars + span for
  近 30 天, exactly 3 day fetches for that window, 昨日 totals derived from the
  fixture, custom prompt before picking, 30 bars after picking
  `2026-09-01 → 2026-09-30`, three tabs, bank voucher, plans empty-state.
- `preview/*.png` — headless Edge screenshots of 今日 / 近 30 天 / 昨日 / 自定义.
- Live bundle serving was proven against the running host:
  `GET /plugins/events` (loopback-exempt) lists the plugin row's `rev`, and
  `GET /plugins/??@linxin666/dsh-usage/client.js&rev=<rev>` returns the new
  bytes containing this redesign.

## Known limits

- `cost` is `0` for the providers in use (CodeBuddy/WorkBuddy/Qoder), so the
  消费（估算） row does not appear; it is wired and will show when pricing
  resolves.
- Per-model rows are capped at 12 per provider (host cap); the panel does not
  paginate beyond that.
- The usage tab does not use `overview.usage.range`/`all`; only the Token 银行
  tab does (`BANK_ALL_DAYS`).
