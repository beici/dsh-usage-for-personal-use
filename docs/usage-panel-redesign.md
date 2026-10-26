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
| `RangeStrip` | The eight window tiles (今日 / 昨日 / 近 3 天 / 近 7 天 / 近 30 天 / 近 6 个月 / 全部 / 自定义; totals + `<n> 次调用` meta, active outlined via `aria-pressed`), plus the two date inputs when 自定义 is active. |
| window card | Title `<window>用量`, span line `{from} ~ {to}`, `TotalsRow` (6 cells), optional 消费（估算） row, `TrendChart`, then `各渠道 / 各模型`. |
| `TotalsRow` | 总 tokens / 输入 / 输出 / 缓存读 / 缓存命中 / 调用次数 — the cache-hit share is `cacheRead / billed input`, `—` when nothing was billed. |
| `TrendChart` | One stacked bar per calendar day; per-week buckets past 45 days, per-month past 200. Bars stack **by model** (each model keeps one panel-wide hue from `model-colors.ts`); windows without model data fall back to a token-type stack (缓存读/输入/输出). Gridded with 1/2/5×10ⁿ Y ticks, sparse X labels, hover tooltip (totals, calls, cache hit, heaviest models), 无记录 slots for gaps. |
| `ChannelBreakdown` | Per-channel bar **stacked by its models' hues** with share %, then the channel's model sub-bars in the same colors — **every** model the host returned (wire cap 12/provider) instead of only the top 3. Two scales, one per level: the **channel** bar measures against the **window total** (its length is the channel's share of the window, its segments are the models' slices of it), while each **model** sub-bar measures against the **channel total** — the mother bar's own 100 % — so the rows read as how that channel splits and a single-model channel fills its track, the same proportion its segment holds inside the bar above; the sub-row text (`tokens · calls · NN%`) states that channel share. Measuring the sub-bars on the window scale instead shrank every row by the channel's own window share, which read as "the sub-bars are based on the grand total" once a window carried many channels (7 天 and wider). The sub-row grid pins its side columns (`.chartModel`, 180px/176px), so every row's gray track measures the same length (see Styling). |
| `VoucherCard` / `PlanCard` / `SettingsRow` | Unchanged in behaviour (Token 银行 / 个人套餐 / 设置). |

Data paths: windows ≤45 days merge per-day views (`/api/dsh-usage/day`, cached
per session); longer ones — 近 6 个月 and 全部 — read one
`/api/dsh-usage/range` aggregate whose series rows also carry each day's
per-model split (aggregated across providers). **Both paths stop at yesterday**:
today is never fetched, it is folded in from the live overview (`viewsIn` for
merged days, `withLiveToday` for an aggregate), so every window keeps counting
with the poll and no cached aggregate can hold a stale copy of today. Caching one
that already carried today froze the day at fetch time and made 近 6 个月 read
*below* 近 30 天 — hence `fetchSpanOf`, which asks the range route for `from`
through `today - 1` and skips the request entirely for a window holding nothing
but today. 全部 spans the oldest retained day through today. Constants:
`RANGE_FETCH_MAX_DAYS = 45`,
`TREND_CHART_MIN_DAYS = 2` (a single day would paint one full-width bar that
reads as a solid block, so 今日/昨日 show totals + breakdown only),
`WINDOW_MODEL_CAP = 12` (mirrors the host's `summarizeDays` cap),
`SECTION_POLL_MS = 10_000`.

Ledger writes (`src/host/usage-service.ts`): the live fold listens to
`session/event` and folds every `assistant/message` that carries `usage`. The
route comes from the **record itself** (`data.message.source`, which the session
store refuses to publish without a provider *and* a model); `request/header` /
`request/context` feed `sessionRoutes` only as a fallback, and the day bucket
comes from the record's own `time`, not the fold instant. That ordering matters:
a header fires once per epoch, so a session whose single header landed before
the listener attached (the long-lived subagent sessions, whose header is
published at spawn) lost every later call — mcgrox read 25 % low against its own
upstream panel for exactly that reason. Calls made before the first mount are
still recovered by the startup replay (`collectSessionLogUsage`), which merges
per bucket with "larger total wins", so replay never shrinks a live bucket and
running it on every start is idempotent.

That merge rule is also why the replay has to be deduped: a seeded subagent's
transcript opens with a verbatim copy of its parent's `assistant/message`
records (same `data.message.id`, time and usage), and folding every file used to
count those calls twice — yesterday read 17 % high on the real ledger, and no
later run could bring it back down. `foldTranscript` now shares one `seen` set
across all files, keyed by `data.message.id` (records without an id still fold;
the older single-session format has none). The already-inflated buckets are
corrected once: `repairDuplicatedReplay` subtracts exactly the extra copies,
reprices them at the day's noon rate and writes the result over the file
verbatim — the merge-based flush keeps the larger total and would drop the
correction. A `usage-dedupe-marker.json` sidecar is written *after* that write,
so a failed write retries on the next start instead of being skipped forever.

Two more write-path rules:

- A ledger that cannot be read is never overwritten. `readLedgerFile` separates
  "missing" from "unreadable" (locked, permissions) from "corrupt"; unreadable
  keeps the write guard armed, retries the load five times 20 s apart and
  surfaces `usage.ledgerError` in the panel. A corrupt file is renamed to
  `usage-ledger.<device>.json.corrupt-<ts>.json` and reported, so a fresh
  document keeps counting without destroying the bytes someone may still want.
- A flush writes the file's growth plus this process's own growth. Two DSH
  processes on one machine (two windows, or the CLI beside the desktop app) share
  one file and each writes the whole document; `mergeLedgerDelta(disk, ledger,
  ledgerWritten)` adds only what this process folded since its last write, and
  the merged document is adopted, so neither window's calls are lost.

The replay runs before `pruneIfNeeded`: pruning first only resurrects the days
the replay then re-adds. Peer files are trusted only when the `deviceId` inside
the document matches the name it arrived under — a renamed copy of this machine's
own ledger would otherwise double every call.

`data-dsh-part` attributes (`range-tiles`, `range-card`, `window-card`,
`trend-chart`, `trend-bar`, `trend-tooltip`, `channel-breakdown`,
`model-rows`, `custom-range`, `custom-prompt`, `bank-card`, `tabs`, ...)
exist so the harness can assert structure without depending on hashed CSS
class names.

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

`src/client/usage.module.css` carries the section's blocks: `.rangeGrid` (a
fixed 4-column grid for the eight tiles), the `.rangeTile*` family,
`.rangeControls`, `.dateInput`, `.windowHead`, `.spanLine`, the `.trend*`
family (plot, gridlines, bars, segments, tooltip, X labels, legend) and
`.chartSeg` for the stacked channel bars, plus `.modelRows`. Inside the model
rows, `.chartModel` gives both side columns FIXED widths (`180px 1fr 176px`):
each row is its own grid, so content-sized side columns (`minmax`/`auto`)
resolved per row and shrank the gray track by that row's own name and caption
width — the tracks read as bars of inconsistent length. With fixed columns
every row's `1fr` track measures the same, within a channel and across
channels; the 180px name still ellipsizes, the 176px caption fits
`4.51B · 39352 次调用 · 100%`.

The breakdown reads as two levels, and the type says so: the channel row is a
group header — `.chartHeadName` at weight 600 and `.chartHeadTokens` at
11.5px/600 with 88 % opacity — while the model rows keep 11px at 80 % row
opacity with a 60 % caption, and consecutive channels are separated by a 7 %
hairline (`padding-top` 10px on `.chartProvider + .chartProvider`). Before
that, header and rows shared one `.chartTokens` rule (11px, 65 %), so a
channel's own numbers carried exactly the weight of its children's and the
block read as one undifferentiated column of figures.

Chrome (borders, gridlines, tooltip surface) follows the file's existing
idiom — `color-mix(in srgb, currentColor N%, transparent)` and opacity-based
hierarchy. The **model hues are the deliberate exception**: the reasonix
usage-stats palette — a fixed 16-hue series (`--dsw-chart-1..16`, the
upstream ten plus six same-style hues filling the wheel's gaps) plus a
neutral gray `--dsw-chart-other`, defined on `.section` with a light (70%
hue) and a dark (65% hue) white-veil variant — assigned in `model-colors.ts`
by a **stable hash of the normalized model name**: names fold first (any
`provider/` prefix stripped, letter case ignored, so `DeepSeek-V4.1-Flash`
and `deepseek-v4.1-flash` are one model that stacks as one segment and shows
its heaviest raw spelling), then each name takes the palette slot its FNV-1a
hash prefers, bumping past taken slots, and names past the sixteenth share
the gray. Hashing replaced the earlier token-rank assignment, which pinned
chart-1's blue onto whatever model led the current window — the dominant
model was blue everywhere and every hue reshuffled when the tile changed.
A model's color now rides its name alone: same hue in every window, on the
trend bars, the channel bars and the model rows, light and dark alike.

## Settings opener (foot card)

Clicking the foot card opens 设置 on the usage section. The shell seats the
account menu at the sidebar foot and exposes no direct service, so the opener
asks the shell's **shortcuts registry** to run its own `settings.open` command
(`ctx.get('shortcuts')`, softly probed like `webUiSettings`): the command's
resolve treats a null-modal page context as "open" and its run flips the
settings store, so the dialog opens with **no account-menu flash**. This
matters because Desktop Windows/macOS route real keys through the native
preload bridge and the DOM keydown listener returns before dispatch — the old
synthetic Ctrl+, never landed there (and the web bindings are Ctrl+Alt+, to
boot), so every click fell through to the visible fallback after ~250 ms. The
account-menu path (open menu → click its 设置 item) remains as the silent
fallback for hosts without the shortcuts service; an already-open dialog is
only ever nav-picked, never re-opened.

## Verification

- `node harness/render-test.mjs` — jsdom, real bundle, saved live fixtures,
  **61/61 checks**: eight tiles with correct labels/values/`aria-pressed`
  (近 3 天 sums 今日 + 10-19; 近 6 个月 / 全部 read the range aggregate, which the
  stub answers only up to yesterday — 49.2 M / 584 calls — so their 135 M / 1251
  tiles prove the panel folded the live today in itself, and no range fetch may
  end on today), six
  stat cells with the cache-hit share, no chart for single-day windows, 30
  model-stacked bars + 4 gridlines + hover tooltip (incl. a 无记录 slot) for
  近 30 天, model-named legend, per-model colored channel bars, exactly 3 day
  fetches for that window, 昨日 totals and cache hit derived from the fixture,
  custom prompt before picking, 30 daily bars after picking
  `2026-09-01 → 2026-09-30`, 9 month buckets + one range fetch after widening
  to `2026-01-01`, device card, three tabs, bank voucher, peak badge, plus the
  settings opener (registry `settings.open` invoked with a null-modal page
  context; an open dialog only nav-picked; the account-menu fallback still
  lands on the usage row) and a synthetic two-model channel in a channel that
  is 1.6 % of the window, asserting the model sub-bars read each model's share
  of that channel (74 % / 26 %, both in bar width and row text — the window
  scale would clamp both to the 3 % floor, so the assertion pins the channel
  denominator).
- `node --experimental-strip-types harness/host-test.mjs` — range aggregate +
  per-model series, route guards, device ledger, loopback fence, peak clock.
- Live bundle serving was proven against the running host:
  `GET /plugins/events` (loopback-exempt) lists the plugin row's `rev`, and
  `GET /plugins/??@linxin666/dsh-usage/client.js&rev=<rev>` returns the new
  bytes containing this redesign.

## Known limits

- `cost` is `0` for the providers in use (CodeBuddy/WorkBuddy/Qoder), so the
  消费（估算） row does not appear; it is wired and will show when pricing
  resolves.
- Per-model rows are capped at 12 per provider (host cap); the panel does not
  paginate beyond that. Models past the hashed 16-hue palette share the gray
  Other step.
- The usage tab does not use `overview.usage.range`/`all`; only the Token 银行
  tab does (`BANK_ALL_DAYS`).
