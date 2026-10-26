/**
 * The window trend chart: one stacked bar per calendar day (or per week /
 * month bucket once the window outgrows one readable bar per day). Bars
 * stack BY MODEL — every model keeps one hue across the whole panel (see
 * model-colors), so the day bars, the provider bars and the model rows all
 * read as one color system; a day the model data is unknown for falls back to
 * a neutral slate segment, and a window without any model data falls back to
 * the token-type stack (cache reads / billed input / output).
 *
 * The plot is gridded with nice-number Y ticks, labels the X axis sparsely
 * (first / last / even steps), and hovers a tooltip carrying the bucket's
 * date span, totals, calls, cache-hit share and its heaviest models. A bucket
 * the ledger recorded nothing for renders as a zero-height slot the tooltip
 * reports as 无记录, so record gaps stay visible instead of disappearing.
 * @module @linxin666/dsh-usage/client/TrendChart
 */
import { useState, type CSSProperties, type ReactNode } from 'react'
import { t } from './locales.ts'
import styles from './usage.module.css'
import { formatTokens } from './format.ts'
import { localDateKey } from '../core/ledger.ts'
import { addTotals, emptyTotals, type UsageTokenTotals } from '../core/types.ts'
import { MODEL_COLOR_OTHER } from './model-colors.ts'

/** Longest span that still renders one readable bar per day. */
const DAILY_BUCKET_MAX_DAYS = 45

/** Past this span (in days) buckets collapse to months; weeks in between. */
const WEEKLY_BUCKET_MAX_DAYS = 200

/** Y ticks drawn above the baseline (plus the baseline itself). */
const GRIDLINE_FRACTIONS = [0.25, 0.5, 0.75, 1]

/** Rough cap on X labels so they never collide, whatever the bucket count. */
const X_LABEL_MAX = 8

/** Minimum on-screen height (%) of a bar with any usage at all. */
const BAR_MIN_HEIGHT_PCT = 2

/** Legend entries shown in model mode before the tail is cut off. */
const LEGEND_MAX_MODELS = 12

/** Models listed in the tooltip before it cuts to the totals line. */
const TOOLTIP_MAX_MODELS = 3

/** One calendar day of the window: totals plus the per-model split when known. */
export interface TrendRow {
  /** Local-date key `YYYY-MM-DD`. */
  date: string
  totals: UsageTokenTotals
  /** Per-model totals aggregated across providers, when the data carries them. */
  models?: Record<string, UsageTokenTotals>
  /**
   * The day's fetch failed, so its totals are unknown rather than zero. The
   * chart must not paint "no usage recorded" over a request that never landed.
   */
  failed?: boolean
}

/** One rendered column: a calendar day, or a week / month bucket. */
interface TrendBucket {
  /** Inclusive bounds as local-date keys. */
  from: string
  to: string
  /** X-axis label: MM-DD for day/week buckets, YYYY-MM for month buckets. */
  label: string
  totals: UsageTokenTotals
  /** Per-model totals accumulated across the bucket's days. */
  models: Map<string, UsageTokenTotals>
  /** False when the ledger recorded nothing inside the bucket. */
  recorded: boolean
  /** True when at least one day of the bucket failed to load (unknown, not zero). */
  failed: boolean
}

/** Billed-scale token count of a bucket (all four fields). */
function totalOf(totals: UsageTokenTotals): number {
  return totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens
}

/** Whether a bucket holds anything worth drawing. */
function hasUse(totals: UsageTokenTotals): boolean {
  return totals.calls > 0 || totalOf(totals) > 0
}

/** cacheRead / billed input in percent; undefined when nothing was billed. */
function cacheHitPercent(totals: UsageTokenTotals): number | undefined {
  const billed = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  return billed === 0 ? undefined : (totals.cacheReadTokens / billed) * 100
}

/** Smallest 1/2/5×10^n not below `value` — the classic nice-axis ceiling. */
function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const base = Math.pow(10, Math.floor(Math.log10(value)))
  for (const step of [1, 2, 5]) {
    const candidate = step * base
    if (candidate >= value) return candidate
  }
  return 10 * base
}

function granularityOf(dayCount: number): 'day' | 'week' | 'month' {
  if (dayCount <= DAILY_BUCKET_MAX_DAYS) return 'day'
  if (dayCount <= WEEKLY_BUCKET_MAX_DAYS) return 'week'
  return 'month'
}

/** The Monday of `key`'s ISO week, as a local-date key. */
function mondayOfKey(key: string): string {
  const date = new Date(key + 'T12:00:00')
  const weekday = date.getDay() // 0 = Sunday
  date.setDate(date.getDate() + (weekday === 0 ? -6 : 1 - weekday))
  return localDateKey(date.getTime())
}

/**
 * Collapse calendar-complete day rows into render buckets. Week buckets break
 * on Mondays (label = that Monday); month buckets break on the 1st (label =
 * YYYY-MM). Days arrive ascending and calendar-complete, so bucket bounds fall
 * out of the walk and per-model totals accumulate alongside the totals.
 */
function buildBuckets(rows: ReadonlyArray<TrendRow>, granularity: 'day' | 'week' | 'month'): TrendBucket[] {
  if (granularity === 'day') {
    return rows.map((row) => ({
      from: row.date,
      to: row.date,
      label: row.date.slice(5),
      totals: row.totals,
      models: new Map(Object.entries(row.models ?? {})),
      recorded: hasUse(row.totals),
      failed: row.failed === true,
    }))
  }
  const buckets: TrendBucket[] = []
  let open: { key: string; bucket: TrendBucket } | undefined
  for (const row of rows) {
    const key = granularity === 'week' ? mondayOfKey(row.date) : row.date.slice(0, 7)
    if (open === undefined || open.key !== key) {
      open = {
        key,
        bucket: {
          from: row.date,
          to: row.date,
          label: granularity === 'week' ? key.slice(5) : key,
          totals: emptyTotals(),
          models: new Map(),
          recorded: false,
          failed: false,
        },
      }
      buckets.push(open.bucket)
    }
    open.bucket.to = row.date
    addTotals(open.bucket.totals, row.totals)
    for (const [model, totals] of Object.entries(row.models ?? {})) {
      const bucket = open.bucket.models.get(model) ?? emptyTotals()
      addTotals(bucket, totals)
      open.bucket.models.set(model, bucket)
    }
    if (hasUse(row.totals)) open.bucket.recorded = true
    if (row.failed === true) open.bucket.failed = true
  }
  return buckets
}

/**
 * The window's model order for stacking and the legend: heaviest by total
 * tokens first, so the dominant model anchors the bar bottoms.
 */
function modelOrderOf(buckets: ReadonlyArray<TrendBucket>): string[] {
  const totals = new Map<string, number>()
  for (const bucket of buckets) {
    for (const [model, modelTotals] of bucket.models) {
      totals.set(model, (totals.get(model) ?? 0) + totalOf(modelTotals))
    }
  }
  return [...totals].sort((a, b) => b[1] - a[1]).map(([model]) => model)
}

/**
 * Stack heights as plot percentages for one bucket. `values` are raw segment
 * sizes on the axis scale; a non-empty bar below the floor is scaled up whole,
 * proportions kept, so a small day never vanishes against a much larger axis.
 */
function stackHeights(values: number[], axisMax: number): number[] {
  const heights = values.map((value) => (value / axisMax) * 100)
  const sum = heights.reduce((left, right) => left + right, 0)
  if (sum > 0 && sum < BAR_MIN_HEIGHT_PCT) {
    const bump = BAR_MIN_HEIGHT_PCT / sum
    return heights.map((height) => height * bump)
  }
  return heights
}

/** The token-type fallback stack: cache reads, billed input, output. */
function tokenStack(totals: UsageTokenTotals): Array<{ value: number; className: string }> {
  return [
    { value: totals.cacheReadTokens, className: styles.trendSegCache },
    { value: totals.inputTokens + totals.cacheWriteTokens, className: styles.trendSegInput },
    { value: totals.outputTokens, className: styles.trendSegOutput },
  ]
}

/** The one notice that stands in for a plot whose window failed whole. */
function TrendFailedNotice(): ReactNode {
  return (
    <div className={styles.trendFailed} data-dsh-part="trend-failed">
      <span className={styles.errorLine}>{t('usage.trend.loadFailed')}</span>
    </div>
  )
}

/**
 * The trend chart. `rows` is one row per calendar day of the window, ascending
 * and gap-filled (missing days carry zeroed totals); fewer than two rows is
 * nothing to chart and renders nothing — unless the window failed whole, which
 * is a fact a one-day window owes the reader just as much as a long one.
 * `rows` model keys and `colors` keys are normalized names (see model-colors);
 * `labels` optionally maps them back to a raw display spelling. A model outside
 * the color table draws in the neutral slate.
 */
export function TrendChart(props: {
  rows: ReadonlyArray<TrendRow>
  colors?: Map<string, string>
  labels?: Map<string, string>
  /** The window's own request failed, so the plot has no bars to draw. */
  allFailed?: boolean
  /**
   * The window is incomplete: some of its days never loaded, so the bars sum to
   * less than the window. The label must not call that sum the total.
   */
  partial?: boolean
}): ReactNode {
  const { rows, colors, labels, allFailed, partial } = props
  const [hovered, setHovered] = useState<number | undefined>(undefined)
  // A window that failed whole has nothing to chart: painting each of its buckets
  // as a failed stripe drew a wall of full-height hatch marks — 27 of them across
  // a six-month window — which reads as data rather than as an error. One notice
  // stands in for the plot instead; the stripes stay for a partial failure, where
  // they mark the gaps in an otherwise real chart.
  const rangeFailed = allFailed === true
  if (rows.length < 2) {
    // The guard below used to return before the notice, so a wholesale failure on
    // a one-day window rendered nothing at all: no bars, no sentence, no reason.
    if (!rangeFailed) {
      // A one-day window has nothing to compare, but returning nothing left the
      // card with a silent gap where the plot belongs: one sentence says why the
      // chart is missing instead of letting the reader guess.
      return (
        <div className={styles.trendWrap} data-dsh-part="trend-short">
          <span className={styles.muted}>{t('usage.trend.tooFewDays')}</span>
        </div>
      )
    }
    const only = rows[0]
    if (only === undefined) {
      return <div className={styles.trendWrap} data-dsh-part="trend-chart"><TrendFailedNotice /></div>
    }
    return (
      <div className={styles.trendWrap} data-dsh-part="trend-chart">
        <div className={styles.trendPlot} role="img" aria-label={t('usage.trend.labelFailed', { from: only.date, to: only.date })}>
          <TrendFailedNotice />
        </div>
      </div>
    )
  }
  const buckets = buildBuckets(rows, granularityOf(rows.length))
  const axisMax = niceCeil(Math.max(1, ...buckets.map((bucket) => totalOf(bucket.totals))))
  const labelStep = Math.max(1, Math.ceil(buckets.length / X_LABEL_MAX))
  const hoveredBucket = hovered !== undefined ? buckets[hovered] : undefined

  // Model mode: any bucket carrying a per-model split, with a color table to
  // draw it against. Otherwise the token-type stack keeps old hosts readable.
  const order = modelOrderOf(buckets)
  const modelMode = order.length > 0 && colors !== undefined && colors.size > 0
  const colorOf = (model: string): string => colors?.get(model) ?? MODEL_COLOR_OTHER
  const labelOf = (model: string): string => labels?.get(model) ?? model
  const legendEntries: Array<{ key: string; className?: string; color?: string; label: string }> = modelMode
    ? order.slice(0, LEGEND_MAX_MODELS).map((model) => ({ key: model, color: colorOf(model), label: labelOf(model) }))
    : [
        { key: 'cache', className: styles.trendSegCache, label: t('usage.tokens.cacheRead') },
        { key: 'input', className: styles.trendSegInput, label: t('usage.tokens.input') },
        { key: 'output', className: styles.trendSegOutput, label: t('usage.tokens.output') },
      ]

  // A failed bucket makes the sum meaningless: the label states the span and the
  // failure instead of a total nothing measured.
  const anyFailed = buckets.some((bucket) => bucket.failed)
  const chartFrom = buckets[0].from
  const chartTo = buckets[buckets.length - 1].to
  const chartTotal = buckets.reduce((sum, bucket) => sum + totalOf(bucket.totals), 0)

  return (
    <div className={styles.trendWrap} data-dsh-part="trend-chart">
      {/* The plot is one image to a screen reader, so it carries the role and the
          label. role="img" makes its whole subtree presentational, so the legend
          stays a sibling: wrapping it made the model names unreadable. */}
      <div
        className={styles.trendPlot}
        role="img"
        aria-label={anyFailed
          ? t('usage.trend.labelFailed', { from: chartFrom, to: chartTo })
          : partial === true
            // The bars only cover the days that arrived: saying "in total" here
            // would state a number the tile beside it refuses to state.
            ? t('usage.trend.labelPartial', { from: chartFrom, to: chartTo, tokens: formatTokens(chartTotal) })
            : t('usage.trend.label', { from: chartFrom, to: chartTo, tokens: formatTokens(chartTotal) })}
      >
        <div className={styles.trendYLabels} aria-hidden="true">
          {GRIDLINE_FRACTIONS.map((fraction) => (
            <span key={fraction} className={styles.trendYLabel} style={{ bottom: `${fraction * 100}%` }}>
              {formatTokens(fraction * axisMax)}
            </span>
          ))}
        </div>
        <div className={styles.trendArea}>
          {GRIDLINE_FRACTIONS.map((fraction) => (
            <span key={fraction} className={styles.trendGridline} style={{ bottom: `${fraction * 100}%` }} />
          ))}
          {rangeFailed
            ? <TrendFailedNotice />
            : (
              <div className={styles.trendBars} onMouseLeave={() => { setHovered(undefined) }}>
                {buckets.map((bucket, index) => {
                  const stack: Array<{ height: number; color?: string; className?: string }> = modelMode
                    ? stackHeights(order.map((model) => totalOf(bucket.models.get(model) ?? emptyTotals())), axisMax)
                        .map((height, at) => ({ height, color: colorOf(order[at]) }))
                    : (() => {
                        const tokens = tokenStack(bucket.totals)
                        return stackHeights(tokens.map((segment) => segment.value), axisMax)
                          .map((height, at) => ({ height, className: tokens[at].className }))
                      })()
                  const segments = stack.filter((segment) => segment.height > 0)
                  return (
                    <div
                      key={bucket.from}
                      className={styles.trendBar}
                      data-dsh-part="trend-bar"
                      data-recorded={bucket.recorded ? 'true' : 'false'}
                      data-failed={bucket.failed ? 'true' : 'false'}
                      onMouseEnter={() => { setHovered(index) }}
                    >
                      {segments.map((segment, at) => (
                        <span
                          key={at}
                          className={segment.className === undefined ? styles.trendSeg : `${styles.trendSeg} ${segment.className}`}
                          style={segment.color === undefined ? { height: `${segment.height}%` } : { height: `${segment.height}%`, background: segment.color }}
                        />
                      ))}
                    </div>
                  )
                })}
              </div>
            )}
          {hoveredBucket !== undefined && (
            <div
              className={styles.trendTooltip}
              data-dsh-part="trend-tooltip"
              style={tooltipStyle(hovered ?? 0, buckets.length, totalOf(hoveredBucket.totals), axisMax)}
            >
              <span className={styles.trendTooltipTitle}>
                {hoveredBucket.from === hoveredBucket.to ? hoveredBucket.from : `${hoveredBucket.from} ~ ${hoveredBucket.to}`}
              </span>
              {!hoveredBucket.recorded
                ? <span className={styles.trendTooltipLine}>{hoveredBucket.failed ? t('usage.range.loadFailed') : t('usage.range.noRecord')}</span>
                : (() => {
                    const hit = cacheHitPercent(hoveredBucket.totals)
                    const topModels = modelMode
                      ? order
                        .map((model) => ({ model, totals: hoveredBucket.models.get(model) }))
                        .filter((entry): entry is { model: string; totals: UsageTokenTotals } => entry.totals !== undefined && totalOf(entry.totals) > 0)
                        .slice(0, TOOLTIP_MAX_MODELS)
                      : []
                    return (
                      <>
                        <span className={styles.trendTooltipLine}>{t('usage.tokens.total')}: {formatTokens(totalOf(hoveredBucket.totals))}</span>
                        <span className={styles.trendTooltipLine}>{t('usage.calls', { n: hoveredBucket.totals.calls })}</span>
                        <span className={styles.trendTooltipLine}>{t('usage.tokens.cacheHit')}: {hit === undefined ? '—' : hit.toFixed(1) + '%'}</span>
                        {topModels.map((entry) => (
                          <span key={entry.model} className={styles.trendTooltipLine}>
                            <span className={styles.trendSwatch} style={{ background: colorOf(entry.model) }} /> {labelOf(entry.model)} · {formatTokens(totalOf(entry.totals))}
                          </span>
                        ))}
                      </>
                    )
                  })()}
            </div>
          )}
        </div>
      </div>
      <div className={styles.trendXLabels} aria-hidden="true">
        {buckets.map((bucket, index) => (
          <span
            key={bucket.from}
            className={styles.trendXLabel}
            style={{ left: `${((index + 0.5) / buckets.length) * 100}%` }}
          >
            {index === 0 || index === buckets.length - 1 || index % labelStep === 0 ? bucket.label : ''}
          </span>
        ))}
      </div>
      <div className={styles.trendLegend} data-dsh-part="trend-legend">
        {legendEntries.map((entry) => (
          <span key={entry.key} className={styles.trendLegendItem}>
            <span
              className={entry.className === undefined ? styles.trendSwatch : `${styles.trendSwatch} ${entry.className}`}
              style={entry.color === undefined ? undefined : { background: entry.color }}
            />
            {entry.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/** Pin the tooltip above its bar's top, flipping the anchor at the plot edges. */
function tooltipStyle(index: number, count: number, total: number, axisMax: number): CSSProperties {
  const leftPercent = ((index + 0.5) / count) * 100
  const transform = leftPercent < 12 ? 'translate(0, -100%)' : leftPercent > 88 ? 'translate(-100%, -100%)' : undefined
  return {
    left: `${leftPercent}%`,
    bottom: `${Math.min(100, Math.max(4, (total / axisMax) * 100 + 4))}%`,
    ...(transform === undefined ? {} : { transform }),
  }
}
