/**
 * The usage statistics settings section: three tabs (用量: one time window
 * picked from 今日 / 昨日 / 近 7 天 / 近 30 天 / 自定义, rendered as window
 * totals plus the per-channel and per-model breakdown and a per-day bar chart,
 * with balances below; 个人套餐: per-provider plan quota windows; Token 银行:
 * the whale-yuan voucher minted from the DeepSeek official family's usage)
 * plus a compact settings row.
 *
 * Data: today and the whole-ledger aggregates ride the host's loopback-fenced
 * /api/dsh-usage/overview document. Any window that reaches past today is
 * merged in the browser from one small `/api/dsh-usage/day` request per day
 * the ledger recorded inside the window (the overview lists those days), so a
 * window costs a handful of cheap loopback requests at most and the merged
 * days are cached for the session. Polling runs only while the section is
 * mounted and the tab is visible.
 * @module @linxin666/dsh-usage/client/UsageSectionCard
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { UsageStoreInstance } from './usage-store.ts'
import { t } from './locales.ts'
import styles from './usage.module.css'
import { PeakBadge } from './PeakBadge.tsx'
import { isDeepSeekProviderRoute } from '../core/adapters.ts'
import { deepseekPeriodAt } from '../core/pricing.ts'
import { localDateKey } from '../core/ledger.ts'
import { voucherData, drawVoucher, faceValue, formatDay, formatDenomination, loadVoucherArt } from './voucher.ts'
import { DeviceSyncCard, type DeviceSyncApi } from './DeviceSyncCard.tsx'
import { addTotals, emptyTotals, type ObservedSpendView, type ProviderSnapshotView, type UsageDayView, type UsageOverviewView, type UsageProviderSummary, type UsageTokenTotals, type UsageWindowSummary } from '../core/types.ts'

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

/** Longest window a custom date pair may describe (the ledger retains at most 730 days). */
const CUSTOM_MAX_DAYS = 366

/** Widest window that still renders one readable bar per day. */
const DAILY_CHART_MAX_DAYS = 45

/**
 * The daily chart needs at least two columns to say anything: a single-day
 * window would paint one bar across the full width, which reads as a solid
 * block rather than a chart, so those windows keep the totals and breakdown.
 */
const DAILY_CHART_MIN_DAYS = 2

/** Model rows kept per channel of a merged window (the host caps one day the same way). */
const WINDOW_MODEL_CAP = 12

/** Per-day requests one window may keep in flight. */
const DAY_FETCH_CONCURRENCY = 6

/** Compact token count: 12345 -> 12.3k, 1234567 -> 1.23M. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1000) return String(value)
  if (value < 1_000_000) return trim(value / 1000) + 'k'
  if (value < 1_000_000_000) return trim(value / 1_000_000) + 'M'
  return trim(value / 1_000_000_000) + 'B'
}

function trim(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(value >= 10 ? 1 : 2).replace(/\.?0+$/, '')
}

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

/** Every local-date key from `from` to `to` inclusive; empty when inverted. */
function dateKeysBetween(from: string, to: string): string[] {
  const keys: string[] = []
  if (from === '' || to === '' || from > to) return keys
  let key = from
  // The cap keeps a malformed pair from walking off the calendar.
  while (key <= to && keys.length < CUSTOM_MAX_DAYS) {
    keys.push(key)
    key = shiftDateKey(key, 1)
  }
  return keys
}

/** One selectable time window, as local-date keys. */
interface RangeWindow {
  from: string
  to: string
}

/** The fixed windows the section offers, plus the user-picked custom range. */
type RangeKey = 'today' | 'yesterday' | 'last7' | 'last30' | 'custom'

/** Locale key of each window's label. */
const RANGE_LABEL_KEYS: Record<RangeKey, string> = {
  today: 'usage.range.today',
  yesterday: 'usage.range.yesterday',
  last7: 'usage.range.last7',
  last30: 'usage.range.last30',
  custom: 'usage.range.custom',
}

/** Session cache of fetched day views: a past day does not change within one.
 * Refreshing the panel clears it, because a late backfill can still land. */
type DayCache = Map<string, UsageDayView>

/**
 * In-flight day requests, so two windows overlapping on one day (or React's
 * development double-mount) share one request instead of racing.
 */
const dayRequests = new Map<string, Promise<UsageDayView>>()

function requestDay(loadDay: (date: string) => Promise<UsageDayView>, date: string, cache: DayCache): Promise<UsageDayView> {
  const pending = dayRequests.get(date)
  if (pending !== undefined) return pending
  const request = loadDay(date).then(
    (view) => {
      dayRequests.delete(date)
      cache.set(date, view)
      return view
    },
    (error: unknown) => {
      dayRequests.delete(date)
      throw error
    },
  )
  dayRequests.set(date, request)
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
): WindowDays {
  const signature = dateKeys.join(',')
  const [load, setLoad] = useState<WindowDays>(() => ({ status: dateKeys.length === 0 ? 'ready' : 'loading', days: {} }))
  useEffect(() => {
    const wanted = signature === '' ? [] : signature.split(',')
    const days: Record<string, UsageDayView> = {}
    const missing: string[] = []
    for (const date of wanted) {
      const cached = cache.get(date)
      if (cached === undefined) missing.push(date)
      else days[date] = cached
    }
    if (missing.length === 0) {
      setLoad({ status: 'ready', days })
      return undefined
    }
    let cancelled = false
    setLoad({ status: 'loading', days })
    let failed = 0
    let firstError: string | undefined
    void mapPool(missing, DAY_FETCH_CONCURRENCY, async (date) => {
      try {
        days[date] = await requestDay(loadDay, date, cache)
      } catch (error) {
        failed += 1
        firstError ??= error instanceof Error ? error.message : String(error)
      }
    }).then(() => {
      if (cancelled) return
      setLoad({ status: 'ready', days, ...(failed > 0 ? { error: firstError ?? '' } : {}) })
    })
    return () => { cancelled = true }
  // `signature` carries the key list; `epoch` invalidates the cache.
  }, [signature, loadDay, cache, epoch])
  return load
}

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

function TotalsRow(props: { totals: UsageTokenTotals }): ReactNode {
  const { totals } = props
  return (
    <div className={styles.statRow}>
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
        <span className={styles.statValue}>{formatTokens(totals.cacheWriteTokens)}</span>
        <span className={styles.statLabel}>{t('usage.tokens.cacheWrite')}</span>
      </div>
      <div className={styles.stat}>
        <span className={styles.statValue}>{formatTokens(totals.calls)}</span>
        <span className={styles.statLabel}>{t('usage.calls', { n: totals.calls })}</span>
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
 */
function useDayView(loadDay: (date: string) => Promise<UsageDayView>, date: string | undefined, today: string | undefined): DayLoad | undefined {
  const [load, setLoad] = useState<DayLoad | undefined>(undefined)
  useEffect(() => {
    if (date === undefined || date === today) {
      setLoad((previous) => (previous === undefined ? previous : undefined))
      return undefined
    }
    let cancelled = false
    setLoad({ status: 'loading' })
    loadDay(date).then(
      (view) => { if (!cancelled) setLoad({ status: 'ready', view }) },
      (error: unknown) => { if (!cancelled) setLoad({ status: 'error', error: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { cancelled = true }
  }, [date, today, loadDay])
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
}): ReactNode {
  const { rangeKey, onSelect, tiles, custom, onCustomFrom, onCustomTo } = props
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
            {tile.hint === undefined && <span className={styles.rangeTileMeta}>{tile.meta}</span>}
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
              max={custom.to === '' ? undefined : custom.to}
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
 * rows), so a window never hides a model behind a "top 3".
 */
function ChannelBreakdown(props: { summary: UsageWindowSummary; providers: ProviderSnapshotView[]; currentProvider?: string }): ReactNode {
  const { summary, providers, currentProvider } = props
  const { totals } = summary
  const grand = totalOf(totals)
  if (summary.providers.length === 0 || grand === 0) return <span className={styles.muted}>{t('usage.range.empty')}</span>
  const maxProvider = Math.max(1, ...summary.providers.map((row) => totalOf(row.totals)))
  const nameOf = (id: string): string => providers.find((provider) => provider.provider === id)?.displayName ?? id
  return (
    <div className={styles.chart} data-dsh-part="channel-breakdown">
      {summary.providers.map((row) => {
        const total = totalOf(row.totals)
        const share = Math.round((total / grand) * 100)
        const maxModel = Math.max(1, ...row.models.map((model) => totalOf(model.totals)))
        return (
          <div key={row.provider} className={styles.chartProvider}>
            <span className={styles.chartHead}>
              <span className={styles.providerName}>
                {nameOf(row.provider)}
                {currentProvider === row.provider && <span className={styles.currentBadge}>{t('usage.current')}</span>}
              </span>
              <span className={styles.chartTokens}>
                {formatTokens(total)} · {t('usage.calls', { n: row.totals.calls })} · {share}%{row.totals.cost > 0 ? ' · ' + formatCost(row.totals.cost) : ''}
              </span>
            </span>
            <span className={styles.chartBar}>
              <span className={styles.chartFill} style={{ width: `${Math.max(2, Math.round((total / maxProvider) * 100))}%` }} />
            </span>
            {row.models.length > 0 && (
              <div className={styles.modelRows} data-dsh-part="model-rows">
                {row.models.map((model) => {
                  const modelTotal = totalOf(model.totals)
                  return (
                    <span key={model.model} className={styles.chartModel} title={`${row.provider} · ${model.model}: ${formatTokens(modelTotal)}`}>
                      <span className={styles.chartModelName}>{model.model}</span>
                      <span className={styles.chartModelBar}>
                        <span className={styles.chartModelFill} style={{ width: `${Math.max(3, Math.round((modelTotal / maxModel) * 100))}%` }} />
                      </span>
                      <span className={styles.chartTokens}>{formatTokens(modelTotal)} · {t('usage.calls', { n: model.totals.calls })}</span>
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

/**
 * One bar per calendar day of the window, so gaps in the record and the
 * day-to-day rhythm are visible. A day the ledger did not record renders as an
 * empty slot instead of a missing column.
 */
function DailyChart(props: { days: Array<{ date: string; totals: UsageTokenTotals }> }): ReactNode {
  const { days } = props
  if (days.length === 0) return null
  const max = Math.max(1, ...days.map((row) => totalOf(row.totals)))
  return (
    <div className={styles.dailyWrap} data-dsh-part="daily-chart">
      <div className={styles.dailyChart}>
        {days.map((row) => {
          const total = totalOf(row.totals)
          return (
            <span
              key={row.date}
              className={styles.dailyBar}
              title={`${row.date} · ${formatTokens(total)} · ${t('usage.calls', { n: row.totals.calls })}`}
            >
              <span
                className={styles.dailyFill}
                style={{ height: total === 0 ? '0%' : `${Math.max(4, Math.round((total / max) * 100))}%` }}
              />
            </span>
          )
        })}
      </div>
      <div className={styles.dailyLabels}>
        <span>{days[0].date.slice(5)}</span>
        <span>{days[days.length - 1].date.slice(5)}</span>
      </div>
    </div>
  )
}

/** The section component; the slot merges the face into these props. */
export function UsageSectionCard(props: UsageSectionProps): ReactNode {
  const { store, poll, refresh, loadDay, settings, deviceSync } = props
  const ui = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const settingsSnapshot = settings.getSnapshot()
  const settingsValue = settingsSnapshot.value ?? {}
  const [tab, setTab] = useState<'usage' | 'plans' | 'bank'>('usage')
  // Undefined means "the default window of the token bank"; a date switches it
  // to one retained day instead.
  const [bankDay, setBankDay] = useState<string | undefined>(undefined)
  const [refreshing, setRefreshing] = useState(false)
  // The usage tab's window: a fixed range, or a custom date pair whose ends are
  // remembered separately so picking one end never loses the other.
  const [rangeKey, setRangeKey] = useState<RangeKey>('today')
  const [customFrom, setCustomFrom] = useState<string | undefined>(undefined)
  const [customTo, setCustomTo] = useState<string | undefined>(undefined)
  const dayCacheRef = useRef<DayCache>(new Map())
  const [cacheEpoch, setCacheEpoch] = useState(0)
  // The enable checkbox writes through the shared form, so subscribing here
  // keeps the flag below live: the form republishes the Host's accepted value,
  // and the poll starts and stops with it instead of waiting for an unrelated
  // render.
  const [, bumpSettings] = useState(0)
  useEffect(() => settings.subscribe(() => bumpSettings((count) => count + 1)), [settings])
  const enabled = settingsValue.enabled ?? true

  // Poll while mounted, enabled and visible; the overview is cheap (no probes —
  // the host's own cycle owns those) so 10 s keeps balances fresh-ish between
  // manual refreshes.
  useEffect(() => {
    // A disabled plugin deregisters its host routes, so the poll must stop with
    // it; the section re-enables by writing the flag back through the checkbox.
    if (!enabled) return undefined
    poll()
    let timer: number | undefined
    const start = (): void => {
      if (timer === undefined && document.visibilityState === 'visible') timer = window.setInterval(poll, SECTION_POLL_MS)
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
  }, [poll, enabled])

  const snapshot = ui.snapshot
  const todayView = snapshot?.usage.today
  const todayDate = todayView?.date ?? ''
  // Every retained day the ledger recorded. The overview serves it as
  // `availableDays`; the trend's day rows carry the same keys on an older host.
  const recorded = snapshot === null ? [] : snapshot.usage.availableDays ?? snapshot.usage.days.map((row) => row.date)
  // The four fixed windows all sit inside the last-30 one, so one load feeds
  // them: fetch the recorded days of that window once, then slice it per tile.
  const last30Window: RangeWindow = { from: shiftDateKey(todayDate, -29), to: todayDate }
  const last7Window: RangeWindow = { from: shiftDateKey(todayDate, -6), to: todayDate }
  const yesterdayWindow: RangeWindow = { from: shiftDateKey(todayDate, -1), to: shiftDateKey(todayDate, -1) }
  const todayWindow: RangeWindow = { from: todayDate, to: todayDate }
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
  const last30Days = useWindowDays(loadDay, recordedIn(last30Window, recorded, todayDate), cache, cacheEpoch)
  // An untouched custom range has nothing to fetch: the prompt state renders
  // instead, so opening the section never fires requests for a window the user
  // has not asked for yet.
  const customDays = useWindowDays(loadDay, customPicked ? recordedIn(customWindow, recorded, todayDate) : [], cache, cacheEpoch)

  const dayOptions = snapshot === null
    ? []
    : [...new Set([todayDate, ...(snapshot.usage.availableDays ?? [])]
      .filter((date): date is string => date !== undefined && date !== ''))].sort().reverse()
  // A selection retention no longer holds falls back to the tab's default
  // window, so the picker can never keep displaying a day the host dropped.
  const bankSelection = bankDay !== undefined && dayOptions.includes(bankDay) ? bankDay : undefined
  const bankDayLoad = useDayView(loadDay, bankSelection, todayDate)
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
    // A late host backfill can still change a past day, so a manual refresh
    // drops the day cache and refetches every window.
    dayCacheRef.current.clear()
    setCacheEpoch((epoch) => epoch + 1)
    try {
      refresh()
    } finally {
      // The POST resolves through the next poll tick; unlock shortly either way.
      window.setTimeout(() => setRefreshing(false), 3000)
    }
  }

  // Disabled, failed and still-loading states keep the settings row mounted:
  // it owns the enable checkbox, so replacing the whole panel would leave the
  // user no way back from the UI.
  if (!enabled || ui.status === 'error' || snapshot === null) {
    return (
      <div className={styles.section} data-dsh-plugin="usage">
        <span className={styles.muted} data-dsh-part="status-line">
          {!enabled
            ? t('usage.disabled')
            : ui.status === 'error'
              ? t('usage.error', { error: ui.error ?? '' })
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

  // The window the detail card renders: the custom pair when picked, else the
  // fixed window on the last-30 load (which already fetched those days).
  // Slicing input of each window: which day views it may read, and which
  // recorded days still need a fetch.
  const windowSlices: Record<RangeKey, { window: RangeWindow; load: WindowDays }> = {
    today: { window: todayWindow, load: last30Days },
    yesterday: { window: yesterdayWindow, load: last30Days },
    last7: { window: last7Window, load: last30Days },
    last30: { window: last30Window, load: last30Days },
    custom: { window: customWindow, load: customDays },
  }
  const keysOf = (key: RangeKey): string[] => recordedIn(windowSlices[key].window, recorded, todayDate)
  const activeWindow = windowSlices[rangeKey].window
  const activeDays = windowSlices[rangeKey].load
  const summary = summaryIn(activeWindow, keysOf(rangeKey), activeDays, todayView)
  const tiles: Array<{ key: RangeKey; totals: UsageTokenTotals; meta: string; loading: boolean; hint?: string }> = (Object.keys(windowSlices) as RangeKey[]).map((key) => {
    const slice = windowSlices[key]
    const totals = totalsIn(slice.window, keysOf(key), slice.load, todayView)
    const loading = slice.load.status === 'loading'
    // The custom tile has no window of its own until the user picks one.
    const hint = key === 'custom' && !customPicked && !loading ? t('usage.range.customPick') : undefined
    return {
      key,
      totals,
      meta: t('usage.calls', { n: totals.calls }),
      loading,
      ...(hint === undefined ? {} : { hint }),
    }
  })
  // The daily chart reads one bar per calendar day; a window past the readable
  // width falls back to the totals and the breakdown alone. An untouched custom
  // range has no calendar to draw yet.
  const dailyKeys = rangeKey === 'custom' && !customPicked ? [] : dateKeysBetween(activeWindow.from, activeWindow.to)
  const dailyRows = dailyKeys.length >= DAILY_CHART_MIN_DAYS && dailyKeys.length <= DAILY_CHART_MAX_DAYS
    ? dailyKeys.map((date) => {
        if (todayView !== undefined && date === todayView.date) return { date, totals: todayView.totals }
        const view = activeDays.days[date]
        return { date, totals: view === undefined ? emptyTotals() : view.totals }
      })
    : []

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

      <div className={styles.tabs} role="tablist" data-dsh-part="tabs">
        <button type="button" role="tab" aria-selected={tab === 'usage'} className={tab === 'usage' ? `${styles.tab} ${styles.tabActive}` : styles.tab} onClick={() => setTab('usage')}>
          {t('usage.tab.usage')}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'plans'} className={tab === 'plans' ? `${styles.tab} ${styles.tabActive}` : styles.tab} onClick={() => setTab('plans')}>
          {t('usage.tab.plans')}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'bank'} className={tab === 'bank' ? `${styles.tab} ${styles.tabActive}` : styles.tab} onClick={() => setTab('bank')}>
          {t('usage.tab.bank')}
        </button>
      </div>

      {tab === 'usage' && (
        <>
          <RangeStrip
            rangeKey={rangeKey}
            onSelect={setRangeKey}
            tiles={tiles}
            custom={customPicked ? customWindow : { from: '', to: '' }}
            onCustomFrom={setCustomFrom}
            onCustomTo={setCustomTo}
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
            {activeDays.error !== undefined && <span className={styles.errorLine}>{t('usage.range.error', { error: activeDays.error })}</span>}
            {rangeKey === 'custom' && !customPicked
              ? <span className={styles.muted} data-dsh-part="custom-prompt">{t('usage.range.customPrompt')}</span>
              : activeDays.status === 'loading'
                ? <span className={styles.muted}>{t('usage.range.loading')}</span>
                : isEmptyTotals(summary.totals) && summary.providers.length === 0
                  ? <span className={styles.muted}>{t('usage.range.empty')}</span>
                  : <>
                      <TotalsRow totals={summary.totals} />
                      {summary.totals.cost > 0 && (
                        <div className={styles.providerRow} data-dsh-part="window-cost">
                          <span className={styles.providerName}>{t('usage.range.cost')}</span>
                          <span className={styles.providerTokens}>{formatCost(summary.totals.cost)}</span>
                        </div>
                      )}
                      <DailyChart days={dailyRows} />
                      <span className={styles.cardTitle}>{t('usage.range.channels')}</span>
                      <ChannelBreakdown summary={summary} providers={snapshot.providers} currentProvider={current.provider} />
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
              <span className={styles.errorLine}>
                {snapshot.providers.filter((provider) => isConfigured(provider) && provider.error !== undefined).map((provider) => `${provider.displayName}: ${t('usage.provider.error', { error: provider.error ?? '' })}`).join(t('usage.errorListSeparator'))}
              </span>
            )}
          </div>

          <DeviceSyncCard
            deviceId={snapshot.usage.deviceId}
            devices={snapshot.usage.devices}
            devicesError={snapshot.usage.devicesError}
            api={deviceSync}
            onChanged={refresh}
          />

          <SettingsRow settings={settings} snapshot={settingsSnapshot.status === 'ready' ? settingsSnapshot : undefined} value={settingsValue} />
        </>
      )}

      {tab === 'plans' && (
        planProviders.length === 0
          ? <div className={styles.card}><span className={styles.muted}>{t('usage.plan.noneConfigured')}</span></div>
          : planProviders.map((provider) => <PlanCard key={provider.provider} provider={provider} current={current.provider} />)
      )}

      {tab === 'bank' && (
        <>
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
        </>
      )}
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
    if (canvas === null || data === undefined) return
    canvas.toBlob((blob) => {
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
        ? <span className={styles.errorLine}>{t('usage.day.error', { error })}</span>
        : loading === true
          ? <span className={styles.muted}>{t('usage.day.loading')}</span>
          : data === undefined
            ? <span className={styles.muted}>{t('usage.bank.noUsage')}</span>
            : <>
            <span className={styles.muted}>{t('usage.bank.hint')}</span>
            <div className={styles.voucherPreview} data-dsh-part="voucher-preview">
              <canvas ref={canvasRef} aria-label={t('usage.bank.title')} />
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
              <button type="button" className={styles.refreshBtn} onClick={onSave}>{t('usage.bank.save')}</button>
              {shareSupported && <button type="button" className={styles.refreshBtn} onClick={onShare}>{t('usage.bank.share')}</button>}
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
          : provider.plan.windows.map((window) => (
            <div key={window.key} className={styles.windowRow} data-dsh-part="plan-window">
              <span className={styles.windowLabel}>
                <span>{window.name ?? t(`usage.plan.windows.${window.key}`)}</span>
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
            min={30}
            max={3600}
            value={typeof value.pollIntervalSec === 'number' ? value.pollIntervalSec : 60}
            disabled={disabled}
            onChange={(event) => {
              const parsed = Number(event.target.value)
              if (Number.isFinite(parsed) && parsed >= 30 && parsed <= 3600) write('pollIntervalSec', Math.round(parsed))
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
