/**
 * The usage ledger: a pure fold from session usage facts into a per-day,
 * per-provider, per-model totals document, plus its JSON serialization.
 * Host-side state lives only in the document; the service owns persistence.
 * @module @linxin666/dsh-usage/core/ledger
 */

import { addTotals, emptyTotals, type UsageLedgerDocument, type UsageProviderSummary, type UsageTokenTotals } from './types.ts'

/** Local-date key (`YYYY-MM-DD`) for an epoch ms timestamp. */
export function localDateKey(ms: number): string {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Whether `key` is a real local-date key (`YYYY-MM-DD`). The shape check is
 * round-tripped: an impossible date (9999-99-99) parses to NaN and a rollover
 * (2026-02-30) lands on another day, so both would otherwise fold into a bogus,
 * never-pruned bucket. Shared by the persisted-document reader and the day
 * route's query gate.
 */
export function isLedgerDateKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false
  const atMs = new Date(key + 'T12:00:00').getTime()
  return Number.isFinite(atMs) && localDateKey(atMs) === key
}

/** An empty ledger document. */
export function createLedgerDocument(): UsageLedgerDocument {
  return { version: 1, days: {} }
}

/**
 * Bucket keys come from untrusted directions (persisted JSON, provider and
 * model ids out of session events), so they must never collide with
 * `Object.prototype` plumbing: assigning `day['__proto__']` or reading
 * `day['constructor']` would pollute every object in the host process.
 */
function isSafeBucketKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

/**
 * Fold one usage report into the ledger in place. `provider` is the route key
 * and `model` the provider-owned model id the step ran under. Reports keyed
 * by prototype-plumbing names are dropped.
 */
export function foldUsage(
  doc: UsageLedgerDocument,
  atMs: number,
  provider: string,
  model: string,
  usage: Readonly<UsageTokenTotals>,
): void {
  if (!isSafeBucketKey(provider) || !isSafeBucketKey(model)) return
  if (usage.calls <= 0 && usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens <= 0) return
  const dayKey = localDateKey(atMs)
  const day = doc.days[dayKey] ?? {}
  const models = day[provider] ?? {}
  const totals = models[model] ?? emptyTotals()
  addTotals(totals, usage)
  models[model] = totals
  day[provider] = models
  doc.days[dayKey] = day
}

/**
 * Sum every bucket of `source` into `target`, in place.
 *
 * Distinct from a re-load of the SAME document: two devices that each ran a
 * model on one shared account did both spend those tokens, so their ledgers
 * add. `foldUsage` is the primitive because a bucket sum is exactly what it
 * does; the day key comes from the stored date, so a peer's timestamps never
 * leak into the local clock.
 */
export function mergeLedgerSum(target: UsageLedgerDocument, source: Readonly<UsageLedgerDocument>): void {
  for (const [dayKey, providers] of Object.entries(source.days)) {
    if (!isLedgerDateKey(dayKey)) continue
    const atMs = new Date(dayKey + 'T12:00:00').getTime()
    if (!Number.isFinite(atMs)) continue
    for (const [provider, models] of Object.entries(providers)) {
      if (typeof models !== 'object' || models === null) continue
      for (const [model, totals] of Object.entries(models)) {
        if (typeof totals !== 'object' || totals === null) continue
        foldUsage(target, atMs, provider, model, totals)
      }
    }
  }
}

/** Total tokens of a bucket (billed input + output; reasoning is inside output). */
export function totalTokens(totals: Readonly<UsageTokenTotals>): number {
  return totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens
}

/**
 * Merge `source` into `target`, keeping the larger total of each bucket.
 *
 * The right rule when two processes on ONE machine write the same ledger file:
 * both observe a subset of the same calls, so a bucket sum would count the
 * calls both of them saw twice, while the larger bucket is the more complete
 * view of that day. (Peer devices are the opposite case — see mergeLedgerSum.)
 */
export function mergeLedgerMax(target: UsageLedgerDocument, source: Readonly<UsageLedgerDocument>): void {
  for (const [dayKey, providers] of Object.entries(source.days)) {
    if (!isLedgerDateKey(dayKey)) continue
    if (typeof providers !== 'object' || providers === null) continue
    for (const [provider, models] of Object.entries(providers)) {
      if (!isSafeBucketKey(provider) || typeof models !== 'object' || models === null) continue
      for (const [model, totals] of Object.entries(models)) {
        if (!isSafeBucketKey(model) || typeof totals !== 'object' || totals === null) continue
        const bucket = target.days[dayKey]?.[provider]?.[model]
        if (bucket !== undefined && totalTokens(bucket) >= totalTokens(totals)) continue
        const day = target.days[dayKey] ?? (target.days[dayKey] = {})
        const route = day[provider] ?? (day[provider] = {})
        route[model] = { ...totals }
      }
    }
  }
}

/**
 * `bucket` minus `extra`, floored at zero per field.
 *
 * Only used by the one-time duplicate-replay repair, where `extra` is a copy
 * that was folded twice. `cost` comes back as 0 because the caller reprices
 * the shrunken bucket from its tokens — a stored cost cannot be split.
 */
export function subtractTotals(bucket: Readonly<UsageTokenTotals>, extra: Readonly<UsageTokenTotals>): UsageTokenTotals {
  const cut = (value: number, by: number): number => Math.max(0, value - by)
  return {
    inputTokens: cut(bucket.inputTokens, extra.inputTokens),
    outputTokens: cut(bucket.outputTokens, extra.outputTokens),
    cacheReadTokens: cut(bucket.cacheReadTokens, extra.cacheReadTokens),
    cacheWriteTokens: cut(bucket.cacheWriteTokens, extra.cacheWriteTokens),
    reasoningTokens: cut(bucket.reasoningTokens, extra.reasoningTokens),
    calls: cut(bucket.calls, extra.calls),
    cost: 0,
  }
}

/**
 * Add `current`'s growth since `baseline` onto `target`, per bucket.
 *
 * The write path of one process that shares its ledger file with another: the
 * file already holds what both of them counted up to their last writes, so only
 * the calls folded since our own last write may be added. Growth is floored at
 * zero, so a bucket that shrank (a repair, a prune) never subtracts from the
 * other process's numbers.
 */
export function mergeLedgerDelta(
  target: UsageLedgerDocument,
  current: Readonly<UsageLedgerDocument>,
  baseline: Readonly<UsageLedgerDocument>,
): void {
  for (const [dayKey, providers] of Object.entries(current.days)) {
    if (!isLedgerDateKey(dayKey)) continue
    if (typeof providers !== 'object' || providers === null) continue
    for (const [provider, models] of Object.entries(providers)) {
      if (!isSafeBucketKey(provider) || typeof models !== 'object' || models === null) continue
      for (const [model, totals] of Object.entries(models)) {
        if (!isSafeBucketKey(model) || typeof totals !== 'object' || totals === null) continue
        const base = baseline.days[dayKey]?.[provider]?.[model]
        const grow = (now: number, then: number): number => Math.max(0, now - then)
        const delta: UsageTokenTotals = {
          inputTokens: grow(totals.inputTokens, base?.inputTokens ?? 0),
          outputTokens: grow(totals.outputTokens, base?.outputTokens ?? 0),
          cacheReadTokens: grow(totals.cacheReadTokens, base?.cacheReadTokens ?? 0),
          cacheWriteTokens: grow(totals.cacheWriteTokens, base?.cacheWriteTokens ?? 0),
          reasoningTokens: grow(totals.reasoningTokens, base?.reasoningTokens ?? 0),
          calls: grow(totals.calls, base?.calls ?? 0),
          cost: grow(totals.cost, base?.cost ?? 0),
        }
        if (delta.calls === 0 && totalTokens(delta) === 0 && delta.cost === 0) continue
        const atMs = new Date(dayKey + 'T12:00:00').getTime()
        if (!Number.isFinite(atMs)) continue
        foldUsage(target, atMs, provider, model, delta)
      }
    }
  }
}

/** How many model rows one summarized provider keeps. */
export const SUMMARY_MODEL_CAP = 12

/**
 * Aggregate whole per-day maps (each `provider -> model -> totals`) into the
 * per-provider/per-model summary the overview serves for one day or a range:
 * disjoint bucket sums per provider, per-model rows heaviest first, and the
 * grand total. Pure: reads its inputs, allocates fresh buckets.
 */
export function summarizeDays(days: ReadonlyArray<Record<string, Record<string, UsageTokenTotals>>>): {
  totals: UsageTokenTotals
  providers: UsageProviderSummary[]
} {
  const merged = new Map<string, Map<string, UsageTokenTotals>>()
  for (const day of days) {
    for (const [provider, models] of Object.entries(day)) {
      if (!isSafeBucketKey(provider) || typeof models !== 'object' || models === null) continue
      let modelMap = merged.get(provider)
      if (modelMap === undefined) {
        modelMap = new Map()
        merged.set(provider, modelMap)
      }
      for (const [model, totals] of Object.entries(models)) {
        if (typeof totals !== 'object' || totals === null) continue
        const bucket = modelMap.get(model) ?? emptyTotals()
        addTotals(bucket, totals)
        modelMap.set(model, bucket)
      }
    }
  }
  const providers: UsageProviderSummary[] = []
  const totals = emptyTotals()
  for (const [provider, modelMap] of merged) {
    const providerTotals = emptyTotals()
    const modelRows = [...modelMap].map(([model, modelTotals]) => ({ model, totals: modelTotals }))
    for (const row of modelRows) addTotals(providerTotals, row.totals)
    modelRows.sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals))
    providers.push({ provider, totals: providerTotals, models: modelRows.slice(0, SUMMARY_MODEL_CAP) })
  }
  providers.sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals))
  for (const row of providers) addTotals(totals, row.totals)
  return { totals, providers }
}

/** All local-date keys in the ledger, ascending. */
export function ledgerDayKeys(doc: Readonly<UsageLedgerDocument>): string[] {
  return Object.keys(doc.days).sort()
}

/**
 * Drop every day older than `retainDays` local days before `todayKey`, in
 * place. Returns the number of pruned days.
 */
export function pruneLedger(doc: UsageLedgerDocument, todayKey: string, retainDays: number): number {
  const cutoff = new Date(todayKey + 'T00:00:00')
  cutoff.setDate(cutoff.getDate() - retainDays)
  const cutoffKey = localDateKey(cutoff.getTime())
  let pruned = 0
  for (const key of Object.keys(doc.days)) {
    if (key < cutoffKey) {
      delete doc.days[key]
      pruned += 1
    }
  }
  return pruned
}

function reviveTotals(value: unknown): UsageTokenTotals | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const source = value as Record<string, unknown>
  const num = (key: string): number => typeof source[key] === 'number' && Number.isFinite(source[key]) ? source[key] : 0
  return {
    inputTokens: num('inputTokens'),
    outputTokens: num('outputTokens'),
    cacheReadTokens: num('cacheReadTokens'),
    cacheWriteTokens: num('cacheWriteTokens'),
    reasoningTokens: num('reasoningTokens'),
    calls: num('calls'),
    cost: num('cost'),
  }
}

/**
 * Parse a ledger document from untrusted JSON: unknown shapes resolve to an
 * empty document, malformed entries are dropped, numbers are coerced to
 * finite values. Never throws.
 */
export function deserializeLedger(value: unknown): UsageLedgerDocument {
  const doc = createLedgerDocument()
  if (typeof value !== 'object' || value === null) return doc
  const days = (value as Record<string, unknown>).days
  if (typeof days !== 'object' || days === null) return doc
  for (const [dateKey, providers] of Object.entries(days as Record<string, unknown>)) {
    if (!isLedgerDateKey(dateKey) || typeof providers !== 'object' || providers === null) continue
    const atMs = new Date(dateKey + 'T12:00:00').getTime()
    for (const [provider, models] of Object.entries(providers as Record<string, unknown>)) {
      if (typeof models !== 'object' || models === null) continue
      for (const [model, totals] of Object.entries(models as Record<string, unknown>)) {
        const revived = reviveTotals(totals)
        if (revived !== undefined) foldUsage(doc, atMs, provider, model, revived)
      }
    }
  }
  return doc
}
