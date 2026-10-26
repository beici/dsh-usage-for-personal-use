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
import { type ReactNode } from 'react';
import { type UsageTokenTotals } from '../core/types.ts';
/** One calendar day of the window: totals plus the per-model split when known. */
export interface TrendRow {
    /** Local-date key `YYYY-MM-DD`. */
    date: string;
    totals: UsageTokenTotals;
    /** Per-model totals aggregated across providers, when the data carries them. */
    models?: Record<string, UsageTokenTotals>;
    /**
     * The day's fetch failed, so its totals are unknown rather than zero. The
     * chart must not paint "no usage recorded" over a request that never landed.
     */
    failed?: boolean;
}
/**
 * The trend chart. `rows` is one row per calendar day of the window, ascending
 * and gap-filled (missing days carry zeroed totals); fewer than two rows is
 * nothing to chart and renders nothing. `rows` model keys and `colors` keys
 * are normalized names (see model-colors); `labels` optionally maps them back
 * to a raw display spelling. A model outside the color table draws in the
 * neutral slate.
 */
export declare function TrendChart(props: {
    rows: ReadonlyArray<TrendRow>;
    colors?: Map<string, string>;
    labels?: Map<string, string>;
    /** The window's own request failed, so the plot has no bars to draw. */
    allFailed?: boolean;
}): ReactNode;
