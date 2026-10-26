/**
 * The usage statistics settings section: three tabs (用量: one time window
 * picked from 今日 / 昨日 / 近 3 天 / 近 7 天 / 近 30 天 / 近 6 个月 / 近 1 年 /
 * 自定义, rendered as window totals plus the per-channel and per-model
 * breakdown and the trend chart, with balances below; 个人套餐: per-provider
 * plan quota windows; Token 银行: the whale-yuan voucher minted from the
 * DeepSeek official family's usage) plus a compact settings row.
 *
 * Data: today and the whole-ledger aggregates ride the host's loopback-fenced
 * /api/dsh-usage/overview document. A window at most RANGE_FETCH_MAX_DAYS
 * long is merged in the browser from one small `/api/dsh-usage/day` request
 * per day the ledger recorded inside the window (the overview lists those
 * days); a longer one reads a single `/api/dsh-usage/range` aggregate instead
 * — one request answering the whole-window summary plus the per-day series,
 * which is what makes the multi-month windows viable. Both paths stop at
 * yesterday and take today from the live overview, so a cached window can
 * never disagree with the poll. Merged days and fetched ranges are cached for
 * the session. Polling runs only while the section is mounted and the tab is
 * visible.
 * @module @linxin666/dsh-usage/client/UsageSectionCard
 */

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { UsageStoreInstance } from './usage-store.ts'
import { t } from './locales.ts'
import { describeError } from './error-text.ts'
import styles from './usage.module.css'
import { PeakBadge } from './PeakBadge.tsx'
import { TrendChart, type TrendRow } from './TrendChart.tsx'
import { assignModelColors, MODEL_COLOR_OTHER, normalizeModelName, normalizeModelRows } from './model-colors.ts'
import { isDeepSeekProviderRoute } from '../core/adapters.ts'
import { deepseekPeriodAt } from '../core/pricing.ts'
import { localDateKey } from '../core/ledger.ts'
import { voucherData, drawVoucher, faceValue, formatDay, formatDenomination, loadVoucherArt } from './voucher.ts'
import { DeviceSyncCard, type DeviceSyncApi } from './DeviceSyncCard.tsx'
import { addTotals, emptyTotals, type ObservedSpendView, type PlanWindowView, type ProviderSnapshotView, type UsageDayView, type UsageOverviewView, type UsageProviderSummary, type UsageRangeResponse, type UsageTokenTotals, type UsageWindowSummary } from '../core/types.ts'
import { formatTokens } from './format.ts'

// Re-exported for the foot card's imports; the implementation lives in
// ./format.ts so TrendChart shares it without a cycle back through this file.
export { formatTokens } from './format.ts'

/** The settings fields this section edits (immediate-apply semantics). */
export interface UsageSettings {
  enabled?: boolean
  pollIntervalSec?: number
}

/** The registration-side face the section's slot entry injects. */
export interface UsageSectionFace {
  /** The section-local store (overview snapshot + lifecycle). */
  store: UsageStoreInstance
  /** Fetch one overview now. */
  poll: () => void
  /** Force a host probe cycle now (resolves with the fresh overview). */
  refresh: () => void
  /**
   * Fetch one retained local day (YYYY-MM-DD) from the host. The overview
   * only carries today plus the list of recorded days, so a window that
   * reaches past today is one small on-demand request per recorded day.
   */
  loadDay: (date: string) => Promise<UsageDayView>
  /**
   * Fetch one window aggregate (from/to local-date keys) from the host:
   * whole-window totals, the per-provider per-model breakdown, and the
   * per-day series, in one request. Windows past RANGE_FETCH_MAX_DAYS read
   * this instead of one request per recorded day.
   */
  loadRange: (from: string, to: string) => Promise<UsageRangeResponse>
  /** The shared configuration form this section's settings row reads and writes. */
  settings: ConfigForm<UsageSettings>
  /** Manual cross-device ledger export/import (absent on an older host face). */
  deviceSync?: DeviceSyncApi
}

export interface UsageSectionProps extends UsageSectionFace {
  /** Close the settings panel (the shell owns the open state). */
  close: () => void
}

/** Poll cadence while the section is open. */
const SECTION_POLL_MS = 10_000

/**
 * The Token bank's default window: the whole retained ledger. It is a select
 * value rather than a date, so it can never collide with a day key.
 */
const BANK_ALL_DAYS = 'all'

/**
 * Longest span the render walk will enumerate (the host's own retention limit).
 * This is the only cap on a window: the picker clamps its ends to the recorded
 * days instead, so a pair can describe the whole ledger.
 */
const TREND_MAX_DAYS = 731

/**
 * The trend chart needs at least two columns to say anything: a single-day
 * window would paint one bar across the full width, which reads as a solid
 * block rather than a chart, so those windows keep the totals and breakdown.
 * Wider windows need no cap here — the chart buckets them per week/month.
 */
const TREND_CHART_MIN_DAYS = 2

/** Model rows kept per channel of a merged window (the host caps one day the same way). */
const WINDOW_MODEL_CAP = 12

/** Per-day requests one window may keep in flight. */
const DAY_FETCH_CONCURRENCY = 6

/**
 * Retries one failed day or window gets before the panel leaves it alone. A
 * dropped request is worth another try; an endpoint that keeps answering 500 is
 * not, and the refresh button stays the user's way to ask again.
 */
const RETRY_MAX_ATTEMPTS = 5

/** Ceiling of the retry backoff, so a dead endpoint never spins a fast timer. */
const RETRY_BACKOFF_MAX_MS = 60_000

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString()
  } catch {
    return ''
  }
}

/** Formatted CNY spend estimate (the only priced currency today). */
function formatCost(cost: number): string {
  return '¥' + cost.toFixed(2)
}

function toneClass(percent: number): string {
  if (percent >= 90) return styles.barLow
  if (percent >= 70) return styles.barWarn
  return styles.barFill
}

/** A provider row backed by a configured credential (api key, env key, or OAuth grant). */
function isConfigured(provider: ProviderSnapshotView): boolean {
  // An older wire document without the credential field renders as before.
  return provider.credential !== 'none'
}

/** Billed token count of a bucket (billed input = input + cache read + cache write). */
function totalOf(totals: UsageTokenTotals): number {
  return totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens
}

/** Whether a bucket holds nothing worth rendering. */
function isEmptyTotals(totals: UsageTokenTotals): boolean {
  return totals.calls === 0 && totalOf(totals) === 0
}

/** Local-date key `days` away from `key`; the empty key stays empty. */
function shiftDateKey(key: string, days: number): string {
  if (key === '') return ''
  const date = new Date(key + 'T12:00:00')
  date.setDate(date.getDate() + days)
  return localDateKey(date.getTime())
}

/**
 * Every local-date key from `from` to `to` inclusive; empty when inverted.
 *
 * The walk starts at `to` and goes back, so the cap drops the OLDEST days: a
 * window wider than TREND_MAX_DAYS must still show the days the user cares
 * about (the recent ones), not the first 731 days of a decade.
 */
function dateKeysBetween(from: string, to: string): string[] {
  const keys: string[] = []
  if (from === '' || to === '' || from > to) return keys
  let key = to
  while (key >= from && keys.length < TREND_MAX_DAYS) {
    keys.push(key)
    key = shiftDateKey(key, -1)
  }
  return keys.reverse()
}

/**
 * Whole percents that add up to 100: floor every exact share, then hand the
 * leftover units to the largest remainders. Rounding each row on its own made a
 * panel state 99 % or 102 %, which reads as a bug in the numbers.
 */
function roundShares(exact: readonly number[]): number[] {
  const whole = exact.map((value) => Math.floor(value))
  let left = 100 - whole.reduce((sum, value) => sum + value, 0)
  const byRest = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index)
  for (const entry of byRest) {
    if (left <= 0) break
    whole[entry.index] += 1
    left -= 1
  }
  return whole
}

/** Units for plan-window keys the dictionary does not name (`7_day`, `12_hour`). */
const PLAN_WINDOW_UNIT_KEYS: Record<string, string> = {
  hour: 'usage.plan.unit.hour',
  day: 'usage.plan.unit.day',
  week: 'usage.plan.unit.week',
  month: 'usage.plan.unit.month',
}

/**
 * The label of one plan window. Providers either name their windows or leave a
 * key behind (`5h`, `week`, `7_day`); the dictionary knows a handful of those,
 * and an unknown one used to be printed verbatim (`usage.plan.windows.7_day`).
 * A duration-shaped key is spelled out in the reader's language, anything else
 * falls back to a generic label instead of leaking an internal key.
 */
function planWindowLabel(window: PlanWindowView): string {
  if (window.name !== undefined && window.name !== '') return window.name
  const key = `usage.plan.windows.${window.key}`
  const known = t(key)
  if (known !== key) return known
  const duration = /^(\d+)_(hour|day|week|month)$/.exec(window.key)
  if (duration !== null) return `${duration[1]} ${t(PLAN_WINDOW_UNIT_KEYS[duration[2]])}`
  return t('usage.plan.windows.other')
}

/** One selectable time window, as local-date keys. */
interface RangeWindow {
  from: string
  to: string
}

/** The fixed windows the section offers, plus the user-picked custom range.
 *  Windows at most 45 days long read per-day views; longer ones fetch a
 *  single window aggregate from the host (see RANGE_FETCH_MAX_DAYS). */
type RangeKey = 'today' | 'yesterday' | 'last3' | 'last7' | 'last30' | 'last180' | 'all' | 'custom'

/** Locale key of each window's label. */
const RANGE_LABEL_KEYS: Record<RangeKey, string> = {
  today: 'usage.range.today',
  yesterday: 'usage.range.yesterday',
  last3: 'usage.range.last3',
  last7: 'usage.range.last7',
  last30: 'usage.range.last30',
  last180: 'usage.range.last180',
  all: 'usage.range.all',
  custom: 'usage.range.custom',
}

/**
 * Longest window the per-day fetch path serves. Past it the section switches to
 * the host's range aggregate: one request instead of up to a few hundred.
 */
const RANGE_FETCH_MAX_DAYS = 45

/**
 * What the ledger's past looked like when a cached answer was fetched: the
 * number of retained days plus every recorded token that is not today's.
 *
 * Both caches are keyed by a date or a span, and a poll changes neither. A
 * backfill, a peer import or a late write into a past day therefore left the
 * cached answer in place forever — a wide window kept showing its old total
 * while 全部 (whose span starts at the new oldest day) refetched and grew, so
 * the panel could report 近 6 个月 as less than 全部. Folding this stamp into the
 * entry makes a cached answer self-invalidating when the history behind it moved,
 * and today is subtracted so a live day that grows with every request cannot
 * invalidate it on every poll.
 */
function historyStampOf(usage: UsageOverviewView['usage']): string {
  const recorded = usage.availableDays?.length ?? usage.days.length
  const whole = usage.all === undefined
    ? usage.days.reduce((sum, row) => sum + totalOf(row.totals), 0)
    : totalOf(usage.all.totals)
  return `${recorded}:${whole - totalOf(usage.today.totals)}`
}

/**
 * A picked day key, held inside the calendar's own bounds. The picker's `min`
 * and `max` bind its calendar, not a typed or pasted value, so without this a
 * window could run into the future and fold today's usage into days that have
 * not happened. A start *before* the oldest retained day is left alone: the
 * picker's `min` already keeps it out of the calendar, and a window that opens
 * earlier than the ledger is a legitimate question — the chart draws the stretch
 * the host has nothing for, rather than silently rewriting the dates the user
 * typed. An empty value is the picker clearing the end.
 */
function clampDay(value: string | undefined, today: string): string | undefined {
  if (value === undefined || value === '') return value
  if (today !== '' && value > today) return today
  return value
}

/** Session cache of fetched day views: a past day does not change within one.
 * Refreshing the panel clears it, because a late backfill can still land. */
type DayCache = Map<string, { view: UsageDayView; stamp: string }>

/**
 * Cache generation. A manual refresh bumps it, so a request that started
 * before the refresh can neither be joined by a later reader nor write its
 * now-stale answer back into a cache.
 */
let cacheGeneration = 0

/**
 * In-flight day requests, so two windows overlapping on one day (or React's
 * development double-mount) share one request instead of racing. Each entry
 * carries the generation it was started in.
 */
const dayRequests = new Map<string, { promise: Promise<UsageDayView>; generation: number; stamp: string }>()

function requestDay(loadDay: (date: string) => Promise<UsageDayView>, date: string, cache: DayCache, stamp: string): Promise<UsageDayView> {
  const pending = dayRequests.get(date)
  if (pending !== undefined && pending.generation === cacheGeneration && pending.stamp === stamp) return pending.promise
  const generation = cacheGeneration
  const request = loadDay(date).then(
    (view) => {
      if (dayRequests.get(date)?.generation === generation) dayRequests.delete(date)
      // Refreshed mid-flight: this answer describes the state before the
      // refresh, so it must not seed the cache the next window reads.
      if (generation === cacheGeneration) cache.set(date, { view, stamp })
      return view
    },
    (error: unknown) => {
      if (dayRequests.get(date)?.generation === generation) dayRequests.delete(date)
      throw error
    },
  )
  dayRequests.set(date, { promise: request, generation, stamp })
  return request
}

/** Run `run` over every item with at most `limit` in flight. */
async function mapPool<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      await run(item)
    }
  })
  await Promise.all(workers)
}

/** How the per-day fetches behind one window are going. */
interface WindowDays {
  status: 'loading' | 'ready'
  /** Fetched day views keyed by date; a day the host recorded nothing for is absent. */
  days: Record<string, UsageDayView>
  /**
   * Days whose fetch failed. Kept apart from "absent" on purpose: an empty day
   * is a fact about the ledger, a failed day is a fact about the request, and
   * painting the second as "no usage recorded" is a lie the panel cannot undo.
   */
  failedDates: string[]
  /** First transport error, when a day failed; the window still renders what loaded. */
  error?: string
}

/**
 * Fetch the day views a window needs. Keys exclude today (it rides the live
 * overview), cached days resolve immediately, and a superseded window never
 * lands because the effect cancels. A partially failed load still renders the
 * days that arrived, plus the error line.
 */
function useWindowDays(
  loadDay: (date: string) => Promise<UsageDayView>,
  dateKeys: string[],
  cache: DayCache,
  epoch: number,
  retry: number,
  stamp: string,
): WindowDays {
  const signature = dateKeys.join(',')
  const [load, setLoad] = useState<WindowDays>(() => ({ status: dateKeys.length === 0 ? 'ready' : 'loading', days: {}, failedDates: [] }))
  useEffect(() => {
    const wanted = signature === '' ? [] : signature.split(',')
    const days: Record<string, UsageDayView> = {}
    const failedDates: string[] = []
    const missing: string[] = []
    for (const date of wanted) {
      // A cached day is only good for the history it was read from: the same
      // date re-served after a backfill is a different day.
      const cached = cache.get(date)
      if (cached === undefined || cached.stamp !== stamp) missing.push(date)
      else days[date] = cached.view
    }
    if (missing.length === 0) {
      setLoad({ status: 'ready', days, failedDates })
      return undefined
    }
    let cancelled = false
    // The first load starts from "…"; a retry keeps whatever the last attempt
    // settled on. Flipping back to the loading state on every attempt made a
    // flaky request look like the panel had lost its data.
    setLoad((previous) => (previous.status === 'ready' ? previous : { status: 'loading', days, failedDates }))
    let failed = 0
    let firstError: string | undefined
    void mapPool(missing, DAY_FETCH_CONCURRENCY, async (date) => {
      try {
        days[date] = await requestDay(loadDay, date, cache, stamp)
        // Publish each day as it lands: a window whose own dates are all here
        // can show its total while a slower day elsewhere in the shared load is
        // still in flight (a stuck day would otherwise hold every tile at "…").
        // A retry keeps the settled status and the previous failure line, so the
        // card does not flicker between "failed" and "loading" either.
        if (!cancelled) {
          setLoad((previous) => ({
            status: previous.status === 'ready' ? 'ready' : 'loading',
            days: { ...days },
            failedDates: [...failedDates],
            ...(previous.status === 'ready' && previous.error !== undefined ? { error: previous.error } : {}),
          }))
        }
      } catch (error) {
        failed += 1
        failedDates.push(date)
        firstError ??= error instanceof Error ? error.message : String(error)
      }
    }).then(() => {
      if (cancelled) return
      setLoad({ status: 'ready', days, failedDates, ...(failed > 0 ? { error: firstError ?? '' } : {}) })
    })
    return () => { cancelled = true }
  // `signature` carries the key list; `epoch` invalidates the cache; `retry`
  // lets the poll tick retry a day that failed without a manual refresh; `stamp`
  // re-reads a cached day whose history moved under it.
  }, [signature, loadDay, cache, epoch, retry, stamp])
  return load
}

/** One fetched window aggregate, minus the wire envelope's identity fields. */
interface RangeResult {
  summary: { totals: UsageTokenTotals; providers: UsageProviderSummary[] }
  series: Array<{ date: string; totals: UsageTokenTotals; models?: Record<string, UsageTokenTotals> }>
  /** The history the aggregate was read from; a mismatch means the span needs a refetch. */
  stamp: string
}

/**
 * Session cache of fetched range aggregates, keyed `from:to`. Same lifetime
 * reasoning as the day cache: refreshing clears it because a late backfill or
 * peer import can still change a past window.
 */
const rangeResults = new Map<string, RangeResult>()

/** In-flight range requests, so overlapping windows share one fetch. */
const rangeRequests = new Map<string, { promise: Promise<UsageRangeResponse>; generation: number; stamp: string }>()

function requestRange(loadRange: (from: string, to: string) => Promise<UsageRangeResponse>, from: string, to: string, stamp: string): Promise<UsageRangeResponse> {
  const key = `${from}:${to}`
  const pending = rangeRequests.get(key)
  if (pending !== undefined && pending.generation === cacheGeneration && pending.stamp === stamp) return pending.promise
  const generation = cacheGeneration
  const request = loadRange(from, to).then(
    (response) => {
      if (rangeRequests.get(key)?.generation === generation) rangeRequests.delete(key)
      if (generation === cacheGeneration) {
        rangeResults.set(key, { summary: { totals: response.totals, providers: response.providers }, series: response.series, stamp })
      }
      return response
    },
    (error: unknown) => {
      if (rangeRequests.get(key)?.generation === generation) rangeRequests.delete(key)
      throw error
    },
  )
  rangeRequests.set(key, { promise: request, generation, stamp })
  return request
}

/**
 * Drop every cached read and detach the in-flight ones.
 *
 * Called by a manual refresh: keeping an in-flight request would hand the
 * refreshed windows the very answer the user asked to replace, and its settle
 * handler would then cache that answer over the fresh one.
 */
function clearUsageCaches(): void {
  cacheGeneration += 1
  dayRequests.clear()
  rangeRequests.clear()
  rangeResults.clear()
}

/** How one window's range aggregate fetch is going. */
interface RangeLoad {
  status: 'idle' | 'loading' | 'ready' | 'error'
  summary?: { totals: UsageTokenTotals; providers: UsageProviderSummary[] }
  series?: Array<{ date: string; totals: UsageTokenTotals; models?: Record<string, UsageTokenTotals> }>
  /** Transport error message, on a failed load. */
  error?: string
}

/**
 * Fetch one window's aggregate. An absent window stays idle (the untouched
 * custom range fetches nothing), a cached range resolves immediately, and a
 * superseded window never lands because the effect cancels. `epoch`
 * invalidates the cache the same way the day cache's does.
 *
 * A window that exists but has nothing to fetch — one whose whole span is
 * today, so `fetchSpanOf` returns nothing — is a loaded window, not a pending
 * one, and resolves to an empty ready series. Staying idle left the 全部 tile
 * at "…" forever on a ledger whose oldest day is today: the tile treats idle as
 * pending, and nothing was ever going to move it.
 */
function useRangeData(
  loadRange: (from: string, to: string) => Promise<UsageRangeResponse>,
  window: RangeWindow | undefined,
  today: string,
  epoch: number,
  retry: number,
  stamp: string,
): RangeLoad {
  // Keyed by the span actually fetched, not by the window: a window ending today
  // stops at yesterday, so today never freezes into a cached aggregate.
  const span = window === undefined ? undefined : fetchSpanOf(window, today)
  const empty = window !== undefined && span === undefined
  const key = span === undefined ? '' : `${span.from}:${span.to}`
  const [load, setLoad] = useState<RangeLoad>({ status: 'idle' })
  useEffect(() => {
    if (empty) {
      setLoad((previous) => (previous.status === 'ready' && previous.series?.length === 0 ? previous : { status: 'ready', series: [] }))
      return undefined
    }
    if (key === '') {
      setLoad((previous) => (previous.status === 'idle' ? previous : { status: 'idle' }))
      return undefined
    }
    // A cached aggregate only answers for the history it was read from: the span
    // key does not move when a past day is backfilled, so a stamp mismatch has to
    // drop it or a wide window stays on its old total forever.
    const cached = rangeResults.get(key)
    if (cached !== undefined && cached.stamp === stamp) {
      setLoad({ status: 'ready', summary: cached.summary, series: cached.series })
      return undefined
    }
    let cancelled = false
    // A retry keeps the previous answer — and its failure line — on screen: the
    // tile shows "—" while a window is failed, and flipping to "…" on every
    // attempt made a flaky request look like the panel had lost its data.
    setLoad((previous) => (previous.status === 'ready' || previous.status === 'error' ? previous : { status: 'loading' }))
    requestRange(loadRange, key.slice(0, 10), key.slice(11), stamp).then(
      (response) => {
        if (cancelled) return
        const stored = rangeResults.get(key)
        setLoad({
          status: 'ready',
          summary: stored !== undefined && stored.stamp === stamp ? stored.summary : { totals: response.totals, providers: response.providers },
          series: response.series,
        })
      },
      (error: unknown) => {
        if (!cancelled) setLoad({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => { cancelled = true }
  // `key` carries the fetched span; `empty` the window with nothing to fetch;
  // `epoch` invalidates the cache; `retry` lets the poll tick retry a window
  // that failed without a manual refresh; `stamp` re-reads a cached aggregate
  // whose history moved under it.
  }, [key, empty, loadRange, epoch, retry, stamp])
  return load
}

/** How one window's detail is served: per-day views merged in the browser, or one host-side range aggregate. */
type WindowSlice =
  | { window: RangeWindow; kind: 'days'; load: WindowDays }
  | { window: RangeWindow; kind: 'range'; load: RangeLoad }

/**
 * Merge per-day views into one window summary: disjoint bucket sums per
 * provider, per-model rows heaviest first, providers heaviest first. Mirrors
 * the host's own `summarizeDays`, so a window and a single day agree.
 */
function summarizeViews(views: readonly UsageDayView[]): { totals: UsageTokenTotals; providers: UsageProviderSummary[] } {
  const totals = emptyTotals()
  const merged = new Map<string, { totals: UsageTokenTotals; models: Map<string, UsageTokenTotals> }>()
  for (const view of views) {
    addTotals(totals, view.totals)
    for (const row of view.providers) {
      let entry = merged.get(row.provider)
      if (entry === undefined) {
        entry = { totals: emptyTotals(), models: new Map() }
        merged.set(row.provider, entry)
      }
      addTotals(entry.totals, row.totals)
      for (const model of row.models) {
        const bucket = entry.models.get(model.model) ?? emptyTotals()
        addTotals(bucket, model.totals)
        entry.models.set(model.model, bucket)
      }
    }
  }
  const providers: UsageProviderSummary[] = []
  for (const [provider, entry] of merged) {
    const models = [...entry.models]
      .map(([model, modelTotals]) => ({ model, totals: modelTotals }))
      .sort((a, b) => totalOf(b.totals) - totalOf(a.totals))
      .slice(0, WINDOW_MODEL_CAP)
    providers.push({ provider, totals: entry.totals, models })
  }
  providers.sort((a, b) => totalOf(b.totals) - totalOf(a.totals))
  return { totals, providers }
}

/** Whether `date` falls inside a window (both bounds are local-date keys). */
function inWindow(window: RangeWindow, date: string): boolean {
  return window.from !== '' && date >= window.from && date <= window.to
}

/**
 * One day's per-model totals aggregated across providers — the trend bars'
 * stack input. Provider rows arrive heaviest-first with their models capped,
 * which is the same view the breakdown renders.
 */
function modelSplitOf(view: UsageDayView): Record<string, UsageTokenTotals> {
  const models: Record<string, UsageTokenTotals> = {}
  for (const row of view.providers) {
    for (const model of row.models) {
      const bucket = models[model.model] ?? emptyTotals()
      addTotals(bucket, model.totals)
      models[model.model] = bucket
    }
  }
  return models
}

/**
 * Merge a per-model split onto normalized names (see model-colors) so the
 * same model under different spellings or `provider/` routes stacks as one
 * segment instead of slivering the bar with near-identical hues.
 */
function normalizedSplit(split: Record<string, UsageTokenTotals>): Record<string, UsageTokenTotals> {
  const models: Record<string, UsageTokenTotals> = {}
  for (const [model, totals] of Object.entries(split)) {
    const key = normalizeModelName(model)
    const bucket = models[key] ?? emptyTotals()
    addTotals(bucket, totals)
    models[key] = bucket
  }
  return models
}

/**
 * The same fold for a window summary's provider rows: model entries merge by
 * normalized name, re-rank by size and re-apply the per-provider cap, so the
 * breakdown bars and model rows read the merged view.
 */
function normalizedProviders(providers: readonly UsageProviderSummary[]): UsageProviderSummary[] {
  return providers.map((row) => {
    const models = new Map<string, UsageTokenTotals>()
    for (const model of row.models) {
      const key = normalizeModelName(model.model)
      const bucket = models.get(key) ?? emptyTotals()
      addTotals(bucket, model.totals)
      models.set(key, bucket)
    }
    return {
      provider: row.provider,
      totals: row.totals,
      models: [...models]
        .map(([model, totals]) => ({ model, totals }))
        .sort((a, b) => totalOf(b.totals) - totalOf(a.totals))
        .slice(0, WINDOW_MODEL_CAP),
    }
  })
}

/**
 * The span a range-kind window actually fetches.
 *
 * Today is never fetched: the overview already carries it live, so the
 * aggregate stops at yesterday — the same split the per-day path uses. Fetching
 * today would freeze the whole window at the moment of the request (the fetch
 * is cached for the session), which is how 近 6 个月 could read BELOW 近 30 天:
 * the multi-month tiles held a stale copy of today while the short windows kept
 * counting with the poll. A window holding nothing but today has no fetch at
 * all; the live day is everything it renders.
 */
function fetchSpanOf(window: RangeWindow, today: string): RangeWindow | undefined {
  if (window.from === '' || window.to === '') return undefined
  const to = window.to >= today ? shiftDateKey(today, -1) : window.to
  return to < window.from ? undefined : { from: window.from, to }
}

/**
 * Fold the live overview day into a fetched window aggregate.
 *
 * The range route is asked for a span that ends yesterday (see `fetchSpanOf`),
 * so a multi-month window has to add today itself to state the whole window.
 * Doing it here — not in the host — keeps the tile exact as the day goes on and
 * keeps one live source of truth for today across every window.
 */
function withLiveToday(summary: UsageWindowSummary, window: RangeWindow, todayView: UsageDayView | undefined): UsageWindowSummary {
  if (todayView === undefined || !inWindow(window, todayView.date)) return summary
  // `summarizeViews` is the one merge: it re-sums totals, folds providers and
  // their models, then re-ranks and re-caps them for the breakdown.
  return { from: summary.from, to: summary.to, ...summarizeViews([{ date: todayView.date, totals: summary.totals, providers: summary.providers }, todayView]) }
}

/** The day views one window holds, including the live overview day. */
function viewsIn(window: RangeWindow, dateKeys: readonly string[], load: WindowDays, todayView: UsageDayView | undefined): UsageDayView[] {
  const views: UsageDayView[] = []
  for (const date of dateKeys) {
    if (!inWindow(window, date)) continue
    const view = load.days[date]
    if (view !== undefined) views.push(view)
  }
  // Today never comes from a fetch: the overview already carries it live, so a
  // window ending today keeps counting with the poll.
  if (todayView !== undefined && inWindow(window, todayView.date)) views.push(todayView)
  return views
}

/** Whole-window summary, including the per-channel per-model breakdown. */
function summaryIn(window: RangeWindow, dateKeys: readonly string[], load: WindowDays, todayView: UsageDayView | undefined): UsageWindowSummary {
  return { from: window.from, to: window.to, ...summarizeViews(viewsIn(window, dateKeys, load, todayView)) }
}

/** Whole-window totals only (the tiles need no breakdown). */
function totalsIn(window: RangeWindow, dateKeys: readonly string[], load: WindowDays, todayView: UsageDayView | undefined): UsageTokenTotals {
  const totals = emptyTotals()
  for (const view of viewsIn(window, dateKeys, load, todayView)) addTotals(totals, view.totals)
  return totals
}

/** The recorded days of `recorded` that fall inside a window, today excluded. */
function recordedIn(window: RangeWindow, recorded: readonly string[], today: string): string[] {
  if (window.from === '' || window.to === '' || window.from > window.to) return []
  return recorded.filter((date) => date >= window.from && date <= window.to && date !== today)
}

/**
 * The window's six stat cells. `partial` marks a window whose days have not all
 * arrived yet: the sum over the days that did is a number nothing measured, so
 * the row states an em dash — the same "—" the range tile above shows for the
 * same window, so the two never disagree.
 */
function TotalsRow(props: { totals: UsageTokenTotals; partial?: boolean }): ReactNode {
  const { totals, partial = false } = props
  // Cache-hit share: of everything billed as input, the part served from
  // cache. Nothing billed yet reads as an em dash rather than a bogus 0%.
  const billedInput = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  const cacheHit = billedInput === 0 ? undefined : (totals.cacheReadTokens / billedInput) * 100
  if (partial) {
    return (
      <div className={styles.statRow} data-dsh-part="window-totals" data-partial="true">
        <span className={styles.muted}>—</span>
      </div>
    )
  }
  return (
    <div className={styles.statRow} data-dsh-part="window-totals">
      <div className={styles.stat}>
        <span className={styles.statValue}>{formatTokens(totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens)}</span>
        <span className={styles.statLabel}>{t('usage.tokens.total')}</span>
      </div>
      <div className={styles.stat}>
        <span className={styles.statValue}>{formatTokens(totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens)}</span>
        <span className={styles.statLabel}>{t('usage.tokens.input')}</span>
      </div>
      <div className={styles.stat}>
        <span className={styles.statValue}>{formatTokens(totals.outputTokens)}</span>
        <span className={styles.statLabel}>{t('usage.tokens.output')}</span>
      </div>
      <div className={styles.stat}>
        <span className={styles.statValue}>{formatTokens(totals.cacheReadTokens)}</span>
        <span className={styles.statLabel}>{t('usage.tokens.cacheRead')}</span>
      </div>
      <div className={styles.stat}>
        <span className={styles.statValue}>{cacheHit === undefined ? '—' : cacheHit.toFixed(1) + '%'}</span>
        <span className={styles.statLabel}>{t('usage.tokens.cacheHit')}</span>
      </div>
      <div className={styles.stat}>
        <span className={styles.statValue}>{formatTokens(totals.calls)}</span>
        {/* The value above already states the count; the label names the unit. */}
        <span className={styles.statLabel}>{t('usage.callsLabel')}</span>
      </div>
    </div>
  )
}

function balanceLine(provider: ProviderSnapshotView): ReactNode {
  if (provider.balance !== undefined) {
    return <span className={styles.providerBalance}>{provider.balance.currency.toUpperCase() === 'CNY' ? '¥' : provider.balance.currency.toUpperCase() === 'USD' ? '$' : ''}{provider.balance.totalBalance}{provider.balance.currency.toUpperCase() !== 'CNY' && provider.balance.currency.toUpperCase() !== 'USD' ? ' ' + provider.balance.currency.toUpperCase() : ''}</span>
  }
  if (provider.credential === 'oauth') return <span className={styles.muted}>{t('usage.oauth')}</span>
  if (provider.credential === 'none') return <span className={styles.muted}>{t('usage.balance.noCredential')}</span>
  // balanceSupported === false is the origin gate: the adapter has a balance
  // endpoint but it belongs to another provider's account (issue #1688), so
  // the row says so instead of silently vanishing from the card.
  if (provider.balanceSupported === false) return <span className={styles.muted}>{t('usage.balance.unsupported')}</span>
  if (!provider.supported) return <span className={styles.muted}>{t('usage.balance.unsupported')}</span>
  return null
}

function ProviderRow(props: { provider: ProviderSnapshotView; current?: string }): ReactNode {
  const { provider, current } = props
  return (
    <div className={styles.providerRow} data-dsh-part="provider-row">
      <span className={styles.providerName}>
        {provider.displayName}
        {current === provider.provider && <span className={styles.currentBadge}>{t('usage.current')}</span>}
      </span>
      <span className={styles.providerTokens}>{balanceLine(provider)}</span>
    </div>
  )
}

/** One day the pickers selected, as its fetch progresses. */
interface DayLoad {
  status: 'loading' | 'ready' | 'error'
  /** The served day, once the host answered. */
  view?: UsageDayView
  /** Transport error message, on a failed load. */
  error?: string
}

/**
 * Fetch the day a picker selected, or stay idle for the default window. Today
 * never fetches: the overview already carries it live, so switching back to
 * today is instant and keeps counting with the poll. A superseded selection
 * never lands (the effect cancels), and a failed load reports its own message
 * instead of leaving the card on a stale day.
 *
 * The fetch goes through `requestDay`, not `loadDay`, so picking a day the
 * window already loaded costs nothing; `retry` is in the deps so the poll tick
 * retries a day that failed, instead of leaving the error up until the user
 * picks something else and comes back.
 */
function useDayView(
  loadDay: (date: string) => Promise<UsageDayView>,
  date: string | undefined,
  today: string | undefined,
  cache: DayCache,
  epoch: number,
  retry: number,
  stamp: string,
): DayLoad | undefined {
  const [load, setLoad] = useState<DayLoad | undefined>(undefined)
  useEffect(() => {
    if (date === undefined || date === today) {
      setLoad((previous) => (previous === undefined ? previous : undefined))
      return undefined
    }
    const cached = cache.get(date)
    if (cached !== undefined && cached.stamp === stamp) {
      setLoad({ status: 'ready', view: cached.view })
      return undefined
    }
    let cancelled = false
    setLoad({ status: 'loading' })
    requestDay(loadDay, date, cache, stamp).then(
      (view) => { if (!cancelled) setLoad({ status: 'ready', view }) },
      (error: unknown) => { if (!cancelled) setLoad({ status: 'error', error: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { cancelled = true }
  // `epoch` is in the deps so a manual refresh re-reads the selected day too: the
  // window prefetch has already refetched it, and a ticket left on the pre-refresh
  // number is a stale receipt for a day the panel no longer believes. `stamp`
  // does the same for a backfilled day the poll noticed.
  }, [date, today, loadDay, cache, epoch, retry, stamp])
  return load
}

/**
 * The day picker: today plus every retained day that recorded usage, newest
 * first (the host serves the list ascending). Without that list (an older host
 * document) no picker renders and the card stays on its default window.
 */
function DayPicker(props: {
  value: string
  options: string[]
  today: string
  /** An extra leading option; the Token bank passes its whole-ledger window. */
  leading?: { value: string; label: string }
  onSelect: (date: string) => void
  /** Namespaces the element id, so the two tabs keep one control each. */
  part: string
}): ReactNode {
  const { value, options, today, leading, onSelect, part } = props
  if (options.length === 0) return null
  return (
    <div className={styles.dayPicker}>
      <label className={styles.dayPickerLabel} htmlFor={'dsh-usage-day-' + part}>{t('usage.day.label')}</label>
      <select
        id={'dsh-usage-day-' + part}
        className={styles.daySelect}
        value={value}
        onChange={(event) => { onSelect(event.target.value) }}
      >
        {leading !== undefined && <option value={leading.value}>{leading.label}</option>}
        {options.map((date) => (
          <option key={date} value={date}>{date === today ? t('usage.day.today') : date}</option>
        ))}
      </select>
    </div>
  )
}

/**
 * The window strip: one tile per fixed window plus the custom pair. Each tile
 * carries the window's whole-window token total and its call count, so the
 * four standard windows can be compared at a glance without switching.
 */
function RangeStrip(props: {
  rangeKey: RangeKey
  onSelect: (key: RangeKey) => void
  tiles: Array<{ key: RangeKey; totals: UsageTokenTotals; meta: string; loading: boolean; hint?: string }>
  custom: { from: string; to: string }
  onCustomFrom: (value: string | undefined) => void
  onCustomTo: (value: string | undefined) => void
  /** Latest pickable day: a window cannot run into the future. */
  today: string
  /** Earliest pickable day: the ledger's oldest, so the pair cannot name a window the host cannot answer. */
  min?: string
}): ReactNode {
  const { rangeKey, onSelect, tiles, custom, onCustomFrom, onCustomTo, today, min } = props
  return (
    <div className={styles.card} data-dsh-part="range-card">
      <span className={styles.cardTitle}>{t('usage.range.title')}</span>
      <div className={styles.rangeGrid} data-dsh-part="range-tiles">
        {tiles.map((tile) => (
          <button
            key={tile.key}
            type="button"
            aria-pressed={tile.key === rangeKey}
            className={tile.key === rangeKey ? `${styles.rangeTile} ${styles.rangeTileActive}` : styles.rangeTile}
            onClick={() => { onSelect(tile.key) }}
          >
            <span className={styles.rangeTileLabel}>{t(RANGE_LABEL_KEYS[tile.key])}</span>
            <span className={styles.rangeTileValue}>
              {tile.hint !== undefined ? tile.hint : tile.loading ? '…' : formatTokens(totalOf(tile.totals))}
            </span>
            {tile.hint === undefined && !tile.loading && <span className={styles.rangeTileMeta}>{tile.meta}</span>}
          </button>
        ))}
      </div>
      {rangeKey === 'custom' && (
        <div className={styles.rangeControls} data-dsh-part="custom-range">
          <label className={styles.settingItem}>
            {t('usage.range.customFrom')}
            <input
              type="date"
              className={styles.dateInput}
              value={custom.from}
              // The window starts at the oldest retained day: earlier dates are
              // answerable but always empty, and the picker should not offer them.
              min={min}
              max={custom.to === '' || custom.to > today ? today : custom.to}
              onChange={(event) => { onCustomFrom(event.target.value === '' ? undefined : event.target.value) }}
            />
          </label>
          <label className={styles.settingItem}>
            {t('usage.range.customTo')}
            <input
              type="date"
              className={styles.dateInput}
              value={custom.to}
              min={custom.from === '' ? undefined : custom.from}
              max={today}
              onChange={(event) => { onCustomTo(event.target.value === '' ? undefined : event.target.value) }}
            />
          </label>
        </div>
      )}
    </div>
  )
}

/**
 * One channel bar with its model sub-bars and the share of the window it
 * holds. Every model the host returned renders (the wire caps a provider at 12
 * rows), so a window never hides a model behind a "top 3". The provider bar is
 * a stacked fill of its models' hues — heaviest model first — so a
 * multi-model channel reads as the color mix it is, and each model keeps the
 * one hue it carries everywhere else in the panel.
 */
function ChannelBreakdown(props: { summary: UsageWindowSummary; providers: ProviderSnapshotView[]; currentProvider?: string; modelColors: Map<string, string>; modelLabels: Map<string, string> }): ReactNode {
  const { summary, providers, currentProvider, modelColors, modelLabels } = props
  const { totals } = summary
  const grand = totalOf(totals)
  if (summary.providers.length === 0 || grand === 0) return <span className={styles.muted}>{t('usage.range.empty')}</span>
  const nameOf = (id: string): string => providers.find((provider) => provider.provider === id)?.displayName ?? id
  const labelOf = (model: string): string => modelLabels.get(model) ?? model
  // Channel shares are rounded with the largest-remainder method: rounding each
  // channel on its own made the headers add up to 99 % or 102 %, which reads as
  // a bug in the numbers rather than in the rounding.
  const sharePcts = roundShares(summary.providers.map((row) => (totalOf(row.totals) / grand) * 100))
  return (
    <div className={styles.chart} data-dsh-part="channel-breakdown">
      {summary.providers.map((row, index) => {
        const total = totalOf(row.totals)
        const share = sharePcts[index] ?? 0
        // The model rows inside one channel round to 100 % together, the same
        // way the channels above do: three equal models read 34/33/33, not 99.
        const modelPcts = roundShares(row.models.map((model) => (total > 0 ? (totalOf(model.totals) / total) * 100 : 0)))
        return (
          <div key={row.provider} className={styles.chartProvider}>
            <span className={styles.chartHead}>
              <span className={styles.providerName}>
                <span className={styles.chartHeadName}>{nameOf(row.provider)}</span>
                {currentProvider === row.provider && <span className={styles.currentBadge}>{t('usage.current')}</span>}
              </span>
              <span className={styles.chartHeadTokens}>
                {formatTokens(total)} · {t('usage.calls', { n: row.totals.calls })} · {share}%{row.totals.cost > 0 ? ' · ' + formatCost(row.totals.cost) : ''}
              </span>
            </span>
            <span className={styles.chartBar}>
              {(row.models.length > 0 ? row.models : [{ model: row.provider, totals: row.totals }]).map((segment) => {
                // Segment widths share the WINDOW total as denominator, so a
                // bar's full length reads as the channel's own share of the
                // window — matching the percent in the row header instead of
                // always stretching the heaviest channel to 100%.
                const width = (totalOf(segment.totals) / grand) * 100
                if (width <= 0) return null
                return (
                  <span
                    key={segment.model}
                    className={styles.chartSeg}
                    style={{ width: `${width}%`, background: modelColors.get(segment.model) ?? MODEL_COLOR_OTHER }}
                  />
                )
              })}
            </span>
            {row.models.length > 0 && (
              <div className={styles.modelRows} data-dsh-part="model-rows">
                {row.models.map((model, modelIndex) => {
                  const modelTotal = totalOf(model.totals)
                  const label = labelOf(model.model)
                  // Sub-bar widths share the CHANNEL total — the mother bar's
                  // own 100 % — so a row reads as that model's slice of its
                  // channel and a single-model channel fills its track, the
                  // same proportion its segment holds inside the bar above.
                  // The window scale belongs to the mother row, not here.
                  const sharePct = total > 0 ? (modelTotal / total) * 100 : 0
                  return (
                    <span key={model.model} className={styles.chartModel} title={`${row.provider} · ${label}: ${formatTokens(modelTotal)}`}>
                      <span className={styles.chartModelName}>{label}</span>
                      <span className={styles.chartModelBar}>
                        <span
                          className={styles.chartModelFill}
                          style={{ width: `${Math.max(3, Math.round(sharePct))}%`, background: modelColors.get(model.model) ?? MODEL_COLOR_OTHER }}
                        />
                      </span>
                      <span className={styles.chartTokens}>{formatTokens(modelTotal)} · {t('usage.calls', { n: model.totals.calls })} · {modelPcts[modelIndex] ?? 0}%</span>
                    </span>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** The three panels, in tab order; the tablist's roving focus walks this list. */
const TABS = ['usage', 'plans', 'bank'] as const
type TabKey = (typeof TABS)[number]

/** Label key per tab, so the tablist renders from `TABS` instead of three copies. */
const TAB_LABEL_KEYS: Record<TabKey, string> = {
  usage: 'usage.tab.usage',
  plans: 'usage.tab.plans',
  bank: 'usage.tab.bank',
}

/** The section component; the slot merges the face into these props. */
export function UsageSectionCard(props: UsageSectionProps): ReactNode {
  const { store, poll, refresh, loadDay, loadRange, settings, deviceSync } = props
  const ui = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const settingsSnapshot = settings.getSnapshot()
  const settingsValue = settingsSnapshot.value ?? {}
  const [tab, setTab] = useState<TabKey>('usage')
  // Undefined means "the default window of the token bank"; a date switches it
  // to one retained day instead.
  const [bankDay, setBankDay] = useState<string | undefined>(undefined)
  const [refreshing, setRefreshing] = useState(false)
  const refreshTimer = useRef<number | undefined>(undefined)
  // The usage tab's window: a fixed range, or a custom date pair whose ends are
  // remembered separately so picking one end never loses the other.
  const [rangeKey, setRangeKey] = useState<RangeKey>('today')
  const [customFrom, setCustomFrom] = useState<string | undefined>(undefined)
  const [customTo, setCustomTo] = useState<string | undefined>(undefined)
  const dayCacheRef = useRef<DayCache>(new Map())
  // A fresh mount starts from an empty range cache: it refetches its per-day
  // windows anyway (that cache is per mount), and a previous mount's aggregate
  // would then sit beside newer numbers. A peer import or a late backfill can
  // change a past window while the panel is closed, which is exactly when that
  // mismatch would appear.
  const freshRangeCacheRef = useRef(false)
  if (!freshRangeCacheRef.current) {
    freshRangeCacheRef.current = true
    rangeResults.clear()
  }
  const [cacheEpoch, setCacheEpoch] = useState(0)
  // A tick the poll hands to the loaders so a failed day or window retries on
  // its own: without it one dropped request left a tile at "—" until the user
  // pressed refresh.
  const [retryTick, setRetryTick] = useState(0)
  // One button ref per tab: arrow-key navigation moves DOM focus with the
  // selection, and the panel ids tie each button to the panel it opens.
  const tabRefs = useRef<Record<TabKey, HTMLButtonElement | null>>({ usage: null, plans: null, bank: null })
  // Roving tabindex: only the selected tab sits in the tab order, and the arrow
  // keys move focus and selection together, the way the tablist pattern expects.
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const at = TABS.indexOf(tab)
    const next: TabKey | undefined = event.key === 'ArrowRight'
      ? TABS[(at + 1) % TABS.length]
      : event.key === 'ArrowLeft'
        ? TABS[(at + TABS.length - 1) % TABS.length]
        : event.key === 'Home'
          ? TABS[0]
          : event.key === 'End'
            ? TABS[TABS.length - 1]
            : undefined
    if (next === undefined) return
    event.preventDefault()
    setTab(next)
    tabRefs.current[next]?.focus()
  }
  // The enable checkbox writes through the shared form, so subscribing here
  // keeps the flag below live: the form republishes the Host's accepted value,
  // and the poll starts and stops with it instead of waiting for an unrelated
  // render.
  const [, bumpSettings] = useState(0)
  useEffect(() => settings.subscribe(() => bumpSettings((count) => count + 1)), [settings])
  const enabled = settingsValue.enabled ?? true

  // Poll while mounted, enabled and visible; the overview is cheap (no probes —
  // the host's own cycle owns those) so the panel follows the shared cadence
  // instead of a private constant: a user who sets the interval to five minutes
  // expects the panel to stop asking every ten seconds. The floor keeps a very
  // short setting from turning the panel into a poll loop.
  const pollIntervalMs = Math.max(SECTION_POLL_MS, (settingsValue.pollIntervalSec ?? 60) * 1000)
  useEffect(() => {
    // A disabled plugin deregisters its host routes, so the poll must stop with
    // it; the section re-enables by writing the flag back through the checkbox.
    if (!enabled) return undefined
    poll()
    let timer: number | undefined
    const start = (): void => {
      if (timer === undefined && document.visibilityState === 'visible') timer = window.setInterval(poll, pollIntervalMs)
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        poll()
        start()
      } else if (timer !== undefined) {
        window.clearInterval(timer)
        timer = undefined
      }
    }
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (timer !== undefined) window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [poll, enabled, pollIntervalMs])

  const snapshot = ui.snapshot
  const todayView = snapshot?.usage.today
  const todayDate = todayView?.date ?? ''
  // Every retained day the ledger recorded. The overview serves it as
  // `availableDays`; the trend's day rows carry the same keys on an older host.
  const recorded = snapshot === null ? [] : snapshot.usage.availableDays ?? snapshot.usage.days.map((row) => row.date)
  // The oldest retained day: the custom picker's floor, and the start of 全部.
  const oldestDay = recorded[0]
  // The history fingerprint every cached answer carries. A poll that only moved
  // today leaves it alone (today is subtracted); a poll that backfilled the past
  // or gained a day changes it, and the cache re-reads instead of going stale.
  const historyStamp = snapshot === null ? '' : historyStampOf(snapshot.usage)
  // The fixed windows inside the last-30 one share that window's per-day load
  // (today, yesterday, last3 and last7 are all slices of it), so one fetch
  // feeds five tiles; the two multi-month windows each read one range
  // aggregate instead.
  const last30Window: RangeWindow = { from: shiftDateKey(todayDate, -29), to: todayDate }
  const last7Window: RangeWindow = { from: shiftDateKey(todayDate, -6), to: todayDate }
  const last3Window: RangeWindow = { from: shiftDateKey(todayDate, -2), to: todayDate }
  const yesterdayWindow: RangeWindow = { from: shiftDateKey(todayDate, -1), to: shiftDateKey(todayDate, -1) }
  const todayWindow: RangeWindow = { from: todayDate, to: todayDate }
  const last180Window: RangeWindow = { from: shiftDateKey(todayDate, -179), to: todayDate }
  // The whole retained ledger: the oldest day the overview still lists through
  // today. An empty ledger collapses to today, which reads as an empty window.
  const allWindow: RangeWindow = { from: oldestDay ?? todayDate, to: todayDate }
  // Custom range: the user's pair when set, else a sensible seven-day default.
  // Until the user picks anything the tile shows a prompt instead of the
  // default's total, which would only repeat the 近 7 天 tile above it. Once one
  // end is set the other defaults to "today" / "six days earlier than the end",
  // so a half-picked pair still renders a real window.
  const customPicked = customFrom !== undefined || customTo !== undefined
  const pickedFrom = customFrom ?? (customTo === undefined ? last7Window.from : shiftDateKey(customTo, -6))
  const pickedTo = customTo ?? todayDate
  const customWindow: RangeWindow = pickedFrom !== '' && pickedTo !== '' && pickedFrom > pickedTo
    ? { from: pickedTo, to: pickedFrom }
    : { from: pickedFrom, to: pickedTo }

  const cache = dayCacheRef.current
  // A custom span past the per-day path's width reads the range aggregate
  // instead — one request for however long the span is.
  const customSpanDays = customPicked ? dateKeysBetween(customWindow.from, customWindow.to).length : 0
  const customIsRange = customSpanDays > RANGE_FETCH_MAX_DAYS
  const last30Days = useWindowDays(loadDay, recordedIn(last30Window, recorded, todayDate), cache, cacheEpoch, retryTick, historyStamp)
  // An untouched custom range has nothing to fetch: the prompt state renders
  // instead, so opening the section never fires requests for a window the user
  // has not asked for yet.
  const customDays = useWindowDays(loadDay, customPicked && !customIsRange ? recordedIn(customWindow, recorded, todayDate) : [], cache, cacheEpoch, retryTick, historyStamp)
  // Both multi-month windows fetch up to YESTERDAY: today rides the live
  // overview, so the aggregate never carries a stale copy of it. Each hook gets
  // the window, not a pre-computed span: it has to tell "no window yet" from
  // "window with nothing to fetch" to keep the 全部 tile out of a permanent
  // pending state on a ledger that only holds today.
  const last180Load = useRangeData(loadRange, last180Window, todayDate, cacheEpoch, retryTick, historyStamp)
  const allLoad = useRangeData(loadRange, allWindow, todayDate, cacheEpoch, retryTick, historyStamp)
  const customRangeLoad = useRangeData(loadRange, customPicked && customIsRange ? customWindow : undefined, todayDate, cacheEpoch, retryTick, historyStamp)
  /** One range-kind window as the panel states it: the fetched aggregate plus the live day. */
  const rangeSummaryOf = (window: RangeWindow, load: RangeLoad): UsageWindowSummary =>
    withLiveToday({ from: window.from, to: window.to, ...(load.summary ?? { totals: emptyTotals(), providers: [] }) }, window, todayView)
  // A failed day or window retries on an exponential backoff and then stops.
  // The loaders only re-run when their inputs change and a dropped request is
  // not an input, so without this tick a tile stayed at "—" until the user
  // pressed refresh — but a fixed fast interval retried a dead endpoint forever,
  // which is why the attempt count is capped and the delay doubles.
  const loadsFailed = last30Days.error !== undefined || customDays.error !== undefined
    || last180Load.status === 'error' || allLoad.status === 'error' || customRangeLoad.status === 'error'
  const retryAttempts = useRef(0)
  // A host that is answering again has recovered, so a spent budget refills.
  // Without this the panel stopped retrying for good once it had spent five
  // attempts and a failed window sat at "—" until the user pressed refresh,
  // however long the section stayed open. Two things keep it honest: a stamp
  // that did not move proves nothing (a poll that brought nothing new is not a
  // recovery), and a chain still walking its ladder keeps its place, so an
  // unrelated overview poll — or the user's own refresh, which lands the same
  // way — cannot rewind the backoff to its first rung.
  const progressStamp = snapshot?.updatedAt ?? 0
  const budgetStamp = useRef(progressStamp)
  useEffect(() => {
    if (progressStamp === budgetStamp.current) return
    budgetStamp.current = progressStamp
    if (loadsFailed && retryAttempts.current >= RETRY_MAX_ATTEMPTS) {
      retryAttempts.current = 0
      // A refilled budget is only worth anything if something walks the ladder
      // again: the retry effect watches the tick, not this stamp (the stamp moves
      // on every poll, which is exactly what used to starve the ladder).
      setRetryTick((tick) => tick + 1)
    }
  }, [progressStamp, loadsFailed])
  useEffect(() => {
    if (!loadsFailed) {
      retryAttempts.current = 0
      return undefined
    }
    if (retryAttempts.current >= RETRY_MAX_ATTEMPTS) return undefined
    const delay = Math.min(pollIntervalMs * 2 ** retryAttempts.current, RETRY_BACKOFF_MAX_MS)
    const timer = window.setTimeout(() => {
      retryAttempts.current += 1
      setRetryTick((tick) => tick + 1)
    }, delay)
    return () => window.clearTimeout(timer)
    // `progressStamp` is deliberately not a dependency: the host stamps every
    // overview with the current time, so a poll lands at about the first rung's
    // delay and re-armed the timer before it could fire — the count never rose
    // and the ladder never walked. The budget refill above is where a poll gets
    // to act on a recovery.
  }, [loadsFailed, pollIntervalMs, retryTick])

  const dayOptions = snapshot === null
    ? []
    : [...new Set([todayDate, ...(snapshot.usage.availableDays ?? [])]
      .filter((date): date is string => date !== undefined && date !== ''))].sort().reverse()
  // A selection retention no longer holds falls back to the tab's default
  // window, so the picker can never keep displaying a day the host dropped.
  const bankSelection = bankDay !== undefined && dayOptions.includes(bankDay) ? bankDay : undefined
  const bankDayLoad = useDayView(loadDay, bankSelection, todayDate, cache, cacheEpoch, retryTick, historyStamp)
  const bankDayView = bankSelection === undefined
    ? undefined
    : bankSelection === todayDate ? snapshot?.usage.today : bankDayLoad?.view
  const bankWindow = bankSelection === undefined
    ? snapshot?.usage.all ?? snapshot?.usage.range
    : bankDayView === undefined
      ? undefined
      : { from: bankDayView.date, to: bankDayView.date, totals: bankDayView.totals, providers: bankDayView.providers }

  const onRefresh = (): void => {
    setRefreshing(true)
    // A late host backfill or peer import can still change a past window, so a
    // manual refresh drops both caches and refetches every window — including
    // the requests already in flight, which would otherwise settle into the
    // caches with the data this refresh is meant to replace.
    dayCacheRef.current.clear()
    clearUsageCaches()
    setCacheEpoch((epoch) => epoch + 1)
    try {
      refresh()
    } finally {
      // The POST resolves through the next poll tick; unlock shortly either way.
      // The timer is tracked so an unmount does not leave a state update behind,
      // and a second click replaces the first deadline instead of stacking one.
      if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current)
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = undefined
        setRefreshing(false)
      }, 3000)
    }
  }

  // The unlock deadline dies with the panel; a timer left running would call
  // setState on a component that is no longer mounted.
  useEffect(() => () => {
    if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current)
    refreshTimer.current = undefined
  }, [])

  // Disabled and still-loading states keep the settings row mounted: it owns
  // the enable checkbox, so replacing the whole panel would leave the user no
  // way back from the UI. A failed poll keeps the last snapshot on screen
  // instead (a stale line marks it): one dropped request must not blank a
  // panel whose data is still the best answer available.
  if (!enabled || snapshot === null) {
    return (
      <div className={styles.section} data-dsh-plugin="usage">
        <span className={styles.muted} data-dsh-part="status-line" title={ui.status === 'error' ? ui.error ?? '' : undefined}>
          {!enabled
            ? t('usage.disabled')
            : ui.status === 'error'
              // Same split as the stale line: translated sentence on the surface,
              // raw transport text in the title.
              ? t('usage.error', { error: describeError(ui.error ?? '') })
              : t('usage.loading')}
        </span>
        <SettingsRow settings={settings} snapshot={settingsSnapshot.status === 'ready' ? settingsSnapshot : undefined} value={settingsValue} />
      </div>
    )
  }

  const current = snapshot.current
  const currentProvider = snapshot.providers.find((provider) => provider.provider === current.provider)
  // Peak-period line: only when the official DeepSeek family is in play this
  // session (the current route, or spend recorded under one today) and the
  // window is today. It describes the pricing window now, so a past window's
  // card drops it.
  const deepseekPeriod = deepseekPeriodAt(Date.now())
  const deepseekVisible = rangeKey === 'today' && ((current.provider !== undefined && isDeepSeekProviderRoute(current.provider))
    || snapshot.usage.today.providers.some((row) => isDeepSeekProviderRoute(row.provider)))
  // Plans tab: only configured routes with a real coding-plan/subscription
  // adapter (planSupported; an older host without the flag falls back to "has
  // a plan fact"). Balance-only providers (DeepSeek, ZenMux, ...) and
  // unconfigured routes (credential 'none') never appear here.
  const planProviders = snapshot.providers.filter((provider) => isConfigured(provider) && (provider.planSupported === true || (provider.planSupported === undefined && provider.plan !== undefined)))

  // The window the detail card renders, per range: the short windows slice
  // the last-30 (or custom) per-day load, the multi-month ones read their own
  // range aggregate.
  const windowSlices: Record<RangeKey, WindowSlice> = {
    today: { window: todayWindow, kind: 'days', load: last30Days },
    yesterday: { window: yesterdayWindow, kind: 'days', load: last30Days },
    last3: { window: last3Window, kind: 'days', load: last30Days },
    last7: { window: last7Window, kind: 'days', load: last30Days },
    last30: { window: last30Window, kind: 'days', load: last30Days },
    last180: { window: last180Window, kind: 'range', load: last180Load },
    all: { window: allWindow, kind: 'range', load: allLoad },
    custom: customIsRange
      ? { window: customWindow, kind: 'range', load: customRangeLoad }
      : { window: customWindow, kind: 'days', load: customDays },
  }
  const keysOf = (key: RangeKey): string[] => recordedIn(windowSlices[key].window, recorded, todayDate)
  // The five short windows share one 30-day day load, so its status says nothing
  // about a single window: `today` needs no day request at all (the overview
  // already holds it), and a window whose own dates arrived is done even while
  // the rest of the 30 days is still landing. Tiles and card judge by this.
  const slicePending = (slice: WindowSlice, key: RangeKey): boolean => {
    // 'idle' is the first frame of a range load, before its effect has started:
    // counting it as done would print "no usage recorded" over a fetch that has
    // not been made yet.
    if (slice.kind === 'range') return slice.load.status === 'loading' || slice.load.status === 'idle'
    if (slice.load.status !== 'loading') return false
    return keysOf(key).some((date) => slice.load.days[date] === undefined)
  }
  /** The failure that actually belongs to this window (a shared load can fail elsewhere). */
  const sliceFailed = (slice: WindowSlice, key: RangeKey): string | undefined => {
    if (slice.kind === 'range') return slice.load.status === 'error' ? slice.load.error ?? '' : undefined
    if (slice.load.error === undefined) return undefined
    return keysOf(key).some((date) => slice.load.days[date] === undefined) ? slice.load.error : undefined
  }
  /**
   * Whether this window's numbers are still incomplete: a settled load whose own
   * days did not all arrive. The sum over the days that did is a number nothing
   * measured, so the tile and the card both read this one predicate and neither
   * can state a total the other calls "—".
   */
  const slicePartial = (slice: WindowSlice, key: RangeKey): boolean => {
    if (slice.kind !== 'days') return false
    if (slice.load.status !== 'ready') return false
    return keysOf(key).some((date) => slice.load.days[date] === undefined)
  }
  const activeSlice = windowSlices[rangeKey]
  const activeWindow = activeSlice.window
  /** The failure this window's own numbers are missing because of. */
  const activeError = sliceFailed(activeSlice, rangeKey)
  /** The window's days are still arriving, so its totals are not stateable yet. */
  const activePartial = slicePartial(activeSlice, rangeKey)
  const summaryRaw: UsageWindowSummary = activeSlice.kind === 'range'
    ? rangeSummaryOf(activeWindow, activeSlice.load)
    : summaryIn(activeWindow, keysOf(rangeKey), activeSlice.load, todayView)
  const tiles: Array<{ key: RangeKey; totals: UsageTokenTotals; meta: string; loading: boolean; hint?: string }> = (Object.keys(windowSlices) as RangeKey[]).map((key) => {
    const slice = windowSlices[key]
    const totals = slice.kind === 'range' ? rangeSummaryOf(slice.window, slice.load).totals : totalsIn(slice.window, keysOf(key), slice.load, todayView)
    const loading = slicePending(slice, key)
    // A window whose days did not all arrive has no total to state: the sum of
    // the days that loaded is a wrong number, not a small one. The card below
    // carries the reason and the refresh button retries it.
    const partial = slicePartial(slice, key)
    // The custom tile has no window of its own until the user picks one; a
    // failed range fetch reads as an em dash rather than a fake zero.
    const hint = key === 'custom' && !customPicked && !loading
      ? t('usage.range.customPick')
      : partial || (slice.kind === 'range' && slice.load.status === 'error') ? '—' : undefined
    return {
      key,
      totals,
      meta: t('usage.calls', { n: totals.calls }),
      loading,
      ...(hint === undefined ? {} : { hint }),
    }
  })
  // The trend chart reads one row per calendar day — a days-kind window slices
  // its fetched day views (which carry per-provider per-model rows), a
  // range-kind window reads the fetched series with today overlaid live from
  // the overview (fresher than the fetch snapshot). An untouched custom range
  // has no calendar to draw yet.
  const seriesByDate = activeSlice.kind === 'range' && activeSlice.load.series !== undefined
    ? new Map(activeSlice.load.series.map((row) => [row.date, row]))
    : undefined
  const daysByDate = activeSlice.kind === 'days' ? activeSlice.load.days : undefined
  // A day whose fetch failed is unknown, not empty: the trend chart has to say
  // "load failed" there instead of "no usage recorded".
  const failedDates = activeSlice.kind === 'days' ? new Set(activeSlice.load.failedDates) : undefined
  // A failed aggregate answers for none of the days it was asked about, so every
  // drawn bar is unknown rather than empty — otherwise one failed request painted
  // a full row of "no records" bars and the chart's aria label still stated a
  // confident total. Today stays known: it rides the live overview, so a failure
  // that left nothing at all is the only case where the plot has nothing to draw.
  const rangeFailed = activeSlice.kind === 'range' && activeSlice.load.status === 'error'
    && activeSlice.load.series === undefined
  const trendRowsRaw: TrendRow[] = rangeKey === 'custom' && !customPicked
    ? []
    : dateKeysBetween(activeWindow.from, activeWindow.to).map((date) => {
        if (todayView !== undefined && date === todayView.date) {
          return { date, totals: todayView.totals, models: modelSplitOf(todayView) }
        }
        const seriesRow = seriesByDate?.get(date)
        if (seriesRow !== undefined) {
          return seriesRow.models !== undefined
            ? { date, totals: seriesRow.totals, models: seriesRow.models }
            : { date, totals: seriesRow.totals }
        }
        const view = daysByDate?.[date]
        return view !== undefined
          ? { date, totals: view.totals, models: modelSplitOf(view) }
          : { date, totals: emptyTotals(), ...(failedDates?.has(date) === true || rangeFailed ? { failed: true } : {}) }
      })
  // One hue per model for the whole panel: the trend bars, the provider bars
  // and the model rows all read from this table. Names fold onto their
  // normalized identity first (variant spellings of one model count as that
  // model, keeping its heaviest raw spelling as the display name), and the
  // palette slot comes from a stable hash of that name — not from usage rank,
  // which used to pin chart-1's blue onto whatever model led the window and
  // reshuffle every hue whenever the tile changed.
  const modelBuckets = normalizeModelRows([
    ...summaryRaw.providers.flatMap((row) => row.models.map((model) => ({ model: model.model, total: totalOf(model.totals) }))),
    ...trendRowsRaw.flatMap((row) => Object.entries(row.models ?? {}).map(([model, totals]) => ({ model, total: totalOf(totals) }))),
  ])
  const modelColors = assignModelColors(modelBuckets.keys())
  const modelLabels = new Map([...modelBuckets].map(([model, bucket]) => [model, bucket.display]))
  const summary: UsageWindowSummary = { ...summaryRaw, providers: normalizedProviders(summaryRaw.providers) }
  const trendRows: TrendRow[] = trendRowsRaw.map((row) => row.models === undefined ? row : { ...row, models: normalizedSplit(row.models) })

  return (
    <div className={styles.section} data-dsh-plugin="usage">
      <div className={styles.header} data-dsh-part="header">
        <span className={styles.currentProvider}>
          {currentProvider !== undefined
            ? `${currentProvider.displayName}${current.model !== undefined && current.model !== '' ? ' · ' + current.model : ''}`
            : t('usage.noData')}
        </span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className={styles.muted}>{t('usage.updated', { time: formatTime(snapshot.updatedAt) })}</span>
          <button type="button" className={styles.refreshBtn} onClick={onRefresh} disabled={refreshing}>
            {refreshing ? t('usage.refreshing') : t('usage.refresh')}
          </button>
        </span>
      </div>

      {/* Both notices sit above the tabs: they describe the snapshot every tab
          reads, not just the one that happens to be open. */}
      {ui.status === 'error' && (
        // The sentence is translated; the raw text stays in the title, where a
        // diagnostic belongs — it names the internal route and the status code.
        <span className={styles.errorLine} role="status" data-dsh-part="stale-line" title={ui.error ?? ''}>
          {t('usage.stale', { error: describeError(ui.error ?? ''), time: formatTime(snapshot.updatedAt) })}
        </span>
      )}
      {/* A ledger the host could not read makes every number below suspect, so
          the reason is stated before the numbers themselves. The sentence is
          translated and the raw text (a file path, an errno) stays in the title. */}
      {snapshot.usage.ledgerError !== undefined && (
        <span className={styles.errorLine} role="status" data-dsh-part="ledger-error" title={snapshot.usage.ledgerError}>
          {t('usage.ledger.error', { error: describeError(snapshot.usage.ledgerError, 'usage.error.readFailed') })}
        </span>
      )}
      {/* Not an error: what the totals below leave out. Said out loud because a
          replay cut short or a skipped retention otherwise reads as lost history. */}
      {snapshot.usage.ledgerError === undefined && snapshot.usage.ledgerNote !== undefined && (
        <span className={styles.noteLine} role="status" data-dsh-part="ledger-note">
          {t('usage.ledger.note', { note: snapshot.usage.ledgerNote })}
        </span>
      )}

      <div className={styles.tabs} role="tablist" data-dsh-part="tabs">
        {TABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={'dsh-usage-tab-' + key}
            aria-controls={'dsh-usage-panel-' + key}
            aria-selected={tab === key}
            // Roving tabindex: Tab enters the tablist on the selected tab only,
            // the arrows move from there.
            tabIndex={tab === key ? 0 : -1}
            ref={(element) => { tabRefs.current[key] = element }}
            className={tab === key ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            onClick={() => { setTab(key) }}
            onKeyDown={onTabKeyDown}
          >
            {t(TAB_LABEL_KEYS[key])}
          </button>
        ))}
      </div>

      {/* Every panel stays mounted so a tab's `aria-controls` always names a
          tabpanel that exists; `hidden` is what switches between them. */}
      <div
        className={styles.panel}
        role="tabpanel"
        id="dsh-usage-panel-usage"
        aria-labelledby="dsh-usage-tab-usage"
        hidden={tab !== 'usage'}
      >
        <RangeStrip
          rangeKey={rangeKey}
          onSelect={setRangeKey}
          tiles={tiles}
          custom={customPicked ? customWindow : { from: '', to: '' }}
          // The `min`/`max` attributes stop the picker's own calendar, not a
          // typed or pasted date, so the future end is clamped here as well.
          // A start before the ledger is left as typed — see clampDay.
          onCustomFrom={(value) => { setCustomFrom(clampDay(value, todayDate)) }}
          onCustomTo={(value) => { setCustomTo(value !== undefined && todayDate !== '' && value > todayDate ? todayDate : value) }}
          today={todayDate}
          // An empty ledger has no oldest day to clamp to.
          min={oldestDay}
        />

        <div className={styles.card} data-dsh-part="window-card">
          <div className={styles.windowHead}>
            <span className={styles.cardTitle}>{t('usage.range.detail', { label: t(RANGE_LABEL_KEYS[rangeKey]) })}</span>
            {/* An untouched custom range has no span to state yet. */}
            {(rangeKey !== 'custom' || customPicked) && (
              <span className={styles.spanLine}>{t('usage.range.span', { from: activeWindow.from, to: activeWindow.to })}</span>
            )}
          </div>
          {deepseekVisible && (
            <PeakBadge peak={deepseekPeriod.peak} boundaryMs={deepseekPeriod.boundaryMs} variant="full" />
          )}
          {activeError !== undefined && <span className={styles.errorLine} role="status" title={activeError}>{t('usage.range.error', { error: describeError(activeError) })}</span>}
          {rangeKey === 'custom' && !customPicked
            ? <span className={styles.muted} data-dsh-part="custom-prompt">{t('usage.range.customPrompt')}</span>
            : slicePending(activeSlice, rangeKey)
              ? <span className={styles.muted}>{t('usage.range.loading')}</span>
              : activeError !== undefined
                // The days that did arrive are a WRONG total, not a small one,
                // so a failed window states the failure and the per-day trend
                // (each bar is that day's own number) instead of a sum that
                // contradicts the "—" the tile shows for the same window. The
                // chart decides for itself whether it has a plot to draw: a
                // one-day window still owes the failure sentence.
                ? <TrendChart rows={trendRows} colors={modelColors} labels={modelLabels} allFailed={rangeFailed} />
                : isEmptyTotals(summary.totals) && summary.providers.length === 0 && !activePartial
                  ? <span className={styles.muted}>{t('usage.range.empty')}</span>
                  : <>
                    <TotalsRow totals={summary.totals} partial={activePartial} />
                    {!activePartial && summary.totals.cost > 0 && (
                      <div className={styles.providerRow} data-dsh-part="window-cost">
                        <span className={styles.providerName}>{t('usage.range.cost')}</span>
                        <span className={styles.providerTokens}>{formatCost(summary.totals.cost)}</span>
                      </div>
                    )}
                    {trendRows.length >= TREND_CHART_MIN_DAYS && <TrendChart rows={trendRows} colors={modelColors} labels={modelLabels} partial={activePartial} />}
                    <span className={styles.cardTitle}>{t('usage.range.channels')}</span>
                    <ChannelBreakdown summary={summary} providers={snapshot.providers} currentProvider={current.provider} modelColors={modelColors} modelLabels={modelLabels} />
                  </>}
        </div>

        <div className={styles.card} data-dsh-part="balance-card">
          <span className={styles.cardTitle}>{t('usage.balance')}</span>
          {(() => {
            const configured = snapshot.providers.filter(isConfigured)
            // Include rows whose balance is deliberately not applicable
            // (another origin's endpoint): the row itself explains why, which
            // a single generic line cannot (#1688).
            const rows = configured.filter((provider) => provider.balanceSupported === true || provider.balanceSupported === false || (provider.balanceSupported === undefined && provider.supported))
            if (rows.length === 0) {
              return <span className={styles.muted}>{configured.length === 0 ? t('usage.balance.noneConfigured') : t('usage.balance.unsupported')}</span>
            }
            return rows.map((provider) => (
              <ProviderRow key={provider.provider} provider={provider} current={current.provider} />
            ))
          })()}
          {snapshot.providers.some((provider) => isConfigured(provider) && provider.error !== undefined) && (
            <span
              className={styles.errorLine}
              // The raw provider text stays reachable as a tooltip: it is what a
              // bug report needs, and what the panel must not show in a locale
              // it does not own.
              title={snapshot.providers.filter((provider) => isConfigured(provider) && provider.error !== undefined).map((provider) => `${provider.displayName}: ${provider.error ?? ''}`).join('\n')}
            >
              {snapshot.providers.filter((provider) => isConfigured(provider) && provider.error !== undefined).map((provider) => `${provider.displayName}: ${t('usage.provider.error', { error: describeError(provider.error ?? '') })}`).join(t('usage.errorListSeparator'))}
            </span>
          )}
        </div>

        <DeviceSyncCard
          deviceId={snapshot.usage.deviceId}
          devices={snapshot.usage.devices}
          devicesError={snapshot.usage.devicesError}
          api={deviceSync}
          onChanged={onRefresh}
        />

        <SettingsRow settings={settings} snapshot={settingsSnapshot.status === 'ready' ? settingsSnapshot : undefined} value={settingsValue} />
      </div>

      <div
        className={styles.panel}
        role="tabpanel"
        id="dsh-usage-panel-plans"
        aria-labelledby="dsh-usage-tab-plans"
        hidden={tab !== 'plans'}
      >
        {planProviders.length === 0
          ? <div className={styles.card}><span className={styles.muted}>{t('usage.plan.noneConfigured')}</span></div>
          : planProviders.map((provider) => <PlanCard key={provider.provider} provider={provider} current={current.provider} />)}
      </div>

      <div
        className={styles.panel}
        role="tabpanel"
        id="dsh-usage-panel-bank"
        aria-labelledby="dsh-usage-tab-bank"
        hidden={tab !== 'bank'}
      >
        <DayPicker
          part="bank"
          value={bankSelection ?? BANK_ALL_DAYS}
          options={dayOptions}
          today={todayDate}
          leading={{ value: BANK_ALL_DAYS, label: t('usage.bank.windowAll') }}
          onSelect={(date) => { setBankDay(date === BANK_ALL_DAYS ? undefined : date) }}
        />
        <VoucherCard
          window={bankWindow}
          // The observed-spend watch accrues from its own first balance
          // reading, so it describes the whole window only: a single day's
          // voucher falls back to that day's fold-time estimate.
          observedSpend={bankSelection === undefined ? snapshot.usage.observedSpend : undefined}
          loading={bankSelection !== undefined && bankDayLoad?.status === 'loading'}
          {...(bankDayLoad?.status === 'error' ? { error: bankDayLoad.error ?? '' } : {})}
        />
      </div>
    </div>
  )
}

/**
 * The Token 银行 card: the mint family's (DeepSeek official + MiMo)
 * retained-ledger usage minted onto the whale-yuan note at 1,000,000 tokens
 * per whale yuan. The window is the whole retained ledger by default (the
 * host's aggregate, falling back to the 30-day trend when an older host serves
 * no `all`) or the single day the user picked; the spend line prefers the
 * official balance watch (whole window only) and falls back to the fold-time
 * estimate, which only the priced family feeds; the artwork draw failure
 * degrades to an error line and never takes the section down.
 */
function VoucherCard(props: { window?: UsageWindowSummary; observedSpend?: ObservedSpendView; loading?: boolean; error?: string }): ReactNode {
  const { window: ledger, observedSpend, loading, error } = props
  const data = voucherData(ledger)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [drawError, setDrawError] = useState<string | undefined>(undefined)
  // Encoding a full-size PNG takes long enough to be worth a label change: a
  // button that looks idle invites a second click and a second download.
  const [saving, setSaving] = useState(false)
  const dataKey = data === undefined ? '' : `${data.from}|${data.to}|${data.tokens}|${data.calls}|${data.cost}`

  useEffect(() => {
    if (data === undefined) return
    const voucher = data
    let cancelled = false
    loadVoucherArt().then((art) => {
      if (cancelled) return
      const canvas = canvasRef.current
      if (canvas !== null) {
        try {
          drawVoucher(canvas, art, voucher)
          // A draw that works clears an earlier failure: the line describes the
          // artwork currently on screen, and one transient decode error used to
          // pin it for the rest of the mount.
          setDrawError(undefined)
        } catch (error) {
          if (!cancelled) setDrawError(error instanceof Error ? error.message : String(error))
        }
      }
    }, (error) => {
      if (!cancelled) setDrawError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
    }
  // dataKey covers every field the draw and the buttons read.
  }, [dataKey])

  const onSave = (): void => {
    const canvas = canvasRef.current
    if (canvas === null || data === undefined || saving) return
    setSaving(true)
    canvas.toBlob((blob) => {
      setSaving(false)
      if (blob === null) return
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `dsh-whale-voucher-${data.to}.png`
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
    }, 'image/png')
  }

  const shareSupported = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function'
  const onShare = (): void => {
    const canvas = canvasRef.current
    if (canvas === null || data === undefined || !shareSupported) return
    canvas.toBlob(async (blob) => {
      if (blob === null) return
      const file = new File([blob], `dsh-whale-voucher-${data.to}.png`, { type: 'image/png' })
      if (!navigator.canShare({ files: [file] })) return
      try {
        await navigator.share({ files: [file], title: t('usage.bank.title') })
      } catch {
        // A user-cancelled share sheet rejects; nothing to report.
      }
    }, 'image/png')
  }

  return (
    <div className={styles.card} data-dsh-part="bank-card">
      <span className={styles.cardTitle}>{t('usage.bank.title')}</span>
      {error !== undefined
        // The sentence is translated; the raw text (route and status code) stays
        // in the title, where a diagnostic belongs.
        ? <span className={styles.errorLine} title={error}>{t('usage.day.error', { error: describeError(error) })}</span>
        : loading === true
          ? <span className={styles.muted}>{t('usage.day.loading')}</span>
          : data === undefined
            ? <span className={styles.muted}>{t('usage.bank.noUsage')}</span>
            : <>
            <span className={styles.muted}>{t('usage.bank.hint')}</span>
            <div className={styles.voucherPreview} data-dsh-part="voucher-preview">
              <canvas ref={canvasRef} role="img" aria-label={t('usage.bank.title')} />
            </div>
            {drawError !== undefined && <span className={styles.errorLine}>{t('usage.bank.drawError', { error: drawError })}</span>}
            <div className={styles.providerRow}>
              <span className={styles.providerName}>{t('usage.bank.minted', { minted: formatDenomination(faceValue(data.tokens)), tokens: formatTokens(data.tokens) })}</span>
              <span className={styles.providerTokens}>{t('usage.calls', { n: data.calls })}</span>
            </div>
            <span className={styles.muted}>
              {observedSpend !== undefined
                ? t('usage.bank.spend.observed', { cost: observedSpend.cny.toFixed(2), since: formatDay(observedSpend.since) })
                : t('usage.bank.spend.estimated', { cost: data.cost.toFixed(2) })}
            </span>
            <span className={styles.muted}>{t('usage.bank.window', { from: data.from, to: data.to })}</span>
            <div className={styles.buttonRow}>
              <button type="button" className={styles.refreshBtn} onClick={onSave} disabled={saving}>
                {saving ? t('usage.bank.saving') : t('usage.bank.save')}
              </button>
              {shareSupported && <button type="button" className={styles.refreshBtn} onClick={onShare} disabled={saving}>{t('usage.bank.share')}</button>}
            </div>
          </>}
    </div>
  )
}

function PlanCard(props: { provider: ProviderSnapshotView; current?: string }): ReactNode {
  const { provider, current } = props
  return (
    <div className={`${styles.card} ${styles.planCard}`} data-dsh-part="plan-card">
      <div className={styles.planHead}>
        <span className={styles.planName}>
          {provider.displayName}
          {current === provider.provider && <span className={styles.currentBadge}>{t('usage.current')}</span>}
          {provider.plan?.planName !== undefined ? ` · ${provider.plan.planName}` : ''}
        </span>
      </div>
      {provider.error !== undefined && <span className={styles.errorLine}>{t('usage.provider.error', { error: provider.error })}</span>}
      {provider.credential === 'none' && provider.plan === undefined
        ? <span className={styles.muted}>{t('usage.balance.noCredential')}</span>
        : provider.plan === undefined || provider.plan.windows.length === 0
          ? <span className={styles.muted}>{t('usage.plan.noPlan')}</span>
          : provider.plan.windows.map((window, windowAt) => (
            <div key={`${window.key}#${windowAt}`} className={styles.windowRow} data-dsh-part="plan-window">
              <span className={styles.windowLabel}>
                <span>{planWindowLabel(window)}</span>
                <span>{window.percent !== undefined ? `${window.percent >= 10 ? Math.round(window.percent) : window.percent.toFixed(1)}%` : ''}</span>
              </span>
              {window.percent !== undefined && (
                <span className={styles.bar}>
                  <span className={toneClass(window.percent)} style={{ width: `${Math.min(100, Math.max(0, window.percent))}%`, display: 'block' }} />
                </span>
              )}
              {window.resetsAt !== undefined && (
                <span className={styles.resetLine}>{t('usage.plan.reset', { date: new Date(window.resetsAt).toLocaleString() })}</span>
              )}
            </div>
          ))}
    </div>
  )
}

/**
 * The interval the Host enforces. A poll under 30s costs more than it can learn,
 * and an hour is the longest interval the setting offers before the panel reads
 * as stale.
 */
const POLL_MIN_SEC = 30
const POLL_MAX_SEC = 3600

/**
 * The interval a typed draft asks for, or undefined when the draft names none.
 * A half-typed edit ("12", "") is not a number the Host can honour, so this is
 * only asked at commit time, never on the keystroke that produced it.
 */
function parsePollInterval(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return undefined
  return Math.min(POLL_MAX_SEC, Math.max(POLL_MIN_SEC, Math.round(parsed)))
}

/**
 * The compact settings row. Both controls write through the shared form the
 * moment the user changes them, and the Host answers each write with a
 * boolean: a refused (or transport-failed) write is surfaced as a failed save,
 * because a value that did not land must never read as applied.
 */
function SettingsRow(props: {
  settings: UsageSectionProps['settings']
  snapshot?: ConfigFormSnapshot<UsageSettings>
  value: UsageSettings
}): ReactNode {
  const { settings, snapshot, value } = props
  const disabled = snapshot === undefined || !snapshot.writable
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // The interval field keeps its own draft text. Bound straight to the snapshot
  // it refused every intermediate value — typing "120" over "60" starts as "1",
  // which is out of range, so the field snapped back on the first keystroke and
  // Delete (empty, i.e. 0) was rejected too. The draft is committed on blur or
  // Enter, which is also when a clamp is visible instead of fighting the keys.
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const storedInterval = typeof value.pollIntervalSec === 'number' ? value.pollIntervalSec : 60

  const write = (field: 'enabled' | 'pollIntervalSec', next: boolean | number): void => {
    setFailure(undefined)
    let answer: Promise<boolean>
    try {
      answer = settings.set(field, next)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
      return
    }
    // false is the contract's refusal/skip answer (the Host rejected the value,
    // the entry is not writable, or the write was dropped); a rejecting
    // transport reports through the same failed-save surface.
    Promise.resolve(answer).then(
      (accepted) => { if (!accepted) setFailure('') },
      (error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) },
    )
  }

  const commitInterval = (): void => {
    if (draft === undefined) return
    const next = parsePollInterval(draft)
    if (next === undefined) {
      // Not a number: drop the draft, which puts the stored interval back in the
      // field rather than leaving it blank.
      setDraft(undefined)
      return
    }
    // Show the clamped number at once, so a typed 9999 reads as 3600 without
    // waiting for the snapshot to round-trip through the Host.
    setDraft(String(next))
    if (next !== storedInterval) write('pollIntervalSec', next)
  }

  // Once the snapshot carries the committed number the draft has done its job;
  // until then it keeps the field from flashing back to the old value.
  useEffect(() => {
    if (draft === undefined) return
    if (parsePollInterval(draft) === storedInterval) setDraft(undefined)
  }, [draft, storedInterval])

  return (
    <div className={styles.card} data-dsh-part="settings-row">
      <span className={styles.cardTitle}>{t('usage.config.title')}</span>
      <div className={styles.settingsGrid}>
        <label className={styles.settingItem}>
          <input
            type="checkbox"
            checked={value.enabled ?? true}
            disabled={disabled}
            onChange={(event) => { write('enabled', event.target.checked) }}
          />
          {t('usage.config.enabled')}
        </label>
        <label className={styles.settingItem}>
          {t('usage.config.pollIntervalSec')}
          <input
            type="number"
            min={POLL_MIN_SEC}
            max={POLL_MAX_SEC}
            value={draft ?? String(storedInterval)}
            disabled={disabled}
            onChange={(event) => { setDraft(event.target.value) }}
            onBlur={commitInterval}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              commitInterval()
            }}
          />
        </label>
      </div>
      {failure !== undefined && (
        <span className={styles.errorLine} role="status">
          {t('usage.config.saveFailed')}{failure === '' ? '' : ' - ' + failure}
        </span>
      )}
    </div>
  )
}
