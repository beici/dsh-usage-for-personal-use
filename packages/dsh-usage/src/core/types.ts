/**
 * Wire-facing view types shared by the dsh-usage host service, its HTTP
 * routes, and the browser section. Everything here crosses the wire as JSON
 * and must stay provider-agnostic: provider quirks are normalized inside the
 * core adapters, never here.
 * @module @linxin666/dsh-usage/core/types
 */

/** One disjoint token bucket total, aggregated over calls (billed input = input + cacheRead + cacheWrite). */
export interface UsageTokenTotals {
  /** Uncached input tokens. */
  inputTokens: number
  /** Output tokens (reasoning included). */
  outputTokens: number
  /** Cache read tokens. */
  cacheReadTokens: number
  /** Cache write tokens. */
  cacheWriteTokens: number
  /** Reasoning tokens, when the provider reported them. */
  reasoningTokens: number
  /** Provider calls that reported usage. */
  calls: number
  /**
   * Spend estimate stamped at fold time, in the priced provider's billing
   * currency (currently DeepSeek official only, CNY); every other provider
   * stays 0 = unpriced, so the sum is never a mixed-currency total. Persisted
   * buckets recorded before a price-book change keep the old pricing.
   */
  cost: number
}

/** A zeroed totals bucket. */
export function emptyTotals(): UsageTokenTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0, cost: 0 }
}

/** Add `right` into `left` in place. */
export function addTotals(left: UsageTokenTotals, right: Readonly<UsageTokenTotals>): UsageTokenTotals {
  left.inputTokens += right.inputTokens
  left.outputTokens += right.outputTokens
  left.cacheReadTokens += right.cacheReadTokens
  left.cacheWriteTokens += right.cacheWriteTokens
  left.reasoningTokens += right.reasoningTokens
  left.calls += right.calls
  left.cost += right.cost
  return left
}

/** On-disk usage ledger: per local day, per provider route, per model. */
export interface UsageLedgerDocument {
  version: 1
  /** Local-date key `YYYY-MM-DD` → per-provider per-model totals. */
  days: Record<string, Record<string, Record<string, UsageTokenTotals>>>
}

/** One provider row of the day summary the overview serves. */
export interface UsageProviderSummary {
  provider: string
  totals: UsageTokenTotals
  /** Per-model breakdown, heaviest by total tokens first, capped by the route. */
  models: Array<{ model: string; totals: UsageTokenTotals }>
}

/** One day row of the trend the overview serves. */
export interface UsageDaySummary {
  date: string
  totals: UsageTokenTotals
}

/**
 * One local day aggregated per provider and model. The overview serves today
 * through this shape and the day route serves any retained day with it, so a
 * day the user picks in the browser and the live today card are the same
 * document.
 */
export interface UsageDayView {
  /** Local-date key `YYYY-MM-DD`. */
  date: string
  totals: UsageTokenTotals
  /** Per-provider rows, heaviest by total tokens first. */
  providers: UsageProviderSummary[]
}

/** The day route's response body. */
export interface UsageDayResponse {
  ok: true
  day: UsageDayView
}

/** A balance fact normalized from a provider probe. */
export interface BalanceView {
  /** ISO 4217 code the provider bills in (`CNY`, `USD`, ...). */
  currency: string
  /** Spendable total formatted for display (no currency symbol). */
  totalBalance: string
  /** Epoch ms of the successful probe. */
  updatedAt: number
}

/** One quota window of a coding plan. */
export interface PlanWindowView {
  /** Stable window key the UI localizes (`5h`, `week`, `month`, provider strings otherwise). */
  key: string
  /** Provider-supplied window name, when it sends one. */
  name?: string
  /** Used percent 0-100, when computable. */
  percent?: number
  /** ISO 8601 reset instant, when the provider reports one. */
  resetsAt?: string
}

/** A coding-plan quota fact normalized from a provider probe. */
export interface PlanView {
  /** Plan tier name, when the provider reports one. */
  planName?: string
  windows: PlanWindowView[]
  updatedAt: number
}

/** How the credential backing one provider route was resolved. */
export type CredentialKind = 'api-key' | 'env' | 'oauth' | 'none'

/** One aggregated usage window (the 30-day trend, or the whole retained ledger). */
export interface UsageWindowSummary {
  from: string
  to: string
  totals: UsageTokenTotals
  providers: UsageProviderSummary[]
}

/** Real spend observed from an official balance series rather than priced locally. */
export interface ObservedSpendView {
  /** Accrued spend in the account currency (CNY for the DeepSeek official watch). */
  cny: number
  /** Epoch ms of the first balance observation the accrual starts at. */
  since: number
}

/** One provider row of the overview snapshot. */
export interface ProviderSnapshotView {
  /** Provider route key (`deepseek`, `kimi-coding`, custom routes, ...). */
  provider: string
  /** Display name from the LLM runtime, else the adapter's, else the route key. */
  displayName: string
  credential: CredentialKind
  /** Whether any balance/plan adapter exists for this route. */
  supported: boolean
  /** A balance adapter exists for this route (the Usage tab's balance card). */
  balanceSupported?: boolean
  /** A coding-plan adapter exists for this route — the Plans tab lists these only. */
  planSupported?: boolean
  balance?: BalanceView
  plan?: PlanView
  /** Last probe failure, cleared on the next success. */
  error?: string
  updatedAt?: number
}

/** The overview the browser section renders. */
export interface UsageOverviewView {
  updatedAt: number
  providers: ProviderSnapshotView[]
  /** The provider the collapsed sidebar strip and the header highlight; `source` says how it was picked. */
  current: {
    provider?: string
    model?: string
    /** `live` — last request seen this boot; `default` — the agent default model. */
    source: 'live' | 'default'
    /**
     * Resolved display name (snapshot first, route-derived otherwise), so the
     * strip needs no name-resolution of its own. Optional so an older host
     * document still renders.
     */
    displayName?: string
    /**
     * Today's ledger totals for the provider's adapter family (the route
     * itself when adapter-less), carrying tokens, calls, and the priced cost.
     * Absent on a day without usage; optional for the same older-host
     * tolerance as displayName.
     */
    today?: UsageTokenTotals
  }
  usage: {
    today: UsageDayView
    /** Last N local days ascending, including today. */
    days: UsageDaySummary[]
    /**
     * Every retained local day that recorded usage, ascending — the day
     * picker's option list, reaching past the trend cap to the whole
     * retention window. Optional so an older host document still renders
     * (the section then offers no picker).
     */
    availableDays?: string[]
    /**
     * The same window aggregated per provider and model — the trend card's
     * bar-chart data. Optional so an older host document still renders.
     */
    range?: UsageWindowSummary
    /**
     * The whole retained ledger (up to `retainDays`, today included)
     * aggregated per provider — the voucher's minted total. Optional for the
     * same older-host tolerance as `range`.
     */
    all?: UsageWindowSummary
    /**
     * Real CNY spend of the official DeepSeek family, accrued from observed
     * decreases of the official balance (top-ups never count). Present once
     * a decrease has been observed; until then the section falls back to the
     * fold-time estimate.
     */
    observedSpend?: ObservedSpendView
    /**
     * Ledger files backing these totals: this device plus every peer whose
     * file is present. The panel lists them so a user can tell an import
     * landed (and see which machine the numbers came from). Optional so an
     * older host document still renders.
     */
    devices?: DeviceLedgerEntryView[]
    /** Stable id of the machine serving this overview; the export's key. */
    deviceId?: string
    /**
     * Peer files that could not be read or parsed. Present only on failure —
     * otherwise a corrupt peer file would look like a device that never had
     * usage. Optional for the same older-host tolerance as `range`.
     */
    devicesError?: string
    /**
     * Why this device's own ledger could not be loaded. Present only on
     * failure: an unreadable file is never overwritten and a corrupt one is
     * moved aside, so the panel has to say so or the totals would just look
     * empty. Optional for the same older-host tolerance as `range`.
     */
    ledgerError?: string
  }
}

/**
 * One ledger file as the panel reports it: the numbers are counted once, so
 * this is a source list and a health signal, not a merge policy.
 */
export interface DeviceLedgerEntryView {
  deviceId: string
  /** `local` = written by this machine; `peer` = read-only file that was imported or dropped in. */
  role: 'local' | 'peer'
}

/**
 * Portable ledger export: a device id plus that device's own history.
 *
 * The envelope is self-describing because the device id is what names the file
 * on the receiving side — a bare `{ version, days }` cannot say whose numbers
 * it holds, and guessing from a pasted file name would let a rename overwrite
 * another device's history.
 */
export interface UsageLedgerExport {
  schema: 'dsh-usage-ledger'
  version: 1
  deviceId: string
  exportedAt: string
  ledger: UsageLedgerDocument
}

/**
 * One window-aggregate query answered from the merged ledger: the summary the
 * breakdown card renders, plus the per-day series the trend chart buckets.
 * `series` lists every recorded day in `[from, to]` ascending — days the
 * ledger pruned or never recorded are absent, and the chart renders those as
 * empty slots rather than pretending they were zero-cost. Each row carries
 * the day's per-model split (aggregated across providers) when the serving
 * host computes it, so the chart can stack by model; optional so an older
 * host document still renders (the chart then falls back to token-type
 * stacking).
 */
export interface UsageRangeResponse {
  ok: true
  from: string
  to: string
  totals: UsageTokenTotals
  providers: UsageProviderSummary[]
  series: Array<{ date: string; totals: UsageTokenTotals; models?: Record<string, UsageTokenTotals> }>
}

/**
 * Host-side snapshot state: the wire view plus one error slot per probed
 * fact. A probe half only clears its own slot, so a plan success can no
 * longer mask a failing balance probe (and vice versa); the overview
 * collapses them into the single wire `error` line, balance first.
 */
export interface ProviderSnapshotState extends ProviderSnapshotView {
  /** Last balance-probe failure; cleared on the next balance success. */
  balanceError?: string
  /** Last plan-probe failure; cleared on the next plan success. */
  planError?: string
}
