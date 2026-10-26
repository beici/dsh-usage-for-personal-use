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
  the panel's poll without any extra request.
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
  of them; each tile slices the same loaded set. A tile judges its own window
  (`slicePending` / `sliceFailed`), so a day that is still in flight elsewhere
  in the shared load cannot hold a window whose dates already arrived at "…",
  and a day that lands republishes the load immediately.
- A failed day or window retries on the panel's own cadence (`retryTick`), so
  one dropped request no longer pins a tile at "—" until the user refreshes.
- The custom range gets its own load keyed by the picked pair.
- Polling follows the shared `pollIntervalSec` setting (floored at 10 s), so a
  user who slows the host down also slows the panel; the sidebar card does the
  same with its own 30 s floor.
- Percentages are rounded with the largest-remainder method — channel headers to
  100 % together, and the model rows inside one channel likewise, as long as the
  host did not truncate the list (it keeps 12 models per channel); when it did,
  the rows state the share of what is shown.

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
- `dateKeysBetween()` caps a window at `TREND_MAX_DAYS = 731` (two years) so a
  malformed pair cannot walk off the calendar; the trend chart buckets by the
  same constant, which is what keeps "the widest window" and "the chart" from
  disagreeing about how far back they look.
- The from-date input carries `min = recorded[0]` once the ledger has any day at
  all, so the picker cannot open a window that starts before the first record.

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
but today. 全部 spans the oldest day the *merged* ledger holds — this machine's or a peer's adopted history — through today (a floor taken from this machine's own days asked for a span narrower than the totals above it). Constants:
`RANGE_FETCH_MAX_DAYS = 45`,
`TREND_CHART_MIN_DAYS = 2` (a single day would paint one full-width bar that
reads as a solid block, so a one-day window shows totals + breakdown and says
`usage.trend.tooFewDays` instead of an unexplained empty plot),
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
across all files, keyed by `data.message.id`; a record without an id falls back to
a content key (provider, model, time and every token field), and a repeat is
skipped only when the key came from a *different* file, so two identical records
inside one transcript still count. The already-inflated buckets are corrected by
`repairDuplicatedReplay`, which subtracts the extra copies, reprices them at the
day's noon rate and writes the corrected document back — the merge-based flush
keeps the larger total and would drop the correction.

Two rules make that correction safe to repeat on every start:

- It is judged, not blind, and the yardstick is *where the bucket stood before*
  this repair: the total an earlier start already left behind (read back from the
  marker), or — on the first start — what the deduped replay bills. The bucket has
  to still carry *exactly* `base + copies`. A lower bucket holds real calls the
  replay cannot see (they must stay); a bucket that grew by more than the copies is
  not explained by them; a bucket already at `base` was corrected once. Only an
  exact match is rewritten, and anything else is left alone — a repair that cannot
  explain a bucket must not touch it.
- `usage-dedupe-marker.json` is a record, not a gate. Version 2 stores the totals
  the repair left in each bucket (`after`), which is the floor the next start
  compares against; a later pass merges its own floors into the existing map
  instead of replacing it, so an older day keeps its floor. The marker is written
  only after the corrected file landed (a crash in between re-runs an idempotent
  pass instead of leaving a claim over an inflated ledger). A ledger restored from
  a backup is therefore corrected again instead of staying inflated forever.

The correction is applied to the file's own document rather than written over it
verbatim: reading, replaying ~18 s of transcripts and writing leaves a window in
which another process folds real calls into the same buckets, and a verbatim
overwrite would drop them. The written document carries `repairedAt`; a second
process that loaded the inflated copy sees the newer stamp on disk and adopts the
corrected document whole, instead of max-merging its own stale totals back in.

Retention is guarded the same way, but the guard has to tell a jumped clock from
a setting the user lowered on purpose. The file records the window it was pruned
against (`retentionDays`), and a day still on disk *outside that window* means the
clock moved — the file's own prune would already have dropped it. A file from an
older build records no window at all, so its days are never read as a jump. So:

- one prune is refused outright: more than half the recorded days would go while
  days sit outside the file's own window, or every recorded day would go — a
  shrink does not exempt the second case, because a window that happens to
  exclude everything on file is not a retention decision, and the days it would
  take have no transcripts to rebuild them. The share matters because a replay can
  rebuild a day or two near the new "today" while everything recorded before the
  jump falls out — a count of survivors looked healthy two days after a 420-day
  jump. The note names the way out: delete the ledger file to accept the jump.
- the refusal is sticky, and it ends when it stops being true. While it stands,
  the file keeps the window it carried before the jump; writing the new setting
  would make the next flush — and the next boot — read those days as "inside the
  file's window" and prune them, so the refusal would last exactly one flush. The
  setting is written again once a prune is accepted, and the note is retired by
  the same pass that finally prunes (or by a start that finds the file's window
  equal to the setting): leaving "delete the ledger file" standing beside a
  healthy ledger is advice that destroys data for no reason.
- a shrink is honoured for the *size* of what it drops, never for wiping the
  ledger: its days are inside the file's own window, so it never trips the share
  test, but it cannot empty the file either.
- a *partial* jump — a forward step that leaves some days inside the window —
  cannot be refused without wedging the file forever (an older build that kept
  more days than the window would never shrink again), so it prunes and says so:
  one pass that drops more than 30 % of at least four recorded days is reported
  as "pruned N of M recorded days at once — the clock may have jumped". That
  warning rides along with a shrink instead of being hidden behind it.
- a shrink that deletes days says how many it dropped, because the panel then
  simply shows less history — and that note is not cleared by the first flush (it
  would be gone three seconds after the user asked for the shrink): it stays until
  a start finds the file's recorded window equal to the setting, i.e. until the
  shrink is actually on disk. Keeping `retainDays` days also means dropping
  anything older than `today-(retainDays-1)`, so the widest window and "all" agree
  instead of the history keeping one extra day.

Two more things the ledger file must survive, because both end in a silent wipe:

- A `/export` envelope (`{schema, version, deviceId, machine, exportedAt,
  ledger}`) is a legitimate way to restore a backup, and `importPeer` refuses
  this device's own export. `ledgerFromJson` unwraps the envelope; a file naming
  *another* device is adopted under that device's name as a peer, and a document
  without a top-level `days` object is quarantined instead of being read as an
  empty ledger. `machine` travels through the round trip: an import that dropped
  it would leave a file the peer scan can no longer attribute.
- `usage-ledger.<id>.bak.json` is a copy, not a second machine. Device ids never
  contain a dot, so peer discovery skips any name carrying this device's prefix
  (and any `.corrupt-` quarantine). A peer document is trusted only when the
  `deviceId` inside it matches its file name **and** it names a machine id that
  differs from this machine's. Two consequences follow, both of them the point:
  a document with no `machine` at all is reported and left out of the totals
  (counting an unverifiable file is how one machine's own history gets summed
  twice), and a document naming *this* machine under another device name is
  merged in (`mergeLedgerMax`) rather than added as a second device.
- The machine id is minted once and pinned in `machine-id.json` inside the
  persist dir. It has to survive a host rename, a user rename and a plugin
  reinstall — exactly the events that change a derived identity — because it is
  what tells "this machine, renamed" apart from "a second machine". Two ids also
  count as this machine: one this profile wrote under before (a lost pin is
  re-minted, while the files on disk keep the old stamp) and the digest of host,
  platform and user that builds before the pin stamped into their files. The
  digest is only the fallback for a read-only profile that cannot pin one, and
  accepting it always means two machines whose host name, user and platform are
  identical share a history — an undercount, which is the lesser evil next to a
  permanently doubled one. The aliases are *durable*: `device-ledger.json` keeps a
  short `machines` list of the stamps this profile has accepted, so a lost
  `machine-id.json` no longer turns every old file into a second machine (a live
  in-memory alias alone was inert — it was born at start and thrown away at exit,
  which is exactly when the pin it substitutes for is read).

The pre-rename `usage-ledger.json` is read when this device's file is missing,
and so is the `.migrated` sibling a successful migration leaves behind: that
sibling is the only copy of the pre-migration history once the device file is
deleted or damaged. A migration that finds both adopts both — an earlier
`.migrated` file is history, not a name to rename over — and retires the legacy
file only after merging its days into that sibling, so a second migration cannot
drop the first one's days.

Two more write-path rules:

- A ledger that cannot be read is never overwritten. `readLedgerFile` separates
  "missing" from "unreadable" (locked, permissions) from "corrupt"; unreadable
  keeps the write guard armed, retries the load five times 20 s apart and
  surfaces `usage.ledgerError` in the panel. Once that budget is spent the file is
  moved aside as `usage-ledger.<device>.json.unreadable-<ts>.json` and counting
  continues in a fresh document: refusing to write for the rest of the session
  would lose every call folded after the boot, and the bytes stay salvageable by
  hand. A corrupt file is renamed to
  `usage-ledger.<device>.json.corrupt-<ts>.json` and reported, so a fresh
  document keeps counting without destroying the bytes someone may still want.
  Both quarantine names are capped at the newest three: each is a full copy of a
  ledger that can be megabytes, and a profile that keeps failing would otherwise
  fill the directory with copies of the same broken file.
- A flush writes the file's growth plus this process's own growth. Two DSH
  processes on one machine (two windows, or the CLI beside the desktop app) share
  one file and each writes the whole document; `mergeLedgerDelta(disk, ledger,
  ledgerWritten)` adds only what this process folded since its last write, and
  the merged document is adopted, so neither window's calls are lost. Buckets are
  merged field by field (`mergeLedgerMax`), never by "larger total wins": the
  total ignores fields like `reasoningTokens` and `cost`, so comparing totals
  would silently drop them. The read-merge-write runs under a lock file
  (`usage-ledger.<id>.json.lock`, `wx`, broken after a stale timeout), so two
  processes cannot read the same version and lose one side's calls. The lock
  names its holder: a release only removes the file if it still carries this
  process's token, and a stale lock is only broken after re-reading it, because
  measured on Windows a second process can delete a lock whose holder still has
  it open. The wait is four seconds — longer than any write, shorter than the
  stale timeout — and a flush that still cannot take it writes anyway and says
  so (`lock-busy`): losing one interleaved write is recoverable on the next
  replay, refusing to write at all is not.
- A file that predates the correction is not re-adopted. When a write fails (a
  locked file, a read-only profile, a full disk) the disk still holds the inflated
  buckets while memory holds the corrected ones, and a plain max merge would put
  them straight back — permanently, since the marker has not been written yet. So
  a flush that finds a stamp older than the correction it loaded writes *its own*
  document, takes from the file only the days it does not hold at all, and reports
  `usage.ledgerNote`. Losing a handful of calls in that window is recoverable by
  the next replay; a resurrected copy is not. The note counts what it dropped
  (`N call(s) it gained under an older build were not re-adopted`) instead of
  leaving the loss silent.
- A file that carries a newer `repairedAt` than this process loaded is adopted
  whole (plus this process's own growth), so a process that loaded before the
  correction cannot undo it.
- Peer discovery is not allowed to lose data either. A scan that fails keeps the
  peers it already knows and reports `usage.devicesError`; a peer document whose
  `deviceId` does not match its file name, or whose `machine` is this machine, is
  skipped with a named failure. A peer document written before the `machine` digest
  existed cannot be told apart from a copy of this machine's own export — the shape
  is identical — so it contributes only the days this machine has never recorded,
  and the note names the file and how many days it added (`unverified:<id>`).
  Non-fatal trouble (a skipped retention pass, a transcript set that hit the
  discovery cap, a quarantined file) travels to the panel as `usage.ledgerNote`
  instead of being swallowed.
- A peer scan never runs before the load has folded this machine's own file in.
  The scan merges a peer's days into the ledger, and the load then adds the local
  file on top: a day both files hold would be counted twice and written back, and
  neither the next max merge nor a replay can tell the extra copy from real calls.
  A `refresh()` that arrives during the load is remembered and replayed once the
  load finishes.

The replay runs before `pruneIfNeeded`: pruning first only resurrects the days
the replay then re-adds. One discovery pass feeds both the deduped replay and the
repair, newest transcripts first, and the count that did not fit the cap is
reported rather than dropped in silence.

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

Every hue is measured, not eyeballed: `model-colors.ts` walks a five-rung shade
ladder per slot and bisects toward a target relative luminance, so each color
clears **3:1 against white and against the lightest plausible dark surface**
(`#202124`, the worst case — the card's own `#16171a` is darker, and a lighter
card surface would have pushed the dark end below 3:1). The rungs are ordered so
two names in one slot stay distinguishable: the smallest RGB distance inside a
slot is 21, where the old fixed pair reached 1.36.

The **plan bar** is two classes, not one: `.barFill` carries the geometry
(`height: 100%`) and the tone class (`.barWarn` ≥70 %, `.barLow` ≥90 %) only
carries its background. The tone used to be the fill's only class, and neither
tone rule sets a height — so the bar collapsed to zero pixels exactly in the
bands where the plan is nearly spent. Both tones are measured against the five
surfaces the card paints on, track included: `#b86e00` and `#e5484d` clear 3:1
where the stock `#d97706`/`#dc2626` pair fell to 2.64:1 and 2.78:1.

The **window strip folds on the card's own width**, not the viewport's: the range
card is an `inline-size` container and `@container (max-width: 420px)` drops the
eight tiles to two columns, so a narrow sidebar panel folds even on a wide
screen.

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

## Failure honesty

A panel that reports numbers has to be honest about the ones it could not get.
The rules, all of them visible in the UI rather than in the console:

- A **failed day** keeps its bar slot but is drawn as a hatch with a dashed
  outline (`.trendBar[data-failed='true']`) and says so on hover — before this,
  the attribute was set and no rule read it, so a lost day looked like a day
  with no usage.
- A **failed aggregate** (the range path) marks every fallback row `failed`,
  labels the chart as a failure with no total, and never claims "no records"
  for days it simply could not fetch.
- A **transport error** is stated in the user's language
  (`usage.error.status`, "请求失败（HTTP {status}）…"), with the raw text — which
  contains internal routes — kept in `title` instead of the sentence.
- **Retries** back off on growing rungs — `pollIntervalMs * 2^n`, capped at 120 s
  (10 s, 20 s, 40 s, 80 s, 120 s at the default cadence) — and stop after
  `RETRY_MAX_ATTEMPTS = 5`; while retrying, tiles keep their last settled value
  and the window ends at "—" rather than spinning forever.
- A **window with nothing to fetch** (a ledger that only holds today, so 全部
  spans today alone) reports its total instead of an idle spinner.
- A **partly loaded window** says so in the chart's accessible name
  (`usage.trend.labelPartial`) instead of calling the sum of the days that
  arrived "in total" — the tile beside it shows "—" for exactly that reason, and
  the channel breakdown is withheld: a share of a partial sum is a number nothing
  measured.
- A **failed range refetch keeps its answer**: the failure replaces the status,
  not the summary and series, so the totals row and the bars stay on screen next
  to the failure line (the card renders the stale branch rather than falling back
  to the failure-only one).
- The **retry ladder is walked, not starved**: the timer effect deliberately does
  not depend on `snapshot.updatedAt`. The host stamps every overview with the
  current time, so a dependency on it re-armed the first rung on every poll and
  the count never rose. The budget refill is a separate effect keyed on the
  ledger's own history stamp (`dayCount:allTotal − todayTotal`): a peer import or
  a backfill moved the history, so the failed request is no longer the request the
  panel would send and the ladder restarts; a poll that brought nothing new does
  not.
- The **export button names what it is doing** ("正在生成…" / "Rendering…") and is
  disabled while the canvas encodes, so a second click cannot queue a second
  download.
- The **day picker lists only days this machine recorded** (`availableDays` is
  read from the local ledger, not the merged one): a peer-only day would open an
  empty tile.
- **Importing this device's own export** is answered in the panel's own words
  (`usage.device.importSame`) instead of the host's English refusal, and the
  device card's **Rescan** posts to `/refresh` — the route that actually rescans
  the persist directory — rather than re-reading an overview that returns the
  ledger the process already holds. The refreshed overview that `/refresh`
  answers with is applied to the shared store here, with a sequence bump that
  retires a poll already in flight; the card no longer asks the section to
  refetch, which scanned the directory twice and could put the older answer on
  screen last.
- The **date bounds** of 自定义 and 全部 come from the *merged* ledger
  (`usage.all.from`), not from the days this machine recorded: after a peer's
  older history is adopted, a floor taken from `availableDays` would ask for a
  span narrower than the totals above it.
- The **role="img"** label describes the plot only: the x labels and the legend
  are siblings of the image role, so screen readers hear a description of the
  bars and can still read the legend.

Colours stay a pure function of the model name: `assignModelColors` picks
`slot = hash % 16` and then a shade from a second axis
(`floor(hash / 16) % 71`), mixing the palette colour toward white or black. Two
names in one slot therefore differ in shade unless both axes coincide; the
alternative — probing for a free slot — made a model's colour depend on which
models happened to be present, which is exactly what made a tile switch
repaint the whole chart.

The three tabs are a real tablist: each tab carries `id`/`aria-controls`, only
the selected one is in the tab order, arrow keys/Home/End move focus and
selection together, and each panel is a `role="tabpanel"` labelled by its tab.

## Verification

- `node harness/render-test.mjs` — jsdom, real bundle, saved live fixtures,
  **187/187 checks**: eight tiles with correct labels/values/`aria-pressed`
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
  denominator), a ledger read failure stated above the numbers, a failed poll
  that keeps the panel and marks it stale (with the wire's `ECONNREFUSED`
  replaced by a localized sentence), a window whose days did not arrive
  stating no total at all (and printing no totals row either), three equal
  models in one channel whose rows add up to exactly 100 %, a typed future
  custom date clamped back to today, and a refresh that refetches days it had
  cached. Round-6 additions: the failed-day hatch exists in the stylesheet and
  paints on the bar, a failed aggregate states no total in its aria label, a
  transport error is localized while the raw text stays in `title`, a retry
  keeps the previous total and gives up after five attempts, a today-only
  ledger sends no range request, the tablist keyboard contract (ArrowRight,
  Home, End), the from-date `min`, and the legend readable outside the image
  role. Rounds 7–9 add: a cached day re-read when the ledger moves, a retry chain
  that a no-op snapshot does not rewind, a canvas that cannot draw stating the
  voucher failure and a successful redraw clearing it, the poll-interval field
  committing only on blur or Enter (30–3600, an emptied field reverting), a
  model shade independent of arrival order, every slot reaching all five shades,
  a window missing a day printing `—` instead of a partial total, a calls cell
  that names its unit, export failures told apart from import failures, the
  sidebar card translated with the wire text in `title` and its figures no
  longer behind an `aria-label`, and the collapse toggle measured 24×24 at
  opacity 0.72. Rounds 10–11 add: a retry ladder that walks growing rungs and
  stops at its cap (a newer overview stamp does not reopen it, a moved ledger
  history does), a plan bar that keeps its fill geometry in the warn and low
  bands and a fill class that is the one carrying the height, both tone colours
  clearing 3:1 on every card surface, a partly loaded window claiming no channel
  shares, a failed range refetch keeping its numbers and series while still
  saying it failed, 全部 and the from-date input reaching back to the merged
  ledger's oldest day, the plan and device failures stated in the reader's
  language with the wire text in `title`, a throwing voucher save that cannot
  wedge the button, a truncated tile label keeping its full text in `title`, a
  range strip folded by the card's own width (no viewport query), a rescan that
  is one round trip (one host call, no follow-up refresh), a one-day window
  saying it has too few days for a trend, and the dead dictionary keys gone.
  Round 12 adds: the raw ledger and device read errors reachable by keyboard and
  screen readers (`aria-describedby` onto a hidden description, since `title` is
  mouse-only) while the visible sentence stays the only text in the status line,
  a range cache bounded to the six most recent spans, a null voucher blob stated
  as a save failure instead of vanishing, and a rescan that cannot overwrite a
  newer poll's snapshot. Round 13 adds: control ids minted per card (`useId`) so
  two cards on one page no longer hand the same id to two selects or two
  tabpanels, the day picker's label pointing at its own select, the trend chart
  exposed to assistive tech as one group (one label instead of dozens of stray
  `img` nodes), a hidden tab that does not paint its canvas, a plan sub-bar whose
  printed share matches its width, and the copy button describing what it copies.
- `node --experimental-strip-types harness/host-test.mjs` — 226 checks: range
  aggregate + per-model series, route guards, device ledger, loopback fence,
  peak clock, the record-carried route of the live fold, transcript dedupe and
  the judged repair, ledger quarantine and unreadable-file protection, the
  delta merge between two processes, the pinned machine id (a renamed host is
  the same machine), a peer document without a machine id being refused, the
  retention guard telling a clock jump from a lowered `retainDays` (and keeping
  the refused window across a restart), the note registry not growing per poll,
  legacy history being restored after a quarantine, a repair written under the
  flush lock and retried when it cannot be, an unreadable ledger moved aside once
  the load budget is spent, the durable machine-alias record in
  `device-ledger.json`, an unverified peer contributing only days this machine
  never recorded, a trend window reported as a named failure instead of a range
  error, a retention note surviving the first flush, a second migration keeping
  the days the first one retired, an import keeping the machine id the peer file
  already had, quarantine files capped at three, and a `refresh()` during the
  load not double counting a peer. Round 12 adds: a shrink that would wipe the
  ledger refused exactly like a jumped clock (and the refusal note retired once a
  prune really lands), the two migration halves max-merged instead of summed (a
  shared day counted once, however often the path re-runs), an import keeping the
  window the peer file recorded rather than relabelling it with this machine's,
  and the `lock-busy` note retired only by a write that actually held the lock.
  Round 13 adds: a load retry that no longer rolls the ledger back over calls
  folded while it waited, a bucket the repair cannot finish being reported instead
  of passed over in silence, an unverified peer losing only the buckets it shares
  with a day this machine recorded (not the whole day), quarantine copies keeping
  the newest file (the one the error message names), the retention note no longer
  blaming the clock for a shrink the user asked for, `availableDays` covering
  every day the totals count (peer-only days included), a BOM-prefixed export
  importing, the stale-writer note naming the calls it did not re-adopt, and a
  write that gave up on the lock standing down instead of writing anyway.
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
- A window wider than `TREND_MAX_DAYS` (731) draws its most recent 731 days: the
  key walk starts at the window's end, so a decade-long custom range keeps the
  days near today instead of the oldest 731.
- The trend chart is drawn on a canvas with `role="img"` and an `aria-label`;
  the three tabpanels are mounted and toggled with `hidden`, each button naming
  its panel through `aria-controls`, so a screen reader announces both the tabs
  and the panel they switch.
