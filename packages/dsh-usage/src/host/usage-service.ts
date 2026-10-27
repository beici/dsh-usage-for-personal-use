/**
 * The dsh-usage host service: folds live session usage into the persistent
 * ledger, probes each configured provider's balance/coding-plan endpoint on
 * a poll cycle, and serves the current provider's strip-ready view inside
 * the overview document. Secrets stay in the host process; the browser only
 * ever sees the overview document.
 * @module @linxin666/dsh-usage/host/usage-service
 */

import { mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { dshHome } from '../dsh-home.ts'
import { withIdentityEncoding } from './http.ts'
import { adapterFor, balanceAppliesToRoute, isDeepSeekProviderRoute, providerErrorMessage } from '../core/adapters.ts'
import type { BalanceParse, PlanParse } from '../core/adapters.ts'
import { foldAliasRoutes } from '../core/provider-routes.ts'
import { deepseekModelSpend } from '../core/pricing.ts'
import { countPrunable, createLedgerDocument, deserializeLedger, deserializeLedgerStrict, foldUsage, ledgerDayKeys, localDateKey, MAX_LEDGER_COUNTER, maxTotals, mergeLedgerDelta, mergeLedgerMax, mergeLedgerSum, pruneLedger, subtractTotals, summarizeDays, totalTokens } from '../core/ledger.ts'
import { deviceIdOfFile, ensureMachineId, isDeviceId, ledgerFileDocument, LEGACY_LEDGER_FILE, ledgerFileName, localDeviceId, localMachineId, MACHINE_ID_FILE, parsePeerLedger, readMachineAliases, rememberMachineAlias } from './device-ledger.ts'
import type { LoadedLedgerFile } from './device-ledger.ts'
import { SESSION_LOG_MAX_FILES, collectSessionLogUsage } from './session-log-backfill.ts'
import type { BalanceView, CredentialKind, DeviceLedgerEntryView, ObservedSpendView, PlanView, ProviderSnapshotState, ProviderSnapshotView, UsageDayView, UsageLedgerDocument, UsageLedgerExport, UsageOverviewView, UsageRangeResponse, UsageTokenTotals } from '../core/types.ts'
import { addTotals, emptyTotals } from '../core/types.ts'

/**
 * Persisted accrual state for the official DeepSeek family's real spend:
 * consecutive observations of the official CNY balance, decreases counted
 * as spent (a rise is a top-up and never accrues). `since` is the first
 * observation; the ledger keeps no such fact, so this watch is the only
 * source of the voucher's observed-spend figure.
 */
export interface SpendWatch {
  /** Total observed decrease since `since`, in CNY. */
  accruedCny: number
  /** Epoch ms of the first balance observation. */
  since: number
  /** The balance the previous observation ended on, when one exists. */
  lastBalanceCny?: number
}

/** Per-route credential fact the probes run against. */
interface ResolvedCredential {
  kind: CredentialKind
  /** The probe secret: an API key, or an OAuth access token for oauth-aware adapters. */
  key?: string
  /** Provider account id riding a dedicated header, when the credential carries one. */
  accountId?: string
}

/** One LLM provider route the service knows about. */
interface ProviderRoute {
  id: string
  displayName: string
  /** Whether the LLM runtime serves requests on this route; a catalog-only entry is dormant. */
  live: boolean
}

/** Poll-loop options; re-applied live on settings change. */
export interface UsageServiceOptions {
  pollIntervalSec: number
  retainDays: number
}

/** One day bucket a duplicate copy was folded into, and the totals that copy added. */
interface DuplicateBucket {
  dayKey: string
  provider: string
  model: string
  totals: UsageTokenTotals
}

/** A duplicate bucket after the repair: what the day keeps once the copies go. */
interface RepairBucket extends DuplicateBucket {
  /** The deduped replay's own total for this bucket. */
  clean: UsageTokenTotals
  /** What the repair leaves in the bucket; never subtracted below on a later start. */
  after: UsageTokenTotals
}

/** What one transcript replay produced: the deduped document and the copies it dropped. */
interface ReplayPass {
  doc: UsageLedgerDocument
  /**
   * The same document before the window was applied.
   *
   * `doc` is what may be merged back into the ledger, but the repair has to
   * judge a bucket against the replay's own total — including for days the
   * window would drop, which are still on disk and still served. Reading the
   * windowed copy there made the "truth" for such a day zero, and the repair
   * then subtracted the whole bucket (0 calls, 0 tokens written down).
   */
  fullDoc: UsageLedgerDocument
  duplicates: Map<string, DuplicateBucket>
  /** Transcripts found on disk, and how many of them the pass actually read. */
  files: number
  replayed: number
  /** Transcripts the per-start cap left out (oldest first). */
  skipped: number
}

/** The repair as applied in memory: what to write over the file, and what it removed. */
interface RepairResult {
  buckets: number
  removedTokens: number
  repaired: Map<string, RepairBucket>
  /**
   * Buckets holding *fewer* calls than the duplicate-free replay.
   *
   * Nothing is subtracted from those — there is nothing extra in them — but the
   * ledger is missing calls the transcripts recorded, and that is worth saying
   * once. It is the one direction the panel can state without guessing.
   */
  short: number
}

/** What the repair actually wrote: only the buckets it really corrected. */
interface RepairWriteResult {
  corrected: Map<string, UsageTokenTotals>
  removedTokens: number
}

/**
 * The retention bookkeeping a prune moves before its bytes reach the disk.
 *
 * A failed write has to put all four back: the panel would otherwise report days
 * as pruned while they are still in memory, and `shrankTo` is exactly what makes
 * the next prune treat a shrink as a shrink.
 */
interface RetentionSnapshot {
  seen: number
  shrankTo: number | undefined
  refused: boolean
  note: string | undefined
  jumpNote: string | undefined
}

/**
 * The bucket for one route inside one day, matched loosely.
 *
 * Provider and model spellings arrive from two places that do not agree: the
 * transcript records and the persisted ledger. An exact lookup misses a bucket
 * whose name drifted (`WorkBuddy` vs `workbuddy`), and the repair would then
 * skip it while the replay adds a second bucket beside it — one day, two rows,
 * and the copies stay counted.
 */
function findLedgerBucket(
  day: Record<string, Record<string, UsageTokenTotals>> | undefined,
  provider: string,
  model: string,
): { provider: string; model: string; totals: UsageTokenTotals } | undefined {
  if (day === undefined) return undefined
  const exact = day[provider]?.[model]
  if (exact !== undefined) return { provider, model, totals: exact }
  const wantProvider = provider.trim().toLowerCase()
  const wantModel = model.trim().toLowerCase()
  for (const [name, models] of Object.entries(day)) {
    if (name.trim().toLowerCase() !== wantProvider) continue
    for (const [label, totals] of Object.entries(models)) {
      if (label.trim().toLowerCase() === wantModel) return { provider: name, model: label, totals }
    }
  }
  return undefined
}

/**
 * Max-merge another document into `target`, matching buckets loosely.
 *
 * `mergeLedgerMax` keys on the exact spelling, and a copy written by an older
 * build spells the same route differently ("Buddy" where this build writes
 * "buddy"). The fold then added a second bucket for the same calls, so a
 * same-machine copy doubled the day: the repair, the clamp and the replay all
 * match loosely, and this merge has to as well.
 */
function mergeLedgerMaxFolded(target: UsageLedgerDocument, source: UsageLedgerDocument): void {
  for (const [dayKey, providers] of Object.entries(source.days)) {
    const day = target.days[dayKey] ?? {}
    target.days[dayKey] = day
    for (const [provider, models] of Object.entries(providers)) {
      for (const [model, bucket] of Object.entries(models)) {
        const existing = findLedgerBucket(day, provider, model)
        if (existing === undefined) {
          day[provider] = { ...(day[provider] ?? {}), [model]: structuredClone(bucket) }
          continue
        }
        const into = existing.totals
        into.calls = Math.max(into.calls, bucket.calls)
        into.inputTokens = Math.max(into.inputTokens, bucket.inputTokens)
        into.outputTokens = Math.max(into.outputTokens, bucket.outputTokens)
        into.cacheReadTokens = Math.max(into.cacheReadTokens, bucket.cacheReadTokens)
        into.cacheWriteTokens = Math.max(into.cacheWriteTokens, bucket.cacheWriteTokens)
        into.reasoningTokens = Math.max(into.reasoningTokens, bucket.reasoningTokens)
        into.cost = Math.max(into.cost, bucket.cost)
      }
    }
  }
}

/**
 * How many whole copies of `copy` a bucket holds on top of `clean`.
 *
 * A single boot of the old build folded one transcript twice, but every later
 * boot folded it again: a bucket inflated over three starts holds three copies,
 * and the replay only ever sees the one duplicate it finds inside the current
 * pass. So the difference has to be a whole number of copies of that duplicate
 * for the arithmetic to be the repair and not a guess — anything else (a real
 * call that landed after the copies, a provider that renamed itself) answers
 * undefined and is left alone.
 *
 * Fields are checked one by one rather than as a sum: a bucket whose calls
 * match by coincidence but whose tokens do not is not a copy set.
 */
function repairCopies(
  bucket: UsageTokenTotals,
  clean: UsageTokenTotals,
  copy: UsageTokenTotals,
): number | undefined {
  if (copy.calls <= 0) return undefined
  const extra = bucket.calls - clean.calls
  if (extra <= 0 || extra % copy.calls !== 0) return undefined
  const copies = extra / copy.calls
  const fields: Array<keyof UsageTokenTotals> = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
  ]
  for (const field of fields) {
    if (bucket[field] - clean[field] !== copy[field] * copies) return undefined
  }
  return copies
}

/**
 * Marker key for one bucket: the day, the route and the model it belongs to.
 *
 * The route id and the model name reach this file from two places — the ledger
 * carries the spelling the client wrote, the replay carries the transcript's — and
 * they differ in case often enough that the floor filed under one spelling was
 * invisible to the next start. The guard then degraded from "this bucket is still
 * at the repaired total" to "exactly one copy above the clean total", which is the
 * case it exists to catch.
 */
function repairKey(dayKey: string, provider: string, model: string): string {
  return `${dayKey}\u0000${provider.trim().toLowerCase()}\u0000${model.trim().toLowerCase()}`
}

/**
 * How many corrected buckets the repair record carries.
 *
 * The record only has to say which buckets were already judged — a bucket it
 * does not name is judged again, which is the safe direction. A cap keeps a
 * ledger with a very wide window from writing a record that grows without
 * bound: the oldest keys are dropped first, and those are the buckets whose days
 * are about to leave the window anyway.
 */
const REPAIR_CORRECTED_MAX = 5000

/** How many notes the ledger line carries, and which ones never get dropped. */
const LEDGER_NOTE_MAX = 5
/**
 * Notes that report history going missing or a write being refused. These are
 * never pushed off the line by routine ones: the line holds five, and with a
 * handful of peer files the oldest entry is exactly the sentence that says a
 * transcript was not replayed or that a correction was not written.
 */
const LEDGER_NOTE_ALWAYS = [
  'ledger-dropped',
  'ledger-unreadable',
  'legacy-unreadable',
  'legacy-restore',
  'legacy-locked',
  'replay-cap',
  'repair-skipped',
  'repair-short',
  'repair-lock',
  'retention-jump',
  'ledger-foreign',
  'stale-writer',
] as const

/**
 * How many entries of a written ledger the reader had to leave out.
 *
 * `deserializeLedger` is deliberately forgiving: an impossible day key, a day
 * that is not an object, a counter that is a string or a negative number — each
 * one is dropped or clamped rather than failing the whole document, because one
 * bad entry must not cost the user every other day. But a document that loses
 * entries and is then written back by the next flush loses them for good, so the
 * count is what lets the panel say it happened.
 */
/** The counters a bucket is made of, in the order the reader revives them. */
const COUNTER_FIELDS = [
  'calls',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'cost',
] as const

function countUnreadableEntries(rawDays: Record<string, unknown>, doc: UsageLedgerDocument): number {
  let dropped = 0
  for (const [dayKey, dayValue] of Object.entries(rawDays)) {
    const parsedDay = doc.days[dayKey]
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || parsedDay === undefined) {
      dropped += 1
      continue
    }
    if (!isPlainObject(dayValue)) {
      dropped += 1
      continue
    }
    for (const [provider, models] of Object.entries(dayValue as Record<string, unknown>)) {
      if (!isPlainObject(models)) {
        dropped += 1
        continue
      }
      for (const [model, modelValue] of Object.entries(models as Record<string, unknown>)) {
        if (parsedDay[provider]?.[model] === undefined) {
          dropped += 1
          continue
        }
        // A counter that is a string, a negative number or Infinity is read as
        // zero by `reviveTotals` — the call count is gone, and the next flush
        // writes the zero down. Counting it here is what makes the panel say so
        // instead of the history shrinking in silence.
        if (!isPlainObject(modelValue)) continue
        for (const field of COUNTER_FIELDS) {
          const value = (modelValue as Record<string, unknown>)[field]
          if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_LEDGER_COUNTER)) {
            dropped += 1
            break
          }
        }
      }
    }
  }
  return dropped
}

/**
 * The device a ledger document claims to belong to, when that device is not
 * this machine.
 *
 * A document naming another device is not a corrupt local ledger: it is that
 * device's export, or a copy of its file, put down on the local path by a
 * restore. Quarantining it as `.corrupt-` would look exactly like lost history,
 * so the caller adopts it under its own device's file name instead — where the
 * peer scan already knows how to count it, once.
 */
function foreignDeviceOf(error: string): string | undefined {
  const match = /^names device (.+)$/.exec(error)
  if (match === null) return undefined
  const claimed = match[1]!.trim()
  if (!isDeviceId(claimed)) return undefined
  return claimed === localDeviceId() ? undefined : claimed
}

/**
 * `JSON.parse` for a document that came from disk.
 *
 * A UTF-8 BOM is what any Windows editor adds on re-save, and `JSON.parse`
 * rejects it as a syntax error. Only the import path stripped it, so a ledger
 * re-saved by hand (or a peer file copied through an editor) read as corrupt:
 * the local one was quarantined and the panel showed an empty history. Every
 * document read from disk goes through here instead.
 */
function parseJsonText(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
}

/** Probe timeout per HTTP call. */
const PROBE_TIMEOUT_MS = 10_000

/** Ledger flush debounce. */
const FLUSH_DEBOUNCE_MS = 3_000

/**
 * Sidecar marker for the one-time duplicate-replay repair. Its presence means
 * the correction ran on this machine; the repair subtracts exactly the extra
 * copies, so running it twice would take real calls away.
 */
const DEDUPE_MARKER_FILE = 'usage-dedupe-marker.json'

/** How long a failed ledger read waits before trying again. */
const LOAD_RETRY_MS = 20_000

/** How many times a failed ledger read is retried before the boot gives up on persisting. */
const LOAD_RETRY_MAX = 5

/**
 * How many times a flush tries to take the ledger lock before giving up.
 *
 * The budget has to outlast a *live* holder's critical section, not just a few
 * scheduler ticks: a flush that gives up early either writes without the lock
 * (and can drop the other writer's calls) or stalls the ledger. 40 × 100 ms is
 * four seconds — longer than any measured write, shorter than `LOCK_STALE_MS`.
 */
const LOCK_ATTEMPTS = 40

/** How long one flush waits between lock attempts. */
const LOCK_RETRY_MS = 100

/**
 * Age after which a lock file is assumed to be left behind by a crash.
 *
 * A flush takes milliseconds, so a second is far too short to tell a crashed
 * holder from a live one: measured on Windows a second process could delete the
 * lock while the first was still inside the critical section. Fifteen seconds
 * is longer than any write, and a crash still clears after that.
 */
const LOCK_STALE_MS = 15_000

/** How many trend days the overview serves. */
const TREND_DAYS = 30

/** How many distinct note kinds the panel's line keeps in memory. */
const NOTE_MAX = 24

/** `schema` tag carried by an export envelope, so an import can tell it apart from a bare ledger. */
const LEDGER_EXPORT_SCHEMA = 'dsh-usage-ledger'

/** Largest import body accepted; a ledger of one device's history stays far below this. */
const IMPORT_MAX_BYTES = 8 * 1024 * 1024

/**
 * A rejected import, distinguished from an I/O failure so the route can answer
 * 400 for "that file is not a ledger" and 500 for "the disk refused".
 */
export class UsageImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageImportError'
  }
}

/** Best-effort typed service read: absent services resolve to undefined at runtime. */
function service<T>(ctx: Context, name: string): T | undefined {
  try {
    return (ctx as unknown as { get(name: string): unknown }).get(name) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * Read a totals-shaped value back from JSON, or undefined when it is not one.
 *
 * Used for the repair marker, which is written by this code but must never be
 * trusted blindly: a hand-edited or truncated marker would otherwise seed the
 * repair's floor with garbage and skew the subtraction.
 */
function readTotals(value: unknown): UsageTokenTotals | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const num = (key: string): number => (typeof record[key] === 'number' && Number.isFinite(record[key] as number) ? (record[key] as number) : 0)
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
 * Read the persisted spend watch back, or undefined when it is not usable.
 *
 * Strict on purpose: the watch is an accrual the user reads as real money, so a
 * damaged value is dropped rather than half-trusted.
 */
function readSpendWatch(value: unknown): SpendWatch | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const watch = value as Record<string, unknown>
  if (typeof watch.accruedCny !== 'number' || !Number.isFinite(watch.accruedCny) || watch.accruedCny < 0) return undefined
  if (typeof watch.since !== 'number' || !Number.isFinite(watch.since) || watch.since <= 0) return undefined
  return {
    accruedCny: watch.accruedCny,
    since: watch.since,
    ...(typeof watch.lastBalanceCny === 'number' && Number.isFinite(watch.lastBalanceCny) ? { lastBalanceCny: watch.lastBalanceCny } : {}),
  }
}

/**
 * Atomic JSON write through a unique temp file + fsync + rename. The temp
 * name carries a per-call sequence number as well as pid and clock: two writes
 * in the same millisecond would otherwise share a temp path and interleave into
 * one file, which is exactly the corruption the rename is meant to prevent.
 */
let writeSequence = 0
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  writeSequence += 1
  const temp = `${path}.${process.pid}.${Date.now()}.${writeSequence}.tmp`
  try {
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(JSON.stringify(value, null, 1), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

function unwrapVolatiles(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'object') {
    if (typeof (value as { get?: unknown }).get === 'function') {
      return unwrapVolatiles((value as { get(): unknown }).get())
    }
    if (Array.isArray(value)) {
      return value.map(unwrapVolatiles)
    }
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      result[k] = unwrapVolatiles(v)
    }
    return result
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The ledger document a pre-migration file carries, or `undefined` when the file
 * is not one.
 *
 * `deserializeLedger` never throws: a file whose `days` is an array, a string, or
 * an export envelope around the real document all come back as an empty ledger.
 * Adopting that would write an empty device file and then retire the only copy of
 * the history as `.migrated`, so the shape is checked before the read is trusted.
 */
function legacyDocumentOf(value: unknown): UsageLedgerDocument | undefined {
  if (!isPlainObject(value)) return undefined
  if (isPlainObject(value.days)) return value as unknown as UsageLedgerDocument
  if (isPlainObject(value.ledger)) return legacyDocumentOf(value.ledger)
  return undefined
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch !== undefined ? patch : base
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    result[key] = isPlainObject(value) && isPlainObject(result[key]) ? deepMerge(result[key], value) : value
  }
  return result
}

/**
 * Read a foreign settings namespace's resolved value (the llm adapter
 * profiles, the agent default model). Resolves across pre-0.1.7 settings.get(),
 * 0.1.7 SettingsForms.describe(), live loader entries, and configEditor.
 * Unregistered namespaces read as undefined; nothing here throws into the poll loop.
 */
function readNamespace(ctx: Context, ns: string): unknown {
  try {
    // 1. Try legacy settings.get(ns) or 0.1.7 settings.describe()
    const settings = service<{
      get?(ns: unknown): unknown
      describe?(options?: unknown): Array<{ ns: string; value: unknown }>
    }>(ctx, 'settings')
    if (settings !== undefined) {
      if (typeof settings.get === 'function') {
        const value = settings.get(ns)
        if (value !== undefined) return unwrapVolatiles(value)
      }
      if (typeof settings.describe === 'function') {
        const descriptors = settings.describe({ redactSecrets: false })
        if (Array.isArray(descriptors)) {
          const match = descriptors.find((d) =>
            d.ns === ns
            || (ns === 'llm-pi-ai' && (d.ns === 'llm' || isPlainObject((d.value as { providers?: unknown })?.providers)))
            || (ns === 'llm-deepseek' && (d.ns === 'llm-deepseek' || d.ns === 'llm-deepseek-api-key'))
          )
          if (match !== undefined && match.value !== undefined) {
            return unwrapVolatiles(match.value)
          }
        }
      }
    }

    // 2. Try ctx.root.loader or ctx.loader entries
    const loader = (ctx as unknown as {
      root?: { loader?: { entries(): Iterable<{ options: { id: string; name?: string }; fiber?: { config?: unknown } }> } }
      loader?: { entries(): Iterable<{ options: { id: string; name?: string }; fiber?: { config?: unknown } }> }
    }).root?.loader
      ?? (ctx as unknown as {
        loader?: { entries(): Iterable<{ options: { id: string; name?: string }; fiber?: { config?: unknown } }> }
      }).loader
    if (loader !== undefined && typeof loader.entries === 'function') {
      for (const entry of loader.entries()) {
        const id = entry.options?.id
        const name = entry.options?.name
        if (
          id === ns
          || name === `@deepseek-ai/dsh-${ns}`
          || name?.endsWith(`/${ns}`)
          || (ns === 'llm-pi-ai' && (id === 'llm' || name === '@deepseek-ai/dsh-llm-pi-ai'))
          || (ns === 'llm-deepseek' && (id === 'llm-deepseek-api-key' || name === '@deepseek-ai/dsh-llm-deepseek-api-key'))
        ) {
          if (entry.fiber?.config !== undefined) {
            return unwrapVolatiles(entry.fiber.config)
          }
        }
      }
    }

    // 3. Try configEditor service
    const editor = service<{
      configuration?(): Array<{
        entry: { options: { id: string; name?: string }; fiber?: { config?: unknown } }
        inherited: Record<string, unknown>
        override: Record<string, unknown>
      }>
    }>(ctx, 'configEditor')
    if (editor !== undefined && typeof editor.configuration === 'function') {
      const rows = editor.configuration()
      const match = rows.find((r) => {
        const id = r.entry.options.id
        const name = r.entry.options.name
        return (
          id === ns
          || name === `@deepseek-ai/dsh-${ns}`
          || name?.endsWith(`/${ns}`)
          || (ns === 'llm-pi-ai' && (id === 'llm' || name === '@deepseek-ai/dsh-llm-pi-ai'))
          || (ns === 'llm-deepseek' && (id === 'llm-deepseek-api-key' || name === '@deepseek-ai/dsh-llm-deepseek-api-key'))
        )
      })
      if (match !== undefined) {
        if (match.entry.fiber?.config !== undefined) {
          return unwrapVolatiles(match.entry.fiber.config)
        }
        return unwrapVolatiles(deepMerge(match.inherited, match.override))
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

export class UsageService {
  private readonly ctx: Context
  private options: UsageServiceOptions
  private readonly persistDir: string
  /**
   * This machine's own ledger file. Every write goes here and nowhere else —
   * see device-ledger.ts for why there is no "import overwrites" path.
   */
  private readonly ledgerPath: string
  private readonly snapshotsPath: string

  /** This machine's stable id; peers are keyed by theirs. */
  private readonly deviceId: string
  /**
   * Peer ledgers, keyed by device id. Read-only: refreshed on load, on flush,
   * and on demand from the panel. They are summed into the served view but
   * never written back to disk.
   */
  private peers: LoadedLedgerFile[] = []
  /** Last peer scan failure, surfaced in the overview so a silent empty merge is visible. */
  private peersError: string | undefined
  /**
   * Last ledger load failure, surfaced in the overview. A file that could not be
   * read is never overwritten, so this is the only trace of why the totals are
   * empty this boot.
   */
  private ledgerError: string | undefined
  /**
   * A condition the user should know about that is not an error: a replay cut
   * short by the per-start cap, or a file that turned out to belong to another
   * device. Shown next to `ledgerError`, because a silently shortened history
   * reads exactly like a complete one.
   *
   * Keyed by kind, so a condition that repeats every flush states itself once
   * instead of growing a sentence longer on every write.
   */
  private readonly notes = new Map<string, string>()
  /** The document as it was before the first load absorb, so a retry starts clean. */
  private loadBaseline: UsageLedgerDocument | undefined
  /** Calls folded while a load attempt was in flight; re-applied after a rollback. */
  private loadFolds: UsageLedgerDocument | undefined
  /** True once the persisted document has been folded into memory this boot. */
  private loadAbsorbed = false
  /**
   * The smallest retention this process has seen applied.
   *
   * A lower setting than this means the user shrank the window on purpose, which
   * the "clock jumped" guard in `pruneForWrite` must not veto. Seeded from the
   * retention the file itself records, so a setting changed while the app was
   * closed is still recognised as a shrink instead of looking like a jump.
   */
  private retentionSeen: number

  /**
   * The window the file on disk was last pruned to, as recorded in the file.
   *
   * `retentionSeen` cannot answer "was this day written under a clock that was
   * behind this one?" after the first prune, because it is lowered to the
   * current setting; the file's own window can, and it is what tells a clock
   * that jumped from a retention the user lowered.
   */
  private fileRetention: number | undefined
  /**
   * The last prune was refused as a jumped clock. The file then keeps the window
   * it recorded before the jump: writing the new setting would make the next
   * flush (and the next boot) read the same days as "inside the file's window",
   * so the second attempt would look legitimate and the history would go anyway.
   */
  private windowRefused = false

  /** The window a shrink in this session asked for, so later prunes still read as one. */
  private shrankTo: number | undefined

  /**
   * When the ledger file was last written (by this process or before it).
   *
   * A prune that drops two days is not evidence of anything by itself: a run
   * that was merely idle for two days drops exactly the days that aged out. What
   * the clock did is measured against this instant, so only a slab larger than
   * the elapsed days is reported as one.
   */
  private ledgerWrittenAt: number | undefined

  /**
   * Whether the write in progress holds the ledger lock. A write that could not
   * take it goes ahead anyway (losing every later call is worse), but it must not
   * retire the `lock-busy` note that its own wait just raised.
   */
  private lockHeld = true

  /**
   * This machine's identity as recorded in every file it writes.
   *
   * Pinned in `machine-id.json` on first run rather than derived from the host
   * name: a rename must not make this machine look like a second device.
   */
  private machine = localMachineId()
  /**
   * Ids this profile used before the current pin: a re-minted pin leaves files
   * stamped with an older id, and those are this machine's own history, not a
   * second device. Folded in (max merge) instead of summed.
   */
  private readonly machineAliases = new Set<string>()
  /**
   * The deduped replay of this boot, kept so a flush that must not max-merge
   * (a file another process repaired) can still add the buckets only the replay
   * recovers — those are not expressible as growth since our last write.
   */
  private replayDoc: UsageLedgerDocument | undefined

  /**
   * What this machine's own renamed copies (and a peer that appears under two
   * file names) contributed to `this.ledger`.
   *
   * A flush that adopts the disk file instead of merging our view — because
   * another process wrote a newer repair stamp — starts from that file, which
   * never held these buckets: the delta is measured against what we last wrote,
   * so the fold falls out of the window and the device's days disappear until
   * the next rescan.
   */
  private foldedDoc: UsageLedgerDocument | undefined

  private ledger: UsageLedgerDocument = createLedgerDocument()
  /**
   * The document this process last wrote to disk. Another process on this
   * machine writes the same file, so a flush adds only what we folded since
   * this snapshot — adding the whole document would count its calls twice.
   */
  private ledgerWritten: UsageLedgerDocument | undefined
  /**
   * Newest `repairedAt` this process has already accounted for. A file carrying
   * a later stamp was corrected by another process after we loaded, and its
   * (lower) buckets must not be raised again by our stale copy.
   */
  private seenRepairedAt = 0
  /**
   * Buckets an earlier start already corrected, by marker key.
   *
   * The record is a set of keys and nothing else: a bucket listed here was
   * judged and rewritten, so a later start must not judge it again. Keeping the
   * totals written (a "floor") is what the first version did, and a bucket that
   * was later re-inflated never matched that floor again — it was locked out of
   * the repair for good and warned about on every start. The key alone is enough
   * to stay out of the way, and it is dropped once its day leaves the window.
   */
  private repairCorrected = new Set<string>()
  /** The file predates the correction beside it: a backup was put back. */
  private repairRejudgeAll = false
  private readonly snapshots = new Map<string, ProviderSnapshotState>()
  /** The official DeepSeek family's real-spend watch (see SpendWatch). */
  private spendWatch: SpendWatch | undefined
  /** Per-live-session route attribution (WeakMap: disposed sessions age out). */
  private readonly sessionRoutes = new WeakMap<Session, { provider: string; model: string }>()
  /** The most recent route seen this boot; the sidebar strip and the header highlight follow it. */
  private current: { provider?: string; model?: string; source: 'live' | 'default' } = { source: 'default' }

  private sessionListenerDisposer: (() => void) | undefined
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private pollInFlight = false
  /** The running poll cycle; manual refresh joins it instead of no-oping. */
  private pollPromise: Promise<void> | undefined
  /** Serialized ledger flushes: overlapping debounce/stop flushes queue, never interleave. */
  private flushChain: Promise<void> = Promise.resolve()
  /** True once loadPersisted finished; nothing may overwrite the files before that. */
  private loaded = false
  /** A peer scan asked for while the load was still running, to run when it ends. */
  private peersScanPending = false
  /** Retry bookkeeping for a ledger file that could not be read this boot. */
  private loadRetries = 0
  private loadRetryTimer: ReturnType<typeof setTimeout> | undefined
  /** The first load, so a stop inside its window can wait for it before flushing. */
  private loadDone: Promise<void> | undefined
  private disposed = false
  /** Last prune guard: once per local day, and whenever retention shrinks. */
  private lastPrune: { dayKey: string; retainDays: number } | undefined

  constructor(ctx: Context, options: UsageServiceOptions) {
    this.ctx = ctx
    this.options = options
    this.persistDir = join(dshHome(), 'dsh-usage')
    this.deviceId = localDeviceId()
    this.ledgerPath = join(this.persistDir, ledgerFileName(this.deviceId))
    this.snapshotsPath = join(this.persistDir, 'provider-snapshots.json')
    this.retentionSeen = options.retainDays
  }

  /** Start the listeners, load persisted state, and arm the first poll. */
  start(): void {
    this.disposed = false
    this.sessionListenerDisposer = this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))
    this.loadDone = this.loadPersisted()
    this.rearmPoll(2_000)
  }

  /**
   * Stop timers and flush pending ledger writes. The returned promise
   * resolves after the final flush lands, so a successor instance (the Host
   * reloads the profile row on a config change) can serialize its first load
   * behind it.
   */
  stop(): Promise<void> {
    this.disposed = true
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer)
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer)
    if (this.loadRetryTimer !== undefined) clearTimeout(this.loadRetryTimer)
    this.sessionListenerDisposer?.()
    // A stop inside the load window would otherwise flush nothing at all (the
    // writer refuses to touch the file before it has been read): the calls folded
    // since the last write would be lost until a transcript replays them.
    const loaded = this.loadDone ?? Promise.resolve()
    return loaded.then(
      () => this.flushLedger(),
      () => this.flushLedger(),
    )
  }

  /** Re-apply options to this running instance; retention shrink prunes now. */
  applyOptions(options: UsageServiceOptions): void {
    this.options = options
    this.pruneIfNeeded()
  }

  /** Force one poll now (manual refresh route); joins an in-flight cycle. */
  async refresh(): Promise<void> {
    // A peer file dropped in by hand is otherwise only picked up at the next
    // start; the manual refresh is the one moment the user is asking for exactly
    // that ("I copied the other machine's ledger over — show it").
    await this.rescanPeers()
    await this.pollNow()
  }

  /** This machine's stable id — the key its exported ledger carries. */
  get device(): string {
    return this.deviceId
  }

  /**
   * This device's own ledger as a portable export envelope.
   *
   * Contains only this machine's history: peers are already counted on the
   * receiving side when their files are present, so re-exporting them would
   * make totals grow with each round trip.
   */
  exportLedger(): UsageLedgerExport {
    return {
      schema: LEDGER_EXPORT_SCHEMA,
      version: 1,
      deviceId: this.deviceId,
      // The machine travels with the export: the receiving side needs it to tell
      // a real second machine from a copy of its own history.
      machine: this.machine,
      // The window these days were pruned to. Without it the importing side can
      // only guess, and a peer file is never pruned with this machine's setting.
      retentionDays: this.declaredWindow(),
      exportedAt: new Date().toISOString(),
      ledger: this.ledger,
    }
  }

  /**
   * Install a peer's exported ledger as that device's file.
   *
   * Merges into the peer file rather than replacing it: importing the same
   * document twice still changes nothing (the merge never lowers a bucket), but an
   * *older* export of a device that kept counting no longer drops the days the
   * file already holds — the receiving machine has no way to fetch them again.
   * The device id comes from inside the document (validated as a filename-safe
   * token), so the receiving machine never has to know the sender's file name.
   * @param text - raw JSON of an export envelope or a bare ledger document.
   * @returns the device id that was written.
   */
  async importPeer(text: string): Promise<{ deviceId: string }> {
    if (Buffer.byteLength(text, 'utf8') > IMPORT_MAX_BYTES) {
      throw new UsageImportError(`ledger exceeds ${IMPORT_MAX_BYTES} bytes`)
    }
    let parsed: unknown
    try {
      parsed = parseJsonText(text)
    } catch {
      throw new UsageImportError('not JSON')
    }
    const record = typeof parsed === 'object' && parsed !== null ? (parsed as { deviceId?: unknown; ledger?: unknown; days?: unknown }) : undefined
    if (record === undefined) throw new UsageImportError('not a ledger document')
    const claimedId = typeof record.deviceId === 'string' ? record.deviceId : undefined
    if (claimedId === undefined) {
      throw new UsageImportError('missing deviceId: export the file from the plugin instead of hand-writing it')
    }
    if (!isDeviceId(claimedId)) throw new UsageImportError(`unusable deviceId ${JSON.stringify(claimedId)}`)
    if (claimedId === this.deviceId) throw new UsageImportError('this file was exported by THIS device; nothing to import')
    const doc = parsePeerLedger(parsed)
    if (doc === undefined) throw new UsageImportError('unreadable ledger payload')
    await mkdir(this.persistDir, { recursive: true })
    const target = join(this.persistDir, ledgerFileName(claimedId))
    // Re-importing is normally the same file twice, but an *older* export of a
    // device that kept counting would otherwise drop the days the peer file
    // already holds — and the receiving machine has no way to fetch them again.
    // So the file is merged, not replaced, and the merge never lowers a bucket.
    // The read and the write sit under the ledger lock: two imports of one peer
    // are a read-modify-write on the same target, and the second used to replace
    // the first's merge with its own older view (a lost update, not corruption —
    // the write itself is atomic).
    let imported = false
    await this.withLedgerLock(async (locked) => {
      // A merge we cannot make exclusive would replace whatever the other writer
      // put in the file with our older view — a lost update, not corruption, and
      // the one thing the lock exists to prevent. The import is user-initiated,
      // so standing down and asking for a retry costs nothing.
      if (!locked) return
      const existing = await readFile(target, 'utf8').then(
        (text) => {
          try {
            return parsePeerLedger(parseJsonText(text))
          } catch {
            return undefined
          }
        },
        () => undefined,
      )
      // A file that already holds another device's calls must not be rewritten as
      // this one: the merge would move that history into this file while the
      // original stays beside it, and the same calls would be counted twice for
      // as long as both exist.
      if (existing !== undefined && existing.deviceId !== claimedId) {
        throw new UsageImportError(`${claimedId}: the file named for this device already holds another device's ledger — move it away before importing`)
      }
      const merged = existing === undefined ? doc.doc : structuredClone(existing.doc)
      if (existing !== undefined) mergeLedgerMax(merged, doc.doc)
      // A document exported by an older build carries no machine id; the peer file
      // it is merged into may still have one. Dropping it would turn a device this
      // machine can attribute into an "unverified" one, and its days would then be
      // counted only where this machine has no record — a silent undercount.
      const machine = doc.machine ?? existing?.machine
      // The window the peer recorded, from the export or the file it lands in.
      // Neither means unknown, and this machine's window must not be written in
      // its place: a later reader would trust a number the peer never used.
      // It must also be able to hold the days the file carries: a refused prune
      // leaves a file declaring 7 days while it holds 36, and the next reader
      // would trust the 7 and treat those days as outside the window.
      const dayCount = ledgerDayKeys(merged).length
      const declaredWindow = doc.retentionDays ?? existing?.retentionDays ?? 0
      const peerWindow = Math.max(declaredWindow, dayCount) || undefined
      if (existing !== undefined) {
        const kept = ledgerDayKeys(existing.doc).filter((key) => doc.doc.days[key] === undefined)
        if (kept.length > 0) {
          this.note(`import:${claimedId}`, `import merged into the peer file; ${kept.length} day(s) it already held were kept`)
        }
      }
      await writeJsonAtomic(target, {
        schema: LEDGER_EXPORT_SCHEMA,
        version: 1,
        deviceId: claimedId,
        // Carry the exporting machine's id through the round trip: without it the
        // file can no longer prove where it came from, and the peer scan refuses
        // to count a document it cannot attribute.
        ...(machine === undefined ? {} : { machine }),
        exportedAt: new Date().toISOString(),
        // Record the window this machine prunes to, the same way a device ledger
        // does: a peer file without it is the shape the retention guard has to
        // treat as "unknown window", and the round trip is the only chance to say.
        ...(peerWindow === undefined ? {} : { retentionDays: peerWindow }),
        ledger: merged,
      })
      imported = true
    })
    if (!imported) throw new UsageImportError('another process is writing the ledger; nothing was imported — try again')
    await this.refreshPeers()
    return { deviceId: claimedId }
  }

  /** Re-scan peer files; the panel calls this after a file is dropped in by hand. */
  async rescanPeers(): Promise<DeviceLedgerEntryView[]> {
    await this.refreshPeers()
    return this.deviceEntries()
  }

  /** Assemble the overview document the browser section renders. */
  overview(): UsageOverviewView {
    const todayKey = localDateKey(Date.now())
    const routes = this.listProviderRoutes()
    const providers: ProviderSnapshotView[] = []
    for (const route of routes) {
      const adapter = adapterFor(route.id)
      const snapshot = this.snapshots.get(route.id)
      const error = snapshot?.balanceError ?? snapshot?.planError
      providers.push({
        provider: route.id,
        displayName: route.displayName || adapter?.displayName || route.id,
        credential: snapshot?.credential ?? 'none',
        supported: adapter !== undefined && (adapter.balance !== undefined || adapter.plan !== undefined),
        // A balance endpoint that belongs to another origin does not report
        // THIS route's account: it is supported by the adapter but not
        // applicable here, and the UI renders it as unsupported rather than
        // showing the other account's number (issue #1688).
        ...(adapter?.balance !== undefined && balanceAppliesToRoute(adapter, this.routeBaseUrl(route.id))
          ? { balanceSupported: true }
          : {}),
        ...(adapter?.balance !== undefined && !balanceAppliesToRoute(adapter, this.routeBaseUrl(route.id))
          ? { balanceSupported: false }
          : {}),
        ...(adapter?.plan !== undefined ? { planSupported: true } : {}),
        ...(snapshot?.balance !== undefined ? { balance: snapshot.balance } : {}),
        ...(snapshot?.plan !== undefined ? { plan: snapshot.plan } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(snapshot?.updatedAt !== undefined ? { updatedAt: snapshot.updatedAt } : {}),
      })
    }
    providers.sort((a, b) => Number(b.supported) - Number(a.supported) || a.displayName.localeCompare(b.displayName))
    const merged = this.mergedLedger()
    const allKeys = ledgerDayKeys(merged)
    // The window is the last TREND_DAYS *calendar* days, not the last TREND_DAYS
    // recorded ones. After a gap the recorded tail can reach back months, and a
    // chart labelled "the last 30 days" would then be showing a year — the empty
    // window is the honest answer, and the "all" figures still carry the history.
    const oldest = localDateKey(Date.now() - (TREND_DAYS - 1) * 86_400_000)
    const days = allKeys.filter((key) => key >= oldest)
    const range = summarizeDays(days.map((key) => merged.days[key] ?? {}))
    const all = summarizeDays(allKeys.map((key) => merged.days[key] ?? {}))
    return {
      updatedAt: Date.now(),
      providers,
      current: this.currentView(),
      usage: {
        today: this.daySummary(todayKey),
        days: days.map((date) => {
          const summary = this.daySummary(date)
          return { date, totals: summary.totals }
        }),
        range: {
          from: days[0] ?? todayKey,
          to: days[days.length - 1] ?? todayKey,
          totals: range.totals,
          providers: range.providers,
        },
        // Every day the totals count, peers included: `day()` reads the merged
        // ledger, so a day that only a peer recorded opens with its numbers. The
        // list used to come from this machine's file alone, which left days out
        // of the picker while `all` summed them — a day the panel counted and
        // could not open.
        availableDays: allKeys,
        all: {
          from: allKeys[0] ?? todayKey,
          to: allKeys[allKeys.length - 1] ?? todayKey,
          totals: all.totals,
          providers: all.providers,
        },
        ...(this.spendWatch !== undefined && this.spendWatch.accruedCny > 0
          ? { observedSpend: { cny: this.spendWatch.accruedCny, since: this.spendWatch.since } satisfies ObservedSpendView }
          : {}),
        devices: this.deviceEntries(),
        deviceId: this.deviceId,
        ...(this.peersError !== undefined ? { devicesError: this.peersError } : {}),
        ...(this.ledgerError !== undefined ? { ledgerError: this.ledgerError } : {}),
        ...(this.ledgerNoteText() !== undefined ? { ledgerNote: this.ledgerNoteText() } : {}),
      },
    }
  }

  /** Every ledger file backing the served totals, this device first. */
  private deviceEntries(): DeviceLedgerEntryView[] {
    return [
      { deviceId: this.deviceId, role: 'local' },
      ...this.peers.map((peer): DeviceLedgerEntryView => ({ deviceId: peer.deviceId, role: 'peer' })),
    ]
  }

  /**
   * The served document: this device's ledger plus every peer's, summed.
   *
   * Summed, not merged by max: two devices on one account genuinely spent both
   * sets of tokens, so the ledger a user expects is the sum. Nothing here is
   * ever written back — `this.ledger` stays this device's own history, which is
   * what makes a repeated peer import idempotent (the same file is read twice,
   * not added twice).
   */
  private mergedLedger(): UsageLedgerDocument {
    if (this.peers.length === 0) return this.ledger
    const merged = createLedgerDocument()
    mergeLedgerSum(merged, this.ledger)
    // A peer's days are clamped to the same window this device's own history is
    // pruned to. Without that, a day that fell out of the local window comes back
    // from the peer copy on every start — and once the local copy is gone, the
    // whole peer bucket reads as "not recorded here" and the same calls are
    // counted a second time. The window is the declared one: when the local prune
    // was refused, clipping peers to the narrower setting would make the panel's
    // total smaller than the ledger it is showing.
    const oldest = localDateKey(Date.now() - (Math.max(1, this.declaredWindow()) - 1) * 86_400_000)
    for (const peer of this.peers) {
      const windowed = createLedgerDocument()
      for (const [dayKey, day] of Object.entries(peer.doc.days)) {
        if (dayKey >= oldest) windowed.days[dayKey] = day
      }
      mergeLedgerSum(merged, windowed)
    }
    return merged
  }

  /**
   * The strip-ready current-provider view: the resolved display name plus
   * today's ledger totals for the provider's adapter family (the route
   * itself when adapter-less). `today` is absent on a day without usage —
   * a strip about nothing is noise, not information.
   */
  private currentView(): UsageOverviewView['current'] {
    const provider = this.current.provider
    if (provider === undefined) return { ...this.current }
    let snapshot = this.snapshots.get(provider)
    if (snapshot === undefined) {
      const family = adapterFor(provider)
      if (family !== undefined) {
        for (const [id, candidate] of this.snapshots) {
          if (adapterFor(id) === family) {
            snapshot = candidate
            break
          }
        }
      }
    }
    const displayName = snapshot?.displayName ?? this.routeDisplayName(provider)
    const today = this.familyUsageToday(provider)
    return {
      ...this.current,
      displayName,
      ...(today.calls > 0 && totalTokens(today) > 0 ? { today } : {}),
    }
  }

  /**
   * One retained local day aggregated per provider and model, as the day
   * route serves it. A day the ledger never held — pruned by retention, or
   * simply without usage — reads as a zeroed day rather than an error, so a
   * picker selection that aged out degrades to "no usage" instead of a broken
   * panel. The route gates the key's shape before it gets here.
   */
  day(dateKey: string): UsageDayView {
    return this.daySummary(dateKey)
  }

  /**
   * One window aggregated per provider and model, plus the per-day series the
   * trend chart buckets. Reads the merged ledger (local + imported peers), so
   * a single request answers a window that would otherwise cost one small
   * fetch per recorded day — the shape that makes multi-month windows viable.
   * Each series row also carries the day's per-model split aggregated across
   * providers, so the browser can stack the trend bars by model without one
   * day fetch per recorded day.
   * @param from - local date key `YYYY-MM-DD`, inclusive.
   * @param to - local date key `YYYY-MM-DD`, inclusive.
   */
  range(from: string, to: string): Omit<UsageRangeResponse, 'ok'> {
    const merged = this.mergedLedger()
    const keys = ledgerDayKeys(merged).filter((date) => date >= from && date <= to)
    const { totals, providers } = summarizeDays(keys.map((key) => merged.days[key] ?? {}))
    const series = keys.map((date) => {
      const day = this.daySummaryIn(merged, date)
      const models: Record<string, UsageTokenTotals> = {}
      for (const row of day.providers) {
        for (const model of row.models) {
          const bucket = models[model.model] ?? emptyTotals()
          addTotals(bucket, model.totals)
          models[model.model] = bucket
        }
      }
      return { date, totals: day.totals, models }
    })
    return { from, to, totals, providers, series }
  }

  /** One day of the merged ledger aggregated per provider. */
  private daySummaryIn(doc: UsageLedgerDocument, dateKey: string): UsageDayView {
    const day = doc.days[dateKey] ?? {}
    const { totals, providers } = summarizeDays([day])
    return { date: dateKey, totals, providers }
  }

  /** One local day aggregated per provider. */
  private daySummary(dateKey: string): UsageDayView {
    const day = this.mergedLedger().days[dateKey] ?? {}
    const { totals, providers } = summarizeDays([day])
    return { date: dateKey, totals, providers }
  }

  /**
   * Today's ledger totals for one provider's adapter family — the exact
   * route when adapter-less, the merged family otherwise, so aliased routes
   * of one account (the deepseek catalog id and its runtime alias) fold
   * together.
   */
  private familyUsageToday(provider: string): UsageTokenTotals {
    const family = adapterFor(provider)
    let merged = emptyTotals()
    for (const row of this.daySummary(localDateKey(Date.now())).providers) {
      const same = family === undefined ? row.provider === provider : adapterFor(row.provider) === family
      if (same) merged = addTotals(merged, row.totals)
    }
    return merged
  }

  /**
   * Accrue the official DeepSeek family's real spend from observed CNY
   * balance decreases; a balance rise is a top-up and never counts. The
   * family's route ids can alias one account, so the watch follows the
   * largest balance seen this cycle and accrues only decreases of that
   * series — a failed probe keeps the stale balance and accrues nothing
   * until the next success reports the whole drop at once.
   */
  private accrueDeepSeekSpend(): void {
    let balanceCny: number | undefined
    for (const [id, snapshot] of this.snapshots) {
      if (!isDeepSeekProviderRoute(id)) continue
      const balance = snapshot.balance
      if (balance === undefined || balance.currency.toUpperCase() !== 'CNY') continue
      const value = Number(balance.totalBalance)
      if (!Number.isFinite(value)) continue
      balanceCny = balanceCny === undefined ? value : Math.max(balanceCny, value)
    }
    if (balanceCny === undefined) return
    const watch = this.spendWatch ?? { accruedCny: 0, since: Date.now() }
    if (watch.lastBalanceCny !== undefined && balanceCny < watch.lastBalanceCny) {
      watch.accruedCny += watch.lastBalanceCny - balanceCny
    }
    watch.lastBalanceCny = balanceCny
    this.spendWatch = watch
  }

  /**
   * The display name for a route key: the LLM runtime's first, then the
   * adapter's, then the id itself — the snapshot may not exist for
   * adapter-less routes, yet the sidebar strip still needs a legible title.
   */
  private routeDisplayName(provider: string): string {
    const route = this.listProviderRoutes().find((entry) => entry.id === provider)
    return route?.displayName || adapterFor(provider)?.displayName || provider
  }

  // ------------------------------------------------------------------
  // Session usage fold
  // ------------------------------------------------------------------

  private onSessionEvent(session: Session, event: SessionEvent): void {
    try {
      if (event.type === 'request/header') {
        const config = (event.data as { header?: { config?: { provider?: string; model?: string } } }).header?.config
        if (config?.provider !== undefined) {
          this.sessionRoutes.set(session, { provider: config.provider, model: config.model ?? '' })
          this.current = { provider: config.provider, model: config.model, source: 'live' }
        }
      } else if (event.type === 'request/context') {
        const data = event.data as { provider?: string; model?: string }
        if (data.provider !== undefined) {
          this.sessionRoutes.set(session, { provider: data.provider, model: data.model ?? '' })
          this.current = { provider: data.provider, model: data.model, source: 'live' }
        }
      } else if (event.type === 'assistant/message') {
        const data = event.data as { usage?: TokenUsage; message?: { source?: { provider?: string; model?: string } } }
        const usage = data.usage
        if (usage === undefined) return
        // The record names its own route — the session store refuses an
        // assistant message without a provider/model pair — so the session map
        // is only a fallback. `request/header` fires once per epoch, and a
        // header published before this listener attached would otherwise drop
        // every later call in that session (the long-lived subagent sessions,
        // whose single header lands at spawn time, lost whole runs that way).
        const source = data.message?.source
        const route = typeof source?.provider === 'string' && source.provider !== ''
          ? { provider: source.provider, model: source.model ?? '' }
          : this.sessionRoutes.get(session)
        if (route === undefined || route.provider === '') return
        // The record's own timestamp, not the fold instant: a call that lands
        // just after midnight belongs to the day it was billed on.
        const atMs = typeof event.time === 'number' ? event.time : Date.now()
        foldUsage(this.ledger, atMs, route.provider, route.model || 'unknown', this.totalsFrom(usage, route.provider, route.model || 'unknown', atMs))
        // A load retry rolls `this.ledger` back to the pre-load baseline; the
        // calls folded while it waited are not in that baseline, so they are
        // recorded here and re-applied after the rollback. Without this a failed
        // load silently forgot up to LOAD_RETRY_MAX retries of usage.
        if (this.loadBaseline !== undefined) {
          this.loadFolds ??= createLedgerDocument()
          foldUsage(this.loadFolds, atMs, route.provider, route.model || 'unknown', this.totalsFrom(usage, route.provider, route.model || 'unknown', atMs))
        }
        this.scheduleFlush()
      }
    } catch {
      // A malformed event must never break the session loop.
    }
  }

  /**
   * Normalize a provider TokenUsage into the ledger bucket (one call). The
   * DeepSeek official family is priced at the fold instant (its billing
   * period is time-of-day); other families stay unpriced (cost 0).
   */
  private totalsFrom(usage: TokenUsage, provider: string, model: string, atMs: number): UsageTokenTotals {
    const totals = emptyTotals()
    totals.inputTokens = usage.inputTokens
    totals.outputTokens = usage.outputTokens
    totals.cacheReadTokens = usage.cacheReadTokens ?? 0
    totals.cacheWriteTokens = usage.cacheWriteTokens ?? 0
    totals.reasoningTokens = usage.reasoningTokens ?? 0
    totals.calls = 1
    if (isDeepSeekProviderRoute(provider)) totals.cost = deepseekModelSpend(model, totals, atMs)
    return totals
  }

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------

  /**
   * Read this device's ledger file, telling the three failures apart: absent,
   * unreadable (locked or permission-denied — the data may still be there), and
   * corrupt (present but unparseable). Only "absent" may start a fresh file;
   * treating either failure as "no history" would let the next flush replace a
   * real ledger with an empty one.
   */
  private async readLedgerFile(): Promise<
    | { kind: 'missing' }
    | { kind: 'ok'; doc: UsageLedgerDocument; repairedAt?: number; machine?: string; retentionDays?: number; dropped?: number }
    | { kind: 'corrupt'; error: string }
    | { kind: 'unreadable'; error: string }
  > {
    let raw: string
    try {
      raw = await readFile(this.ledgerPath, 'utf8')
    } catch (error) {
      const code = (error as { code?: unknown }).code
      return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', error: String(code ?? error) }
    }
    const parsed = this.ledgerFromJson(raw)
    return parsed.kind === 'ok'
      ? {
          kind: 'ok',
          doc: parsed.doc,
          repairedAt: parsed.repairedAt,
          machine: parsed.machine,
          retentionDays: parsed.retentionDays,
          ...(parsed.dropped === undefined ? {} : { dropped: parsed.dropped }),
        }
      : { kind: 'corrupt', error: parsed.error }
  }

  /**
   * Parse ledger JSON, accepting the `/export` envelope as well as a bare document.
   *
   * An export wraps the document as `{schema, version, deviceId, exportedAt,
   * ledger}`, and restoring a backup means dropping exactly that file back in
   * place. Reading only the top-level `days` would call it a valid *empty*
   * ledger, and the first flush would then write that emptiness over the
   * history — while `importPeer` refuses this device's own export, leaving no
   * recovery path at all. So the envelope is unwrapped here, and a file naming
   * another device is refused instead of adopted (it belongs in the peers path).
   */
  private ledgerFromJson(raw: string): { kind: 'ok'; doc: UsageLedgerDocument; repairedAt?: number; machine?: string; retentionDays?: number; dropped?: number } | { kind: 'corrupt'; error: string } {
    let parsed: unknown
    try {
      parsed = parseJsonText(raw)
    } catch (error) {
      return { kind: 'corrupt', error: error instanceof Error ? error.message : String(error) }
    }
    if (typeof parsed !== 'object' || parsed === null) return { kind: 'corrupt', error: 'not a ledger document' }
    const record = parsed as Record<string, unknown>
    const deviceId = typeof record.deviceId === 'string' ? record.deviceId : ''
    if (deviceId !== '' && deviceId !== localDeviceId()) return { kind: 'corrupt', error: `names device ${deviceId}` }
    const inner = typeof record.ledger === 'object' && record.ledger !== null ? record.ledger : record
    // A document with no `days` key at all is the shape `deserializeLedger`
    // documents as a fresh ledger (a stamp written before the first call), so it
    // is read as empty history rather than quarantined. A `days` key that is
    // there but is not an object — an array, a string, a number — is a shape we
    // do not understand (a future version's envelope, a half-written file); read
    // as "no history" it would be overwritten by the first flush, so that one is
    // treated as unreadable and left alone.
    const rawDays = (inner as Record<string, unknown>).days
    if (rawDays !== undefined && !isPlainObject(rawDays)) {
      return { kind: 'corrupt', error: 'no days in document' }
    }
    const repairedAt = typeof record.repairedAt === 'number' && Number.isFinite(record.repairedAt) ? record.repairedAt : undefined
    const machine = typeof record.machine === 'string' && record.machine !== '' ? record.machine : undefined
    const retentionDays = typeof record.retentionDays === 'number' && Number.isFinite(record.retentionDays) ? record.retentionDays : undefined
    try {
      const doc = deserializeLedger(inner)
      // Entries the reader had to leave out — an impossible day key, a bucket
      // that is not an object, a counter that is a string — used to vanish in
      // silence, and the next flush wrote the document without them. Counting
      // them is the only way the panel can say that something was dropped.
      const rawDayMap = isPlainObject(rawDays) ? (rawDays as Record<string, unknown>) : {}
      const dropped = countUnreadableEntries(rawDayMap, doc)
      return {
        kind: 'ok',
        doc,
        ...(repairedAt !== undefined ? { repairedAt } : {}),
        ...(machine !== undefined ? { machine } : {}),
        ...(retentionDays !== undefined ? { retentionDays } : {}),
        ...(dropped > 0 ? { dropped } : {}),
      }
    } catch (error) {
      return { kind: 'corrupt', error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async loadPersisted(): Promise<void> {
    try {
      // The persisted document is folded in with `absorb`, which ADDS. A retry
      // after a failure that happened past the absorb would therefore add the
      // same history again — and again on every retry, up to 2^6 times. The
      // baseline restores the pre-absorb document first, so a retry sees exactly
      // what the first attempt saw.
      if (this.loadBaseline === undefined) this.loadBaseline = structuredClone(this.ledger)
      else if (!this.loadAbsorbed) {
        this.ledger = structuredClone(this.loadBaseline)
        // The rollback above drops the calls folded while the last attempt was
        // waiting; they are added back here so a retry loses nothing.
        if (this.loadFolds !== undefined) mergeLedgerSum(this.ledger, this.loadFolds)
      }
      await this.loadPersistedOnce()
      if (this.loaded) {
        this.loadBaseline = undefined
        this.loadFolds = undefined
      }
    } catch (error) {
      // Nothing below may reject out of the loader: it is started without an
      // await, and an unhandled rejection ends the host process.
      this.ledgerError = `ledger load failed (${error instanceof Error ? error.message : String(error)})`
      this.scheduleLoadRetry()
    }
  }

  private async loadPersistedOnce(): Promise<void> {
    // Whether this profile already had a pin decides who owns a machine id found
    // in the ledger: with no pin, the id in the file is this machine's own (the
    // pin was lost, the file is older than the loss); with a pin, an id that is
    // neither it nor one of its aliases belongs to another device.
    const pinned = await stat(join(this.persistDir, MACHINE_ID_FILE)).then(() => true, () => false)
    this.machine = await ensureMachineId(this.persistDir)
    // Ids this profile has written under before — a pin lost and re-minted, a
    // host renamed. Files carrying one of them hold this machine's own history,
    // so they are folded in instead of being summed as a second device.
    for (const alias of await readMachineAliases(this.persistDir)) this.machineAliases.add(alias)
    let read = await this.readLedgerFile()
    /** True when this boot starts without the history the ledger used to hold. */
    let lostHistory = false
    /** True when an unreadable file was moved aside and a fresh one started. */
    let quarantinedUnreadable = false
    if (read.kind === 'unreadable') {
      // Keep the write guard armed: nothing may replace a file we could not read.
      this.ledgerError = `ledger unreadable (${read.error})`
      if (this.loadRetries < LOAD_RETRY_MAX) {
        this.scheduleLoadRetry()
        return
      }
      // The budget is spent and the file still cannot be read. Refusing to write
      // for the rest of the session would lose every call folded after this boot;
      // moving the bytes aside keeps them salvageable by hand — the same trade the
      // corrupt path makes — and lets the counting continue in a fresh file.
      const kept = `${this.ledgerPath}.unreadable-${Date.now()}.json`
      const moved = await rename(this.ledgerPath, kept).then(() => true, () => false)
      if (!moved) {
        this.note('ledger-unreadable', `ledger unreadable (${read.error}); this session will not write`)
        return
      }
      this.ledgerError = `ledger unreadable (${read.error}); kept as ${basename(kept)}`
      this.note('ledger-unreadable', `ledger unreadable (${read.error}); kept as ${basename(kept)}, counting into a fresh file`)
      // The bytes that just moved aside held this machine's oldest days, and
      // those have no transcripts to rebuild from — exactly the corrupt path's
      // loss. Without this the pre-migration file is never folded back in and
      // the history is gone with only a "kept as" note to show for it.
      lostHistory = true
      await this.trimQuarantine(kept)
      read = { kind: 'missing' }
      // The error has to survive the successful load below: the session is
      // counting into a fresh file, and the panel that reads `ledgerError` is the
      // only place that says so. Clearing it at the end of the load left the
      // history gone and the panel silent.
      quarantinedUnreadable = true
    }
    if (read.kind === 'corrupt') {
      // A document naming ANOTHER device is not corrupt: it is that device's
      // ledger, dropped on the local path by a restore. Adopt it as a peer — its
      // totals come back with the peer scan below — instead of quarantining a
      // valid history under a `.corrupt-` name.
      const foreign = foreignDeviceOf(read.error)
      const target = foreign === undefined ? undefined : join(this.persistDir, ledgerFileName(foreign))
      const taken = target === undefined ? true : await stat(target).then(() => true, () => false)
      if (target !== undefined && !taken) {
        const moved = await rename(this.ledgerPath, target).then(() => true, () => false)
        if (moved) {
          this.note(`adopted:${foreign}`, `ledger named device ${foreign}; adopted as ${basename(target)}`)
          read = { kind: 'missing' }
        }
      } else if (target !== undefined) {
        this.note(`adopted:${foreign}`, `ledger named device ${foreign}, whose file is already present`)
      }
      if (read.kind === 'corrupt') {
        // Quarantine rather than discard: the bytes may still be salvageable by
        // hand, and a fresh document that keeps counting beats a silent wipe.
        const kept = `${this.ledgerPath}.corrupt-${Date.now()}.json`
        const renamed = await rename(this.ledgerPath, kept).then(() => true, () => false)
        this.ledgerError = renamed
          ? `ledger corrupt (${read.error}); kept as ${basename(kept)}`
          : `ledger corrupt (${read.error}); left in place`
        if (!renamed) {
          // Cannot move it aside, so writing would destroy the only copy.
          this.scheduleLoadRetry()
          return
        }
        lostHistory = true
        // `ledgerError` is a field the panel may or may not show; the note line is
        // the one place a user reads what happened to the file, and a quarantine
        // that only set the error left the panel looking like a fresh install.
        this.note(
          'ledger-unreadable',
          `the ledger could not be read (${read.error}); it was kept as ${basename(kept)} and counting continues in a fresh file`,
        )
        await this.trimQuarantine(kept)
      }
    }
    if (read.kind === 'ok') {
      // `absorb` adds, so it may run only once per process: a retry after a later
      // failure would otherwise fold the same file in a second time.
      if (!this.loadAbsorbed) {
        this.absorb(this.ledger, read.doc)
        this.loadAbsorbed = true
      }
      // Remember which correction this file already carries, so a flush from
      // another process can be recognised as newer than what we loaded.
      this.seenRepairedAt = read.repairedAt ?? 0
      // A machine id this profile already owns may be remembered; one that
      // contradicts an existing pin belongs to another device, and adding it to
      // the aliases would fold that device's history into this machine's totals
      // on every later boot.
      if (read.machine !== undefined && (!pinned || this.sameMachine(read.machine))) {
        await this.rememberMachine(read.machine)
      }
      // The window the file was last pruned to is the only record of the setting
      // behind it: without it a restart reads "the user lowered retention while
      // we were down" as "the clock jumped" and refuses the prune forever.
      if (read.retentionDays !== undefined) {
        // The file's record *is* the answer, not a lower bound on it: the
        // constructor seeds this with the setting, so `Math.max` made the first
        // 365→7 change look like no change at all — the prune was then measured
        // against a window the days were never written under and the note
        // blamed the clock for a shrink the user had just asked for.
        this.retentionSeen = read.retentionDays
        this.fileRetention = read.retentionDays
      }
      // No note clearing here: the map is empty on this pass, and the only prune
      // that can raise a note runs below (`pruneIfNeeded`). A clear placed here
      // could never fire, and the one that mattered — the refusal surviving a
      // successful prune — lives in `pruneForWrite`.
    } else if (read.kind === 'missing') await this.adoptLegacyLedger()
    // The oldest days have no transcripts: the ledger is the only copy, and a
    // corrupt file takes them with it. The pre-migration file still holds them,
    // so a boot that just lost its ledger folds that history back in.
    if (lostHistory) await this.restoreMigratedHistory()
    await this.loadSnapshots()
    // One replay pass serves both the backfill and the repair.
    const replay = await this.replaySessionLogs()
    this.replayDoc = replay.doc
    if (replay.skipped > 0) {
      // Say it out loud: a replay cut short by the per-start cap would otherwise
      // read as "the transcripts hold nothing older", i.e. as lost history.
      this.note('replay-cap', `${replay.skipped} older transcripts beyond the replay cap of ${SESSION_LOG_MAX_FILES} were not replayed`)
    }
    // The repair subtracts from the buckets as written, judged against the
    // deduped replay of the same pass. It runs on every start: a corrected file
    // holds the clean totals, so the pass finds nothing to do there, while a day
    // inflated after the correction still gets repaired. The old build kept a
    // record of the totals it had written and subtracted against that; a bucket
    // that was later re-inflated then mismatched the record forever, because
    // nothing ever cleared one — the record is gone and the whole-copies test
    // above is what keeps a bucket with a genuine extra call out of it.
    if (read.kind === 'ok' && read.dropped !== undefined) {
      // The document held entries the reader could not take — an impossible day
      // key, a bucket that is not an object, a counter that is a string. They are
      // gone from the next write, so the panel says it once instead of quietly
      // shrinking the history.
      // A bucket whose counter is a string is kept with that field zeroed, so the
      // line may not say the entry was left out: it says what actually happened.
      this.note('ledger-dropped', `${read.dropped} ledger entr${read.dropped === 1 ? 'y' : 'ies'} could not be read and were dropped or zeroed`)
    }
    const marker = read.kind === 'ok' ? await this.readRepairCorrected() : { corrected: new Set<string>(), appliedAt: undefined, version: undefined }
    this.repairCorrected = marker.corrected
    if (marker.version !== undefined && marker.version < 3) {
      // The old record kept the totals it had written instead of the buckets it
      // had corrected. Nothing in it can be trusted to say a bucket is done, so
      // every bucket was judged again — and that is why the user may see numbers
      // move once on this start.
      this.note('repair-record', 'the repair record predates this build, so its buckets were re-judged from the replay')
    }
    // A record that cannot say *when* it was written cannot date a copy against
    // itself: every bucket is judged again and the record is rewritten, so the
    // "predates this build" note does not repeat on every start.
    const markerUsable = marker.appliedAt !== undefined
    if (marker.version !== undefined && (!markerUsable || marker.version < 3)) {
      await writeJsonAtomic(join(this.persistDir, DEDUPE_MARKER_FILE), {
        version: 3,
        appliedAt: marker.appliedAt ?? Date.now(),
        buckets: marker.corrected.size,
        removedTokens: 0,
        corrected: [...marker.corrected]
          .filter((key) => this.ledger.days[key.slice(0, 10)] !== undefined)
          // Newest days first, so a cap that has to bite drops the oldest keys
          // rather than the ones a repair is most likely to need again.
          .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
          .slice(0, REPAIR_CORRECTED_MAX),
      }).catch(() => undefined)
    }
    // When the file was last written answers two questions: how long this machine
    // sat idle (a laptop off for a week is not a clock that jumped), and whether
    // the file predates the correction recorded beside it. A file older than that
    // record is a backup someone put back — its buckets were written before the
    // repair, so they are judged again even though the marker lists them.
    const fileWrittenAt = await stat(this.ledgerPath).then((info) => info.mtimeMs).catch(() => undefined)
    if (fileWrittenAt !== undefined) this.ledgerWrittenAt = fileWrittenAt
    // A file written before the correction is a backup someone put back: its
    // buckets were written before the repair, so they are judged again even
    // though the record lists them. A file that carries no stamp at all is the
    // same shape even when its mtime is fresh — copying a backup out of an
    // archive or Explorer gives it today's mtime, and trusting that mtime left
    // the inflation in place forever.
    const fileRepairedAt = read.kind === 'ok' ? read.repairedAt : undefined
    this.repairRejudgeAll = !markerUsable
      || fileRepairedAt === undefined
      || (fileWrittenAt !== undefined && marker.appliedAt !== undefined && fileWrittenAt < marker.appliedAt)
    const repaired = read.kind === 'ok'
      ? await this.repairDuplicatedReplay(replay)
      : { buckets: 0, removedTokens: 0, repaired: new Map<string, RepairBucket>(), short: 0 }
    if (repaired.buckets > 0) {
      // The correction is written before the peers are scanned and before the
      // record is updated: the clamp below compares a copy of this machine's file
      // against this ledger, so the ledger has to hold the corrected totals first.
      const written = await this.persistRepair(repaired.repaired)
      if (written !== undefined && written.corrected.size > 0) {
        // The keys are kept, the totals they were written at are not: a bucket
        // that was re-inflated after a correction never matched the recorded
        // total again, so the record locked it out of the repair for good. Keys
        // whose day left the window — or left this ledger — are dropped: an old
        // day cannot be judged any more, and a key for a day nobody holds would
        // otherwise sit in the record for ever.
        const oldest = localDateKey(Date.now() - (Math.max(1, this.options.retainDays) - 1) * 86_400_000)
        const kept = [...this.repairCorrected]
          .filter((key) => key.slice(0, 10) >= oldest && this.ledger.days[key.slice(0, 10)] !== undefined)
          // Newest first: the cap drops the oldest keys, not the ones the next
          // repair of a restored backup will need.
          .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
          .slice(0, REPAIR_CORRECTED_MAX)
        await writeJsonAtomic(join(this.persistDir, DEDUPE_MARKER_FILE), {
          version: 3,
          appliedAt: Date.now(),
          buckets: written.corrected.size,
          removedTokens: written.removedTokens,
          corrected: kept,
        }).catch(() => undefined)
      }
    }
    // Peers are scanned after the replay *and* after the repair. Whether an
    // unverified peer's day is already recorded here is judged bucket by bucket
    // against this ledger, and before the repair a bucket still holds the
    // duplicate copies — so the peer's own copy of those calls reads as "not
    // recorded yet" and is added on top, which is how the panel's total could
    // move when nothing but the order of the load changed.
    await this.refreshPeers(true)
    // Prune after the replay (it re-adds days retention already dropped) and
    // before the write below, so the file gets the pruned document too.
    this.lastPrune = undefined
    this.pruneIfNeeded()
    // Only now may flushes overwrite the persisted files.
    this.loaded = true
    // A rescan or an import that arrived during the load was deferred (scanning
    // then would fold a same-machine peer in twice); it runs now, against the
    // replayed ledger, and before the baseline below so its days are not counted
    // as growth on the first flush.
    if (this.peersScanPending) {
      this.peersScanPending = false
      await this.refreshPeers()
    }
    // A successful load restores the retry budget: a transient lock later in the
    // process's life must not find it spent.
    this.loadRetries = 0
    // Everything folded so far is already on disk: the first flush must add
    // only the calls that arrive after this point.
    this.ledgerWritten = structuredClone(this.ledger)
    if (read.kind !== 'corrupt' && !quarantinedUnreadable) this.ledgerError = undefined
    if (repaired.short > 0) {
      const which = repaired.short === 1 ? 'bucket holds' : 'buckets hold'
      this.note('repair-short', `${repaired.short} ${which} fewer calls than the duplicate-free replay — the ledger may be missing calls`)
    }
    // A bucket the exact gate left alone is left alone silently: the panel cannot
    // tell "one more real call" from "the copies landed twice", and warning about
    // an inflation that may not exist was worse than saying nothing.
    this.scheduleFlush()
  }

  /**
   * Record a non-fatal note the panel shows beside the numbers.
   *
   * Notes are keyed: a condition that holds on every flush ("retention
   * skipped …") must not append itself again and again, or the line the user
   * reads grows for as long as the process runs.
   */
  private note(kind: string, text: string): void {
    // Re-insert rather than overwrite: the panel shows the last three kinds, so a
    // condition that keeps recurring has to move to the end or a burst of newer
    // one-off notes pushes the important warning out of the line.
    this.notes.delete(kind)
    this.notes.set(kind, text)
    // The line shows five, but the map itself has to stay bounded too: a
    // per-day or per-peer kind would otherwise grow it for as long as the process
    // runs, and the oldest entries can never be shown again anyway. Eviction must
    // not take a note that reports history going missing: with two dozen peer
    // files, the oldest entry is exactly that warning, and the panel then showed
    // five "unverified" lines and no word about the days that were dropped.
    while (this.notes.size > NOTE_MAX) {
      const victim = [...this.notes.keys()].find((kind) => !(LEDGER_NOTE_ALWAYS as readonly string[]).includes(kind))
      if (victim === undefined) break
      this.notes.delete(victim)
    }
  }

  /** Drop a note whose condition no longer holds. */
  private clearNote(kind: string): void {
    this.notes.delete(kind)
  }

  /** Drop every note whose kind starts with `prefix` (peer notes, per scan). */
  private clearNotesWithPrefix(prefix: string): void {
    for (const kind of [...this.notes.keys()]) {
      if (kind.startsWith(prefix)) this.notes.delete(kind)
    }
  }

  /**
   * Whether a machine id taken from a file names this machine.
   *
   * Three cases count: the live pin, an id this profile used before (a lost
   * `machine-id.json` mints a new one while older files keep the old stamp), and
   * the derived digest that builds before the pin stamped into their files. All
   * three hold this machine's own history; summing any of them as a second device
   * would count those calls twice. Two machines whose host name, user and
   * platform are identical share a digest — that undercounts, which is the lesser
   * evil compared with a permanently doubled history.
   */
  private sameMachine(id: string): boolean {
    if (id === this.machine) return true
    if (this.machineAliases.has(id)) return true
    return id === localMachineId()
  }

  /** Remember an id this profile has written under, so its old files fold in. */
  private async rememberMachine(id: string | undefined): Promise<void> {
    if (id === undefined || id === this.machine) return
    this.machineAliases.add(id)
    // …and record it on disk. The set above only lasts this session, while the
    // next boot reads the alias list from the pin file — and that list is empty
    // after a fresh mint, which is exactly the case where the old id has to be
    // remembered (a lost pin, a host rename). Awaited rather than fired and
    // forgotten: a process that exits right after loading would otherwise lose
    // the only durable record of the old id, which is what makes a lost pin
    // double-count.
    await rememberMachineAlias(this.persistDir, id).catch(() => {})
  }

  /** The notes as one line, oldest first, capped so the panel stays readable. */
  private ledgerNoteText(): string | undefined {
    const entries = [...this.notes.entries()]
    // A note that reports history going missing must not be pushed off the end by
    // three routine ones (`snapshots`, `peer`, `replay-cap`): the panel would then
    // show a shorter history and say nothing about why.
    const always = entries.filter(([kind]) => (LEDGER_NOTE_ALWAYS as readonly string[]).includes(kind))
    const rest = entries.filter(([kind]) => !(LEDGER_NOTE_ALWAYS as readonly string[]).includes(kind))
    // `slice(-0)` returns the whole array, so an empty budget must not be passed
    // to it: five protected notes would then show every routine one as well.
    const room = LEDGER_NOTE_MAX - always.length
    const kept = room > 0 ? [...always, ...rest.slice(-room)] : always.slice(0, LEDGER_NOTE_MAX)
    return kept.length === 0 ? undefined : kept.map(([, text]) => text).join('; ')
  }

  /** Retry a ledger read that failed for a transient reason (lock, sharing). */
  private scheduleLoadRetry(): void {
    if (this.disposed || this.loadRetryTimer !== undefined) return
    if (this.loadRetries >= LOAD_RETRY_MAX) return
    this.loadRetries += 1
    this.loadRetryTimer = setTimeout(() => {
      this.loadRetryTimer = undefined
      void this.loadPersisted()
    }, LOAD_RETRY_MS)
  }

  /** Revive the probe cache and the spend watch; both are best-effort. */
  private async loadSnapshots(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.snapshotsPath, 'utf8')
    } catch (error) {
      // Absent is the normal first run; anything else (a locked or unreadable
      // file) costs the probe cache and the spend watch until it is fixed, which
      // the panel should say rather than showing a silently empty voucher.
      const code = (error as { code?: unknown }).code
      if (code !== 'ENOENT') this.note('snapshots', `probe cache unreadable (${String(code ?? error)}); balances start empty`)
      return
    }
    try {
      const parsed = parseJsonText(raw) as { providers?: Record<string, ProviderSnapshotState>; spendWatch?: SpendWatch }
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.providers === 'object' && parsed.providers !== null) {
        for (const [provider, snapshot] of Object.entries(parsed.providers)) {
          if (typeof snapshot === 'object' && snapshot !== null && typeof snapshot.provider === 'string') {
            this.snapshots.set(provider, snapshot)
          }
        }
      }
      // Revive the spend watch strictly: a corrupt accrual would otherwise
      // quietly rewrite the user's real-spend figure.
      const watch = readSpendWatch(parsed.spendWatch)
      if (watch !== undefined) this.spendWatch = watch
    } catch {
      // Snapshots are a cache of probe results: a corrupt one costs one poll.
    }
  }

  /**
   * Fold the session transcripts back into the ledger.
   *
   * `session/event` only carries records appended while an instance is
   * mounted, so calls made before the first mount — or during a remount
   * window — exist nowhere else. Every bucket is merged field by field with the
   * larger value winning: replay never shrinks a live bucket, and a ledger
   * rebuilt from an older transcript never loses a newer live fold, so running
   * this on every start is idempotent. (Field by field, because the two sides
   * can each carry a field the other lacks — a cost estimate, cache-read
   * tokens — and picking one bucket wholesale would delete them.)
   *
   * The pass also reports the duplicate copies it dropped, so the repair below
   * can use them without walking the transcripts (287 MB, ~18 s) again.
   */
  /**
   * The days of `doc` that the retention window still holds.
   *
   * Applied wherever a document is merged into this process's ledger outside the
   * load itself — the replay, a same-machine file under an older name: both
   * carry history the window has already dropped, and merging it back makes the
   * next prune meet a history it never wrote. The guard then refuses (correctly,
   * it cannot tell that case from a jumped clock), so the window would be
   * unappliable for as long as those documents keep arriving.
   */
  private windowedDocument(doc: UsageLedgerDocument): UsageLedgerDocument {
    const oldest = localDateKey(Date.now() - (Math.max(1, this.options.retainDays) - 1) * 86_400_000)
    const days: UsageLedgerDocument['days'] = {}
    for (const [dayKey, providers] of Object.entries(doc.days)) {
      if (dayKey < oldest) continue
      days[dayKey] = providers
    }
    return { ...doc, days }
  }

  private async replaySessionLogs(): Promise<ReplayPass> {
    const pass: ReplayPass = { doc: createLedgerDocument(), fullDoc: createLedgerDocument(), duplicates: new Map(), files: 0, replayed: 0, skipped: 0 }
    // Days the retention window has already dropped stay dropped. The replay
    // would otherwise re-add them from the transcripts — including the very
    // copies the repair just took out — and the next prune then sees a history
    // it never wrote and refuses, so the window could be applied once and never
    // again, with numbers worse than before the prune.
    const oldest = localDateKey(Date.now() - (Math.max(1, this.options.retainDays) - 1) * 86_400_000)
    try {
      const counts = await collectSessionLogUsage(join(dshHome(), 'sessions'), (replay) => {
        // The document the cross-process flush branches merge back is windowed
        // too: those branches run when another writer touched the file, and a
        // replay carrying days the window already dropped would resurrect them
        // there — the prune then sees a history it never wrote, refuses, and the
        // window can never be applied again (it did, permanently, before this).
        pass.fullDoc = replay
        pass.doc = this.windowedDocument(replay)
        for (const [dayKey, providers] of Object.entries(replay.days)) {
          if (dayKey < oldest) continue
          const atMs = new Date(dayKey + 'T12:00:00').getTime()
          if (!Number.isFinite(atMs)) continue
          const day = this.ledger.days[dayKey] ?? (this.ledger.days[dayKey] = {})
          for (const [provider, models] of Object.entries(providers)) {
            for (const [model, totals] of Object.entries(models)) {
              const folded = isDeepSeekProviderRoute(provider)
                ? { ...totals, cost: deepseekModelSpend(model, totals, atMs) }
                : totals
              // Match loosely: a bucket the ledger already holds under a drifted
              // spelling (`WorkBuddy` vs `workbuddy`) is the same bucket, and
              // adding a second one would bill the day twice.
              const found = findLedgerBucket(day, provider, model)
              if (found !== undefined) {
                // Merge per field, never bucket-for-bucket: the live fold may
                // hold cache-read tokens or a cost estimate the replay does not,
                // and "keep the larger bucket" would delete them.
                day[found.provider]![found.model] = maxTotals(found.totals, folded)
                continue
              }
              const route = day[provider] ?? (day[provider] = {})
              route[model] = folded
            }
          }
        }
      }, (dayKey, provider, model, totals) => {
        // The repair window follows the ledger, not the setting: a file written
        // under a wider window still holds days this one would drop, and their
        // copies have to be taken out while they are here — a day filtered out
        // here kept its duplicates forever and the marker never mentioned them
        // (the 392-call group on 2026-10-20 at a 7-day window). A day the ledger
        // no longer holds is dropped by the prune anyway, so collecting its
        // copies would only make the repair walk history that is about to go.
        if (dayKey < oldest && this.ledger.days[dayKey] === undefined) return
        const key = repairKey(dayKey, provider, model)
        const entry = pass.duplicates.get(key)
        if (entry === undefined) pass.duplicates.set(key, { dayKey, provider, model, totals: { ...totals } })
        else entry.totals = addTotals(entry.totals, totals)
      })
      pass.files = counts.files
      pass.replayed = counts.replayed
      pass.skipped = counts.skipped
    } catch {
      // A failed replay costs the pre-mount calls only; the live fold is intact.
    }
    return pass
  }

  /** Remember what a fold contributed, so a flush that adopts the disk file can put it back. */
  private rememberFold(doc: UsageLedgerDocument): void {
    if (this.foldedDoc === undefined) this.foldedDoc = structuredClone(doc)
    else mergeLedgerMaxFolded(this.foldedDoc, doc)
  }

  /**
   * Holds a copy of this machine's own ledger to what the repair left behind.
   *
   * A renamed copy of this device's file, or an export of it re-imported, was
   * written by a build that folded the duplicate copies: its buckets still carry
   * the inflated totals the repair has just taken out. Max-merging such a copy
   * would put them back on every boot and the flush would write them down again,
   * which is how a correction became permanent inflation. Days the copy alone
   * knows about are kept — those are history this file no longer has.
   */
  private clampToOwnTotals(doc: UsageLedgerDocument, onlyCorrected = false): void {
    for (const [dayKey, providers] of Object.entries(doc.days)) {
      const own = this.ledger.days[dayKey]
      if (own === undefined) continue
      for (const [provider, models] of Object.entries(providers)) {
        for (const [model, bucket] of Object.entries(models)) {
          // A bucket the repair corrected has one authority on this machine: this
          // ledger. Growth that happens afterwards is written here directly from
          // the transcripts, never through a peer, so a peer that still holds the
          // pre-repair value must not be able to raise it — whatever its mtime
          // says. That is why the clamp can be limited to those buckets and stop
          // trusting timestamps: a copy extracted from an archive gets a fresh
          // mtime, and the timestamp test then let it write the inflation back.
          if (onlyCorrected && !this.repairCorrected.has(repairKey(dayKey, provider, model))) continue
          const mine = findLedgerBucket(own, provider, model)?.totals
          if (mine === undefined) continue
          // Every field, not only `calls`: a copy of the pre-repair file can be
          // inflated in tokens alone (the duplicate copies carry cache reads and
          // an old estimate), and a calls-only test let that through untouched.
          const greater =
            bucket.calls > mine.calls ||
            bucket.inputTokens > mine.inputTokens ||
            bucket.outputTokens > mine.outputTokens ||
            bucket.cacheReadTokens > mine.cacheReadTokens ||
            bucket.cacheWriteTokens > mine.cacheWriteTokens ||
            bucket.reasoningTokens > mine.reasoningTokens ||
            bucket.cost > mine.cost
          if (!greater) continue
          models[model] = {
            calls: Math.min(bucket.calls, mine.calls),
            inputTokens: Math.min(bucket.inputTokens, mine.inputTokens),
            outputTokens: Math.min(bucket.outputTokens, mine.outputTokens),
            cacheReadTokens: Math.min(bucket.cacheReadTokens, mine.cacheReadTokens),
            cacheWriteTokens: Math.min(bucket.cacheWriteTokens, mine.cacheWriteTokens),
            reasoningTokens: Math.min(bucket.reasoningTokens, mine.reasoningTokens),
            cost: Math.min(bucket.cost, mine.cost),
          }
        }
      }
    }
  }

  /**
   * The buckets an earlier start already corrected, from the marker beside the
   * ledger.
   *
   * Missing, unreadable and corrupt all mean the same thing here: nothing is
   * known to be done, so the pass judges every bucket it finds. The marker is a
   * record of work, never a permission — a damaged one must not stop the repair.
   */
  private async readRepairCorrected(): Promise<{ corrected: Set<string>; appliedAt: number | undefined; version: number | undefined }> {
    const raw = await readFile(join(this.persistDir, DEDUPE_MARKER_FILE), 'utf8').catch(() => undefined)
    if (raw === undefined) return { corrected: new Set(), appliedAt: undefined, version: undefined }
    try {
      const parsed = parseJsonText(raw) as { corrected?: unknown; appliedAt?: unknown; version?: unknown }
      const list = Array.isArray(parsed.corrected) ? parsed.corrected : []
      // A key for a day that has not happened yet is a damaged record (a clock
      // that stepped forward when it was written, or a hand-edited file). Keeping
      // it would lock that bucket out of the repair for good once the day does
      // arrive, and nothing else would ever drop it.
      const today = localDateKey(Date.now())
      return {
        corrected: new Set(
          list.filter((key): key is string => typeof key === 'string' && key.slice(0, 10) <= today),
        ),
        appliedAt: typeof parsed.appliedAt === 'number' ? parsed.appliedAt : undefined,
        version: typeof parsed.version === 'number' ? parsed.version : undefined,
      }
    } catch {
      return { corrected: new Set(), appliedAt: undefined, version: undefined }
    }
  }

  /**
   * Correction for the seeded-subagent duplicate.
   *
   * A seeded subagent's transcript opens with a verbatim copy of its parent's
   * assistant messages (same id, time and usage), and the replay used to fold
   * both copies into the same bucket. Deduping the replay stops new inflation
   * but cannot undo what is already written — the merge rule keeps the larger
   * total, so an inflated bucket would never come back down.
   *
   * The subtraction is exact and happens once:
   *
   * - once per bucket: a bucket the marker lists was judged and rewritten by an
   *   earlier start, and a later start must not judge it again. Growth that
   *   arrives afterwards is indistinguishable from a copy landing again, and
   *   subtracting it would delete a call that really happened. The key is
   *   dropped once its day leaves the window, so no bucket stays out forever.
   * - whole copies only: the bucket has to sit a whole number of copies of this
   *   replay's duplicate above the duplicate-free total. Anything else — a
   *   bucket that grew, shrank, or holds a copy of another size — is left as
   *   recorded and not accused, because the panel cannot tell those apart.
   */
  private async repairDuplicatedReplay(replay: ReplayPass): Promise<RepairResult> {
    const repaired = new Map<string, RepairBucket>()
    let buckets = 0
    let removedTokens = 0
    let short = 0
    for (const [key, duplicate] of replay.duplicates) {
      // The ledger may spell the route differently than the transcript does
      // (`WorkBuddy` vs `workbuddy`): a bucket that drifted is still the bucket
      // the copies landed in.
      const target = findLedgerBucket(this.ledger.days[duplicate.dayKey], duplicate.provider, duplicate.model)
      if (target === undefined) continue
      // An earlier start corrected this bucket: whatever sits there now is what
      // the ledger states, and judging it again would take real calls away. The
      // exception is a file that predates that correction — a restored backup —
      // whose buckets are exactly the ones the repair is for.
      if (!this.repairRejudgeAll && this.repairCorrected.has(key)) continue
      const clean = findLedgerBucket(replay.fullDoc.days[duplicate.dayKey], duplicate.provider, duplicate.model)?.totals ?? emptyTotals()
      // A bucket already at the clean value was never inflated, or has been
      // corrected: the ordinary case for a seeded subagent whose ledger is right.
      if (target.totals.calls === clean.calls) continue
      // Fewer calls than the duplicate-free replay: nothing to subtract, but the
      // ledger is missing what the transcripts recorded, and that is stated once
      // instead of being folded into an accusation of inflation.
      if (target.totals.calls < clean.calls) {
        short += 1
        continue
      }
      // Three boots of the old build leave three copies of one call, so the
      // difference has to be counted in whole copies of this duplicate set.
      if (repairCopies(target.totals, clean, duplicate.totals) === undefined) continue
      const priced = this.priceBucket(duplicate.dayKey, target.provider, target.model, clean)
      // Cost is derived from the tokens, and the pricing table moves; what the
      // repair must not do is raise a bucket's spend above what the file recorded
      // (the copy's cost was already in there, and a newer table can price the
      // same tokens higher). Taking the lower of the two keeps the repair from
      // inventing spend while still letting it drop a copy's share.
      const next = { ...priced, cost: Math.min(target.totals.cost, priced.cost) }
      this.ledger.days[duplicate.dayKey]![target.provider]![target.model] = next
      repaired.set(key, { ...duplicate, provider: target.provider, model: target.model, clean, after: next })
      this.repairCorrected.add(key)
      buckets += 1
      removedTokens += totalTokens(target.totals) - totalTokens(next)
    }
    return { buckets, removedTokens, repaired, short }
  }

  /**
   * Price one bucket at its day's noon rate.
   *
   * Shared by the repair and the file-side pass so both write the same numbers:
   * the day is priced as a whole, which is why the noon instant stands in for
   * the calls inside it.
   */
  private priceBucket(dayKey: string, provider: string, model: string, totals: UsageTokenTotals): UsageTokenTotals {
    const atMs = new Date(dayKey + 'T12:00:00').getTime()
    return isDeepSeekProviderRoute(provider) && Number.isFinite(atMs)
      ? { ...totals, cost: deepseekModelSpend(model, totals, atMs) }
      : totals
  }

  /**
   * Fold a parsed document into a target ledger.
   *
   * Accumulates rather than replaces: folds that landed while the file was
   * being read (a session finishing during startup) must survive the load.
   */
  private absorb(into: UsageLedgerDocument, from: UsageLedgerDocument): void {
    for (const [dayKey, providers] of Object.entries(from.days)) {
      const atMs = new Date(dayKey + 'T12:00:00').getTime()
      for (const [provider, models] of Object.entries(providers)) {
        for (const [model, totals] of Object.entries(models)) {
          foldUsage(into, atMs, provider, model, totals)
        }
      }
    }
  }

  /**
   * One-time migration off `usage-ledger.json`.
   *
   * Renamed rather than deleted: if the migration is wrong the user's only
   * pre-existing history would otherwise be gone, and a `.migrated` sibling is
   * cheap. A failed rename (read-only directory) leaves the legacy file in
   * place — the next start retries, and the ledger is still summed in.
   *
   * The `.migrated` sibling is read as well: it is what a successful migration
   * leaves behind, and it is the only copy of the pre-migration history once
   * this device's file is deleted or damaged. Re-adopting it is safe — the fold
   * is a merge, and the buckets it restores are the ones the file states.
   */
  /**
   * Fold the pre-migration history back in after the ledger was lost.
   *
   * The oldest days predate the session transcripts this build replays, so the
   * ledger file is their only copy. When a corrupt file is quarantined the fresh
   * document starts empty and that history would be gone for good; the legacy
   * file (or its `.migrated` sibling) still states it, and the merge is a max —
   * it can only restore days the new document does not have.
   */
  private async restoreMigratedHistory(): Promise<void> {
    const legacyPath = join(this.persistDir, LEGACY_LEDGER_FILE)
    let restored = 0
    for (const path of [legacyPath, `${legacyPath}.migrated`]) {
      const raw = await readFile(path, 'utf8').catch(() => undefined)
      if (raw === undefined) continue
      try {
        const doc = deserializeLedger(parseJsonText(raw))
        const days = Object.keys(doc.days).length
        if (days === 0) continue
        mergeLedgerMaxFolded(this.ledger, doc)
        restored += days
      } catch {
        // Unparseable: leave it alone, the quarantine note already says the
        // current file was unreadable.
      }
    }
    if (restored === 0) return
    // The restored days are as old as the history gets: apply retention to them
    // the same way a normal load would, or the merge would resurrect days the
    // user already let go — through the guard, so a jumped clock cannot use the
    // restore as a way around it.
    this.pruneForWrite(this.ledger)
    this.note('legacy-restore', 'the quarantined ledger was rebuilt from the pre-migration file')
  }

  private async adoptLegacyLedger(): Promise<void> {
    const legacyPath = join(this.persistDir, LEGACY_LEDGER_FILE)
    const migratedPath = `${legacyPath}.migrated`
    const source = await readFile(legacyPath, 'utf8').then(
      (raw) => ({ raw, path: legacyPath }),
      () => readFile(migratedPath, 'utf8').then(
        (raw) => ({ raw, path: migratedPath }),
        () => undefined,
      ),
    )
    if (source === undefined) return // No legacy file: fresh install.
    try {
      // A `.migrated` file left by an earlier migration is history as well, and
      // the retired name is only a marker: its days belong in this ledger too, or
      // the second migration would keep just the half it just read. The two are
      // max-merged into one document before the absorb, not absorbed one after the
      // other: `retireLegacyFile` writes `.migrated` as a superset of the legacy
      // file, so adding both would count their shared days twice — and this path
      // runs again whenever the device file is missing or unreadable, which would
      // make that inflation permanent.
      const parsed = parseJsonText(source.raw)
      // Valid JSON that is not a ledger reads as zero days without throwing, and
      // the write below would then retire the only copy of that history as an
      // empty migration. Say so instead and leave the file where it is.
      const shaped = legacyDocumentOf(parsed)
      if (shaped === undefined) {
        this.note('legacy-unreadable', 'the pre-migration ledger is not a ledger document, so its history was not imported — inspect it beside this device\'s file')
        return
      }
      let doc = deserializeLedger(shaped)
      if (ledgerDayKeys(doc).length === 0 && Object.keys(shaped.days).length > 0) {
        this.note('legacy-unreadable', 'the pre-migration ledger holds no readable day, so its history was not imported — inspect it beside this device\'s file')
        return
      }
      if (source.path === legacyPath) {
        const previous = await this.readLedgerDocument(migratedPath)
        if (previous !== undefined) {
          const merged = structuredClone(previous)
          mergeLedgerMax(merged, doc)
          doc = merged
        }
      }
      this.absorb(this.ledger, doc)
      // Through the guard, not a bare prune: the legacy days are the oldest
      // history this profile has, and a jumped clock would otherwise drop them
      // here without a word — the very silence the guard exists to prevent.
      this.pruneForWrite(this.ledger)
      this.lastPrune = { dayKey: localDateKey(Date.now()), retainDays: this.options.retainDays }
    } catch {
      // Unparseable legacy file: leave it untouched for the user to inspect —
      // but say it out loud, because a migration that quietly does nothing
      // leaves the history looking like it was never there.
      this.note('legacy-unreadable', 'the pre-migration ledger could not be read, so its history was not imported — inspect it beside this device\'s file')
      return
    }
    // Written before the rename so a crash mid-migration cannot lose the data.
    // Not `flushLedger()`: that defers to `loaded`, and the migration runs
    // precisely while `loaded` is still false. The write goes straight to this
    // device's file instead, and only a successful one retires the legacy file.
    // Under the lock like every other write of this file: another process may
    // have started and written its own history in the meantime. A lock that
    // stays taken is a stand-down, not a reason to write anyway: this path also
    // renames the legacy file, and doing that behind another writer's back is
    // how the only copy of the old history gets retired for nothing.
    let wrote = false
    const written = await this.withLedgerLock(async (held) => {
      if (!held) return
      await mkdir(dirname(this.ledgerPath), { recursive: true })
      const disk = await this.readDiskLedger()
      if (disk.kind === 'ok') mergeLedgerMax(this.ledger, disk.doc)
      await writeJsonAtomic(
        this.ledgerPath,
        ledgerFileDocument(this.ledger, { machine: this.machine, retentionDays: this.declaredWindow() }),
      )
      wrote = true
    }).then(
      () => true,
      () => false,
    )
    if (written && !wrote) {
      this.note('legacy-locked', 'the ledger lock stayed taken, so the pre-migration history was not imported — restart to try again')
    }
    if (written && wrote && source.path === legacyPath) await this.retireLegacyFile(legacyPath, migratedPath)
  }

  /**
   * Retire the legacy ledger once its days are in this device's file.
   *
   * A `.migrated` file from an earlier migration is history as well, so renaming
   * over it would silently drop the days it holds; both are merged instead.
   */
  private async retireLegacyFile(legacyPath: string, migratedPath: string): Promise<void> {
    const previous = await this.readLedgerDocument(migratedPath)
    if (previous === undefined) {
      await rename(legacyPath, migratedPath).catch(() => undefined)
      return
    }
    const current = await this.readLedgerDocument(legacyPath)
    if (current === undefined) return
    mergeLedgerMax(previous, current)
    const ok = await writeJsonAtomic(migratedPath, previous).then(
      () => true,
      () => false,
    )
    if (ok) await rm(legacyPath, { force: true }).catch(() => undefined)
  }

  /** A ledger file's days, or undefined when it is absent or unparseable. */
  private async readLedgerDocument(path: string): Promise<UsageLedgerDocument | undefined> {
    try {
      return deserializeLedgerStrict(parseJsonText(await readFile(path, 'utf8')))
    } catch {
      return undefined
    }
  }

  /**
   * Keep the newest few quarantined ledgers and drop the rest.
   *
   * Every unreadable or corrupt boot writes one of these, and each is a full copy
   * of a ledger that can be megabytes. A handful is enough to inspect by hand;
   * without a cap, a profile that keeps failing quietly fills the directory with
   * copies of the same broken file.
   */
  private async trimQuarantine(keep?: string, limit = 3): Promise<void> {
    const prefix = `${basename(this.ledgerPath)}.`
    const names = await readdir(this.persistDir).catch(() => [] as string[])
    // The file this boot just wrote is never a candidate: its mtime ties with a
    // decoy written in the same millisecond, and deleting it would take the only
    // forensic copy of the user's ledger while `ledgerError` still names it.
    // `keep` arrives as a full path while the candidates are bare names, so the
    // exclusion compares basenames — comparing the path never matched, and the
    // named copy was trimmed like any other.
    const keepName = keep === undefined ? undefined : basename(keep)
    const mine = names
      .filter((name) => name.startsWith(prefix) && /\.(unreadable|corrupt)-\d+\.json$/.test(name))
      .filter((name) => name !== keepName)
    const keepCount = keepName === undefined ? 0 : 1
    if (mine.length + keepCount <= limit) return
    const dated = await Promise.all(
      mine.map(async (name) => ({
        name,
        at: await stat(join(this.persistDir, name)).then(
          (info) => info.mtimeMs,
          () => 0,
        ),
      })),
    )
    // Newest first, with the write instant as the tiebreak: without it two files
    // written in the same millisecond sort arbitrarily and the survivor changes
    // per boot. The instant is the number the name ends in, not the name itself:
    // `corrupt-…` sorts before `unreadable-…`, so comparing whole names would let
    // the kind decide which copy counts as newer.
    const instantOf = (name: string): number => {
      const match = /(\d+)\.json$/.exec(name)
      return match === null ? 0 : Number(match[1])
    }
    dated.sort((a, b) => b.at - a.at || instantOf(b.name) - instantOf(a.name) || a.name.localeCompare(b.name))
    for (const { name } of dated.slice(Math.max(0, limit - keepCount))) {
      await rm(join(this.persistDir, name), { force: true }).catch(() => undefined)
    }
  }

  /**
   * Re-read every peer ledger file in the persist directory.
   *
   * Peers are whatever `usage-ledger.<deviceId>.json` files are present, so
   * "importing" a device is just dropping its file in — and re-importing the
   * same file changes nothing, because the totals are derived from the set of
   * files rather than accumulated into state.
   *
   * A file only counts as a device when its own document proves which machine
   * wrote it: this build stamps `deviceId` and `machine` into every ledger it
   * writes, so a file without them is a copy (a renamed backup, a hand-placed
   * duplicate) and summing it would count this machine's calls twice. Every
   * refusal is reported rather than swallowed, because a silently missing
   * device reads exactly like a device that never existed.
   */
  private async refreshPeers(fromLoad = false): Promise<void> {
    if (!this.loaded && !fromLoad) {
      // A scan started before the load has finished folds a same-machine peer into
      // a ledger the replay has not rebuilt yet; the load then absorbs the local
      // file on top and the peer's copy of those days is counted twice — and the
      // next flush writes that total down. Rescan/import are user-triggered and can
      // arrive in that window, so the scan is deferred to the end of the load
      // instead of being refused.
      this.peersScanPending = true
      return
    }
    let names: string[]
    try {
      names = await readdir(this.persistDir)
    } catch (error) {
      // The directory may be a network share or a removable drive that is
      // briefly gone. Dropping every peer would silently shrink every total, so
      // keep what we last read and say why the scan failed.
      this.peersError = `peer scan failed (${error instanceof Error ? error.message : String(error)})`
      return
    }
    const peers: LoadedLedgerFile[] = []
    const failures: string[] = []
    // Peer notes describe the scan that produced them: a file the user deleted
    // must stop being reported, so each scan starts from a clean slate.
    this.clearNotesWithPrefix('unverified:')
    this.clearNotesWithPrefix('renamed:')
    this.clearNotesWithPrefix('same-machine:')
    for (const name of names) {
      const file = basename(name)
      const deviceId = deviceIdOfFile(file)
      if (deviceId === undefined) continue
      // Our own ledger. Copies of it (`…p15-22893b.bak.json`) never reach this
      // point: `deviceIdOfFile` rejects dotted names, so a backup is not a device.
      if (deviceId === this.deviceId) continue
      const filePath = join(this.persistDir, name)
      try {
        const [raw, info] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)])
        const parsed = parsePeerLedger(parseJsonText(raw))
        if (parsed === undefined) {
          failures.push(`${name}: not a usage ledger`)
          continue
        }
        // The document must name the device it arrived as, and it must not be
        // this machine: a bare document carries no proof, a renamed copy names
        // another id, and a copy of our own file names our machine.
        if (parsed.deviceId === '') {
          failures.push(`${name}: no device id in the document, not summed`)
          continue
        }
        if (parsed.deviceId !== deviceId) {
          failures.push(`${name}: names device ${parsed.deviceId}`)
          continue
        }
        if (parsed.machine === undefined) {
          // Exported before this build stamped a machine id. Its device id is not
          // ours and it is not a bare document, so it is a real peer file — but
          // nothing in it proves which machine wrote it, and a file copied from
          // this machine's own export carries exactly this shape. Summing it whole
          // is how a copy of our own history got counted twice (2,766 calls on one
          // day), and dropping it loses a peer's history; so it contributes only
          // the days this machine has never recorded.
          // ... and the unit is the bucket, not the day: a peer that ran a model
          // this machine never did, on a day it did run others, holds a real
          // bucket there. Judging by the day alone dropped it while the note said
          // the day was "already recorded".
          // ... and what it contributes is the difference, not the whole bucket:
          // dropping a bucket this machine has any record of made the peer's
          // calls disappear the moment this machine recorded its first call of
          // the same day/provider/model (a total that fell by 4 with no user
          // action). A true copy of this machine's own file subtracts to nothing.
          const unrecorded: UsageLedgerDocument['days'] = {}
          let taken = 0
          for (const [day, buckets] of Object.entries(parsed.doc.days)) {
            const local = this.ledger.days[day]
            const kept: UsageLedgerDocument['days'][string] = {}
            for (const [provider, models] of Object.entries(buckets)) {
              for (const [model, totals] of Object.entries(models)) {
                // A bucket the repair corrected is this machine's own history: a
                // file that still holds the pre-repair value would otherwise hand
                // the copies the repair removed straight back as "what the peer
                // holds beyond this machine's record", and the panel would blame
                // another device for them.
                if (this.repairCorrected.has(repairKey(day, provider, model))) continue
                const mine = findLedgerBucket(local, provider, model)?.totals
                const extra = mine === undefined ? totals : subtractTotals(totals, mine)
                // A residual with no calls is not a bucket: the subtraction runs
                // field by field, so a peer that recorded cache reads where this
                // machine recorded output leaves 84.6 M tokens behind with no
                // calls to attach them to — a row that never existed, and one the
                // service total then carries as tokens without usage. Those
                // tokens belong to the calls already counted here, so the bucket
                // counts as recorded and contributes nothing.
                if (extra.calls <= 0) continue
                kept[provider] = { ...(kept[provider] ?? {}), [model]: extra }
                taken += 1
              }
            }
            if (Object.keys(kept).length > 0) unrecorded[day] = kept
          }
          // A file that adds nothing is not a device in the list: counting it
          // would show a second machine whose rows all read zero, and the note
          // below already says why it contributed nothing.
          if (taken > 0) {
            peers.push({ deviceId, machine: undefined, doc: { ...parsed.doc, days: unrecorded }, updatedAt: info.mtimeMs })
          }
          this.note(
            `unverified:${deviceId}`,
            taken === 0
              ? `${name}: unverified (no machine id in the document), and every bucket in it is already recorded here, so it was not counted`
              : `${name}: unverified (no machine id in the document), so only what the ${taken} ${taken === 1 ? 'bucket holds' : 'buckets hold'} beyond this machine's own record were counted`,
          )
          continue
        }
        if (parsed.machine !== undefined && this.sameMachine(parsed.machine)) {
          // This machine under an older name or an older pin: the host was
          // renamed, or `machine-id.json` was lost and a new id minted while this
          // file kept the old one. Its calls are this machine's own, so they are
          // folded in (max merge: the same days are also replayed from the
          // transcripts) instead of being summed as a second device — and the file
          // itself is left where it is, because a peer may still be reading it.
          // ... and only as far as the window still reaches: the file may hold
          // history this profile already let go, and folding it back would leave
          // the prune with days it never wrote.
          const doc = this.windowedDocument(parsed.doc)
          // A copy written by a build that folded the duplicates still holds the
          // inflated totals the repair has taken out. Whether it was written
          // before or after that repair is not something its mtime can be trusted
          // to say — unzipping or copying a file gives it today's mtime, and then
          // the pre-repair values came back on every boot. What can be trusted is
          // the record of which buckets were corrected: for those, this ledger is
          // the authority, so the copy is clamped to it; for every other bucket
          // the max merge below still lets a peer's newer calls through.
          this.clampToOwnTotals(doc, true)
          mergeLedgerMaxFolded(this.ledger, doc)
          this.rememberFold(doc)
          this.note(`renamed:${deviceId}`, `${name}: this machine under an older name, folded in rather than summed`)
          continue
        }
        // The file name is authoritative for which device it is: a renamed
        // peer file must not silently impersonate another device.
        peers.push({ deviceId, machine: parsed.machine, doc: parsed.doc, updatedAt: info.mtimeMs })
      } catch {
        failures.push(`${name}: unreadable`)
      }
    }
    // One machine can leave two files behind: a peer host that was renamed mints
    // a new device id while `machine-id.json` keeps the pin, and the old export
    // may still sit beside the new one. Summing both counts that peer's calls
    // twice, so a repeated machine is folded into the first file that names it —
    // max merge, the same rule this machine's own older names get above.
    const byMachine = new Map<string, LoadedLedgerFile>()
    const folded: LoadedLedgerFile[] = []
    for (const peer of peers) {
      const machine = peer.machine
      if (machine === undefined) {
        folded.push(peer)
        continue
      }
      const first = byMachine.get(machine)
      if (first === undefined) {
        byMachine.set(machine, peer)
        folded.push(peer)
        continue
      }
      mergeLedgerMaxFolded(first.doc, peer.doc)
      first.updatedAt = Math.max(first.updatedAt ?? 0, peer.updatedAt ?? 0)
      this.note(
        `same-machine:${peer.deviceId}`,
        `${peer.deviceId}: the same machine as ${first.deviceId}, folded in rather than counted twice`,
      )
    }
    folded.sort((a, b) => a.deviceId.localeCompare(b.deviceId))
    this.peers = folded
    this.peersError = failures.length === 0 ? undefined : failures.join('; ')
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined || this.disposed) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flushLedger()
    }, FLUSH_DEBOUNCE_MS)
  }

  /**
   * Queue one ledger flush behind the previous one. Debounce and stop-time
   * flushes serialize here, so two `writeJsonAtomic` calls can never run
   * concurrently on the same path.
   */
  private flushLedger(): Promise<void> {
    const next = this.flushChain.then(() => this.writeLedgerOnce())
    this.flushChain = next.catch(() => {})
    return next
  }

  private async writeLedgerOnce(): Promise<void> {
    // Never overwrite the persisted file before it has been loaded: a flush
    // racing the load window would otherwise clobber history with a partial
    // document.
    if (!this.loaded) return
    try {
      await mkdir(dirname(this.ledgerPath), { recursive: true })
      // Two DSH processes on one machine write this same file (two windows, or
      // the CLI beside the desktop app) and each writes the whole document, so
      // the last flush would otherwise own the history. The lock serialises the
      // read-merge-write below; without it both sides can read the same version
      // and the later write silently drops the earlier one's calls until the
      // next restart replays them.
      await this.withLedgerLock(() => this.writeLedgerLocked())
    } catch (error) {
      // Persistence failures must not stop the counting, but the panel has to
      // say why these numbers will not survive a restart.
      this.ledgerError = `ledger write failed (${error instanceof Error ? error.message : String(error)})`
    }
  }

  /**
   * Run `work` while holding the ledger lock file.
   *
   * The lock is advisory and best effort by design: a stale lock (a crashed
   * process) must not block writing forever, so it is broken after
   * `LOCK_STALE_MS`, and a run that cannot take it proceeds anyway — losing one
   * interleaved write is recoverable on the next replay, while refusing to write
   * at all loses every call made after it.
   */
  private async withLedgerLock(work: (held: boolean) => Promise<void>): Promise<boolean> {
    const lockPath = `${this.ledgerPath}.lock`
    // The token says which process holds the lock, so the release below can tell
    // its own lock from one another process broke and took over.
    const token = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
    let handle: FileHandle | undefined
    // A lock was really there (EEXIST), as opposed to an open that failed for
    // another reason (a permission error is not a race, and saying so would blame
    // another process for a lock no one took).
    let sawLock = false
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        handle = await open(lockPath, 'wx')
        // The token is what makes the release safe, so a lock whose token could
        // not be written is not held: closing the handle and removing the file is
        // better than holding an empty lock no other process can ever recognise.
        const wrote = await handle.writeFile(token).then(
          () => true,
          () => false,
        )
        if (!wrote) {
          await handle.close().catch(() => {})
          handle = undefined
          await rm(lockPath, { force: true }).catch(() => {})
        }
        break
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') break
        sawLock = true
        // Read the holder's token before judging the age, so the break below can
        // tell the lock it saw from one another process released and re-took in
        // between: comparing against a token generated here always differs, which
        // made the test vacuous and let a live holder's lock be removed.
        const seen = await readFile(lockPath, 'utf8').catch(() => undefined)
        const age = await stat(lockPath).then((info) => Date.now() - info.mtimeMs, () => 0)
        if (seen !== undefined && age > LOCK_STALE_MS) {
          const again = await readFile(lockPath, 'utf8').catch(() => undefined)
          if (again === seen) await rm(lockPath, { force: true }).catch(() => undefined)
          continue
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
      }
    }
    if (handle === undefined && sawLock) {
      // The lock stayed taken for the whole budget: a live holder, not a crash.
      // Writing anyway is still better than losing every call made after this
      // point, but it is said out loud — an interleaved write is the one failure
      // the merge cannot undo on its own.
      this.note('lock-busy', 'the ledger lock stayed taken; this write may have raced another process')
    }
    // Whether *this* write held the lock decides whether it may retire the note
    // above: clearing it from a write that never waited would hide the very race
    // the note is about.
    this.lockHeld = handle !== undefined
    const held = handle !== undefined
    try {
      await work(held)
    } finally {
      await handle?.close().catch(() => {})
      if (handle !== undefined) {
        // Only the lock this run created is removed: if it went stale and another
        // process broke and re-took it, deleting the file would hand a third
        // writer the same section.
        const current = await readFile(lockPath, 'utf8').catch(() => undefined)
        if (current === token) await rm(lockPath, { force: true }).catch(() => {})
      }
    }
    // Reported so the two read-modify-write callers (import, repair) can stand
    // down instead of writing a view they could not make exclusive: an append to
    // our own document is recoverable, replacing another writer's merge is not.
    return held
  }

  private async writeLedgerLocked(): Promise<void> {
    // Take the file's version and add only our own growth since our last write.
    // The view before the merge is kept: a failed write leaves the file without
    // the other writer's calls, so the merged view must not survive in memory —
    // the next delta would add those calls a second time. The copy is deep, not a
    // reference: the prune below mutates the live document, so restoring a
    // reference would restore the pruned state.
    const before = structuredClone(this.ledger)
    // `pruneForWrite` moves the retention bookkeeping and emits a note before the
    // bytes are written, so a failed write has to put those back too.
    const retention = this.retentionSnapshot()
    const disk = await this.readDiskLedger()
    if (disk.kind === 'bad') {
      // The bytes may be a real ledger we merely failed to parse: writing
      // over them would destroy the only copy.
      this.ledgerError = `ledger unreadable (${disk.error}); write skipped`
      // A file that now names ANOTHER device (a sync or restore tool dropped it
      // here) stops every write for the rest of the session. The next boot
      // renames it to that device's file, reads "missing" and clears the error,
      // so without a note the stranded calls simply disappear.
      const foreign = foreignDeviceOf(disk.error)
      if (foreign !== undefined) {
        this.note('ledger-foreign', `the ledger file names device ${foreign}; this session's calls are not being written — restart to adopt it as a peer`)
      }
      return
    }
    if (disk.kind === 'ok') {
      const target = disk.doc
      const stamp = disk.repairedAt ?? 0
      // Any machine id this file carries is a name this profile has written
      // under, so its older files stay recognisable as this machine.
      await this.rememberMachine(disk.machine)
      if (stamp > this.seenRepairedAt) {
        // The file was corrected after we loaded it. Our copy still holds the
        // inflated buckets, so the max merge below would raise them right back
        // — the repair would be undone by the very next flush. Take the file's
        // (repaired) document and add only the calls that arrived here since
        // our last write.
        this.seenRepairedAt = stamp
        if (this.ledgerWritten !== undefined) mergeLedgerDelta(target, this.ledger, this.ledgerWritten)
        // A replay recovers buckets the file never held; a delta cannot carry
        // them, so they are merged in explicitly (max: never lowers a bucket).
        if (this.replayDoc !== undefined) mergeLedgerMax(target, this.replayDoc)
        // What a peer fold contributed is not in the file and not in the delta
        // either (the delta is measured against the file this process last
        // wrote, which already carried the fold). Without this merge, another
        // writer's newer stamp silently dropped the folded device's days.
        if (this.foldedDoc !== undefined) mergeLedgerMaxFolded(target, this.foldedDoc)
      } else if (this.seenRepairedAt > 0 && stamp < this.seenRepairedAt) {
        // We know this file was corrected, but the copy on disk carries an older
        // (or no) stamp: a process running the previous build rewrote it whole, a
        // backup with an older stamp was restored, or our own correction never
        // reached the disk (a failed write leaves the inflated file behind).
        // Adopting it would put the inflated buckets straight back into memory and
        // the correction would be lost for good — so the document we write is our
        // own, and the file only contributes the calls it gained since our last
        // write.
        this.note('stale-writer', 'the file on disk predates the ledger repair; its inflated buckets were not re-adopted')
        const own = structuredClone(this.ledger)
        // Only buckets we do not hold at all are taken from that file. A bucket we
        // already have is kept as it stands: in this branch the file is known to be
        // older than the correction, so a larger number there is the copy the
        // repair removed (or an unreadable amount of new calls) — and no later
        // merge can bring a wrongly subtracted call back, while a resurrected copy
        // is permanent inflation. A day the file holds and we do not is different:
        // that is history this boot never saw, so it is taken. The calls that are
        // not adopted are counted out loud, because a writer that keeps running
        // re-adds them on its next flush while a silent drop looks like lost data.
        let droppedCalls = 0
        for (const [dayKey, providers] of Object.entries(target.days)) {
          for (const [provider, models] of Object.entries(providers)) {
            for (const [model, totals] of Object.entries(models)) {
              const day = own.days[dayKey] ?? (own.days[dayKey] = {})
              const existing = findLedgerBucket(day, provider, model)
              if (existing !== undefined) {
                droppedCalls += Math.max(0, totals.calls - existing.totals.calls)
                continue
              }
              day[provider] = { ...(day[provider] ?? {}), [model]: { ...totals } }
            }
          }
        }
        if (droppedCalls > 0) {
          this.note(
            'stale-writer',
            `the file on disk predates the ledger repair; ${droppedCalls} call(s) it gained under an older build were not re-adopted`,
          )
        }
        if (this.replayDoc !== undefined) mergeLedgerMax(own, this.replayDoc)
        this.pruneForWrite(own)
        this.ledger = own
        try {
          await writeJsonAtomic(this.ledgerPath, this.ledgerFileDocument())
        } catch (error) {
          // The write never landed: keep the view this process had, so the next
          // delta is measured against what the file actually holds.
          this.ledger = before
          this.restoreRetention(retention)
          throw error
        }
        this.ledgerWritten = structuredClone(this.ledger)
        this.ledgerError = undefined
        this.fileRetention = this.recordedWindow()
        this.shrankTo = undefined
        // The clock the next slab test measures against: days that fall out of
        // the window while the file sits still are the window moving, not a jump.
        this.ledgerWrittenAt = Date.now()
        // The note stays for the rest of this flush cycle on purpose: it says what
        // happened to the file, and a note that vanished inside the same write
        // would never reach the panel. The next successful flush clears it.
        return
      } else {
        if (this.ledgerWritten !== undefined) mergeLedgerDelta(target, this.ledger, this.ledgerWritten)
        // A replay recovers buckets the file never held: that is not
        // expressible as growth, so the delta is completed by the max merge.
        mergeLedgerMax(target, this.ledger)
      }
      this.pruneForWrite(target)
      // Adopt the merged document: our view then includes the other
      // process's calls, and the next delta is measured against it.
      this.ledger = target
    } else {
      // The file was missing when it was read, and without the lock there is no
      // merge to fall back on: a second writer that exhausted the same budget
      // could create the file between this read and the rename below, and this
      // document — which never saw those calls — would overwrite it. Keeping the
      // calls in memory for one more flush interval is the cheap side of that
      // trade; the lock clears itself within LOCK_STALE_MS.
      if (!this.lockHeld) {
        this.scheduleFlush()
        return
      }
      this.pruneForWrite(this.ledger)
    }
    try {
      await writeJsonAtomic(this.ledgerPath, this.ledgerFileDocument())
    } catch (error) {
      // The merged view was never written: restoring the pre-merge ledger keeps
      // the next delta honest (otherwise the other writer's calls, folded in here
      // but absent from the file, would be added to it a second time).
      this.ledger = before
      this.restoreRetention(retention)
      throw error
    }
    this.ledgerWritten = structuredClone(this.ledger)
    this.ledgerError = undefined
    // The file now records this window; the next prune compares against it.
    this.fileRetention = this.recordedWindow()
    this.shrankTo = undefined
    this.ledgerWrittenAt = Date.now()
    // The file now carries our identity again, so the warning about a build
    // that stripped it no longer applies.
    this.clearNote('stale-writer')
    // Only a write that held the lock proves the contention is over; one that
    // went ahead without it must leave the warning standing.
    if (this.lockHeld) this.clearNote('lock-busy')
    // The `ledger-unreadable` note is deliberately *not* cleared here: the file
    // it talks about was moved aside with history inside it, and a note that
    // lives three seconds — one flush — is a note nobody reads. It stands for
    // the rest of the session; the next boot reads the fresh file.
  }

  /** This process's ledger as a file document: the identity travels with it. */
  private ledgerFileDocument(): UsageLedgerDocument & { deviceId: string; machine: string; repairedAt?: number } {
    // `this.machine` is the pinned id: the wrapper's own fallback derives a
    // digest from host, platform and user, which changes the moment the host is
    // renamed — the exact event the pinned id exists to survive.
    return ledgerFileDocument(this.ledger, {
      machine: this.machine,
      ...(this.seenRepairedAt > 0 ? { repairedAt: this.seenRepairedAt } : {}),
      // A refused prune must not stamp the window it refused to apply: the days
      // it kept are outside that window, and the number is what an import or a
      // peer scan carries as "how much this file holds". Keeping the window the
      // file already recorded leaves the two consistent.
      retentionDays: this.declaredWindow(),
    })
  }

  /** The retention window a written document may honestly claim. */
  private declaredWindow(): number {
    return this.windowRefused ? (this.fileRetention ?? this.recordedWindow()) : this.recordedWindow()
  }

  /** The retention bookkeeping a write may move before it fails. */
  private retentionSnapshot(): RetentionSnapshot {
    return {
      seen: this.retentionSeen,
      shrankTo: this.shrankTo,
      refused: this.windowRefused,
      note: this.notes.get('retention'),
      // The jump refusal lives under its own key: restoring the flag without its
      // sentence would leave the panel telling the user to delete a healthy file.
      jumpNote: this.notes.get('retention-jump'),
    }
  }

  /** Put that bookkeeping back after a write that never landed. */
  private restoreRetention(snapshot: RetentionSnapshot): void {
    this.retentionSeen = snapshot.seen
    this.shrankTo = snapshot.shrankTo
    this.windowRefused = snapshot.refused
    if (snapshot.note === undefined) this.clearNote('retention')
    else this.notes.set('retention', snapshot.note)
    if (snapshot.jumpNote === undefined) this.clearNote('retention-jump')
    else this.notes.set('retention-jump', snapshot.jumpNote)
  }

  /**
   * The window the file should record as the one its days were pruned against.
   *
   * Normally the setting. While a prune is refused, the window the file carried
   * before the jump — otherwise the refusal would last exactly one flush: the
   * next pass would find no day "outside the file's own window" and prune them.
   */
  private recordedWindow(): number {
    if (!this.windowRefused) return this.options.retainDays
    return Math.max(this.fileRetention ?? this.options.retainDays, this.options.retainDays)
  }

  /**
   * Prune a document about to be written, refusing a prune that would delete
   * most of the history at once.
   *
   * Retention is measured against the clock, so one jump forward (a dead BIOS
   * battery, an NTP correction, a timezone change read as a new date) would
   * otherwise drop every day outside the window in a single flush — silently,
   * because the panel simply shows fewer days.
   */
  private pruneForWrite(doc: UsageLedgerDocument): number {
    const todayKey = localDateKey(Date.now())
    const days = Object.keys(doc.days).length
    const prunable = countPrunable(doc, todayKey, this.options.retainDays)
    // A user who lowers retention is asking for exactly this prune, so one shrink
    // is honoured (the threshold exists for a clock that jumped, not for a
    // settings change). A jump looks different from a shrink: the file's own
    // window would already have dropped those days, so a day still on disk
    // *outside* that window means the clock moved, not the setting.
    const fileWindow = Math.max(this.fileRetention ?? this.options.retainDays, this.options.retainDays)
    // The evidence only exists when the file records the window it was pruned
    // against: a file from an older build keeps no such record, and its days
    // would look stale merely because the setting is narrower than they are.
    const stale = this.fileRetention === undefined ? 0 : countPrunable(doc, todayKey, fileWindow)
    const seenBefore = this.retentionSeen
    const shrank = this.options.retainDays < seenBefore || this.shrankTo === this.options.retainDays
    // Two prunes to refuse. A jumped clock asks for days outside the file's own
    // window to go, and more than half the history in a single pass: it is a share
    // of the history, not a count of survivors, because a replay can rebuild days
    // near the new "today" while the days recorded before the jump all fall out —
    // two days of ordinary use were enough to make the survivor count look healthy
    // and delete the history. A shrink is honoured for the *size* of what it drops
    // (its days are inside the file's own window, so it never trips the share), but
    // never for wiping the ledger: that case has no honest reading either way, and
    // the days a wipe takes have no transcripts to rebuild them from. So the
    // all-days refusal is not exempted by a shrink; the note says how to accept it.
    // The share test above needs the file's own window, so it says nothing about
    // a file that records none — and there is deliberately no extra "nearly
    // everything" net for those. Such a net cannot tell a clock jump from a user
    // who really wants a one-day window: it refused that setting forever while a
    // two-day window went straight through, the same evidence read two ways. A
    // prune that drops days nobody asked for is still reported out loud (see
    // `jumped` below).
    // The all-days refusal is the last line of defence against a jumped clock
    // emptying the file, and it stays unconditional: the days it protects have no
    // transcripts to rebuild them from. Its note says how to accept the prune.
    const jump = (stale > 0 && prunable > days * 0.5) || prunable === days
    if (days > 0 && jump) {
      // Sticky on purpose: the file keeps the old window (see `recordedWindow`),
      // so the next flush and the next boot see the same evidence and refuse the
      // same prune instead of accepting it as ordinary retention.
      this.windowRefused = true
      // A shrink is the user's own doing, so the note names the window they set
      // instead of blaming the clock: a 365→30 change used to read "the clock
      // would drop 3 of 3 recorded days", which is wrong on every deliberate
      // change and hides the one action that helps (raising the window again).
      this.note(
        'retention-jump',
        shrank
          ? `retention skipped: the ${this.options.retainDays}-day window would drop ${prunable} of ${days} recorded days — raise the window to keep them, or delete the ledger file (and any .migrated copy beside it) to accept it`
          : `retention skipped: the clock would drop ${prunable} of ${days} recorded days — if the clock is right, delete the ledger file (and any .migrated copy beside it) to accept it`,
      )
      return 0
    }
    this.windowRefused = false
    // The refusal did not survive this pass: the prune it warned about is either
    // done or no longer asked for, and its advice ("delete the ledger file") is
    // destructive to leave standing.
    this.clearNote('retention-jump')
    if (shrank) this.shrankTo = this.options.retainDays
    this.retentionSeen = Math.min(this.retentionSeen, this.options.retainDays)
    const pruned = pruneLedger(doc, todayKey, this.options.retainDays)
    // A jump drops a whole slab in one pass, where a steady clock drops one a
    // day. A shrink can do the same, but it is the user's own doing: blaming the
    // clock for it was wrong on essentially every deliberate 180→7, so the
    // warning is only for a prune nothing asked for.
    const jumped = !shrank && days >= 4 && pruned > days * 0.3
    // One day falling out is how a window moves; two or more in one pass is a
    // slab, and a slab nobody asked for is worth saying out loud even when it is
    // a minority of the history — 3 of 11 days went silently because the share
    // test needs 30%, and the days are gone either way.
    // A run that was merely idle drops exactly the days that aged out while it
    // was closed, so the size of the drop is measured against the elapsed days:
    // two days falling out after two days away is the window moving, not a slab.
    const idleDays =
      this.ledgerWrittenAt === undefined ? 0 : Math.floor((Date.now() - this.ledgerWrittenAt) / 86_400_000)
    const slab = !shrank && pruned > Math.max(1, idleDays)
    if (pruned > 0 && (shrank || slab)) {
      // A shrink is the user's own doing, so it is honoured — but deleting days
      // is still worth saying out loud, because the panel simply shows fewer.
      const base = shrank
        ? `pruned ${pruned} of ${days} recorded days to honour the ${this.options.retainDays}-day window`
        : `pruned ${pruned} of ${days} recorded days at once`
      this.note('retention', jumped ? `${base} — the clock may have jumped` : base)
    }
    // One day falling out of the window is the normal way a window moves, and
    // there is nothing to report; a standing note is left alone here, because
    // the first flush after a load-time prune would otherwise wipe the note
    // seconds after the user asked for the shrink. The load path clears it once
    // the file's `retentionDays` matches the setting.
    return pruned
  }

  /** The ledger file as another writer left it: absent, parsed, or unreadable. */
  private async readDiskLedger(): Promise<
    | { kind: 'missing' }
    | { kind: 'ok'; doc: UsageLedgerDocument; repairedAt?: number; machine?: string }
    | { kind: 'bad'; error: string }
  > {
    let raw: string
    try {
      raw = await readFile(this.ledgerPath, 'utf8')
    } catch (error) {
      const code = (error as { code?: unknown }).code
      return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'bad', error: String(code ?? error) }
    }
    const parsed = this.ledgerFromJson(raw)
    return parsed.kind === 'ok'
      ? { kind: 'ok', doc: parsed.doc, repairedAt: parsed.repairedAt, machine: parsed.machine }
      : { kind: 'bad', error: parsed.error }
  }

  /**
   * Write the duplicate repair over the file, keeping what other writers added.
   *
   * A verbatim overwrite would also drop the calls another process folded while
   * this one spent ~18 s replaying the transcripts, so the correction is applied
   * to the file's own document: a bucket is capped at its repaired value only
   * while it still carries the inflated total.
   *
   * Returns only the buckets that were really written, so the marker records a
   * correction that happened rather than one that was intended.
   */
  private async persistRepair(repaired: Map<string, RepairBucket>): Promise<RepairWriteResult | undefined> {
    try {
      await mkdir(dirname(this.ledgerPath), { recursive: true })
      let result: RepairWriteResult | undefined
      // The repair rewrites the whole document, so it has to hold the same lock a
      // normal flush takes. Without it a flush that fires while the ~18 s replay
      // is still running (or a second process's flush) reads the unrepaired file
      // and writes it straight back, and the correction is only re-applied on the
      // next start; the other way round, a repair that wins the race drops the
      // calls that flush had just folded in.
      const held = await this.withLedgerLock(async (locked) => {
        if (!locked) return
        result = await this.persistRepairLocked(repaired)
      })
      // The repair replaces the whole document, so it may not run on a view it
      // could not make exclusive: a flush that lands between our read and our
      // write would be overwritten, and its calls would only come back on the
      // next replay. Standing down leaves the file untouched; the correction is
      // re-attempted on the next start.
      if (!held) {
        this.note('repair-lock', 'the ledger lock stayed taken; the duplicate repair was not written and will be retried')
        return undefined
      }
      return result
    } catch (error) {
      this.ledgerError = `ledger write failed (${error instanceof Error ? error.message : String(error)})`
      return undefined
    }
  }

  private async persistRepairLocked(repaired: Map<string, RepairBucket>): Promise<RepairWriteResult | undefined> {
    try {
      const disk = await this.readDiskLedger()
      if (disk.kind === 'bad') {
        this.ledgerError = `ledger unreadable (${disk.error}); repair not written`
        return undefined
      }
      const target = disk.kind === 'ok' ? disk.doc : this.ledger
      const corrected = new Map<string, UsageTokenTotals>()
      let removedTokens = 0
      for (const entry of repaired.values()) {
        const found = findLedgerBucket(target.days[entry.dayKey], entry.provider, entry.model)
        if (found === undefined) continue
        const bucket = found.totals
        // The same whole-copies test as the in-memory pass, re-run on the document
        // about to be written: the bucket has to sit a whole number of copies
        // above the corrected total. A bucket that moved since the replay (a flush
        // folded a real call in) is left alone — a verbatim overwrite would drop
        // that call, and the one mistake no later merge can bring back is taking
        // away a call that really happened.
        if (repairCopies(bucket, entry.after, entry.totals) === undefined) continue
        const next = this.priceBucket(entry.dayKey, found.provider, found.model, entry.after)
        target.days[entry.dayKey]![found.provider]![found.model] = next
        const key = repairKey(entry.dayKey, found.provider, found.model)
        corrected.set(key, next)
        removedTokens += totalTokens(bucket) - totalTokens(next)
        // Keep memory in step with the file. The next flush measures growth as
        // `this.ledger` minus `ledgerWritten`, so a ledger still holding the
        // inflated bucket would report the calls the repair just removed as
        // growth and max-merge them straight back into the file.
        const own = findLedgerBucket(this.ledger.days[entry.dayKey], found.provider, found.model)
        // `findLedgerBucket` answers a wrapper, so assigning to `own.totals` only
        // set a field on that temporary object: the ledger kept the inflated
        // bucket, the next flush saw the removed calls as growth, and the repair
        // was written back out of existence on the very next flush.
        if (own !== undefined) this.ledger.days[entry.dayKey]![own.provider]![own.model] = structuredClone(next)
      }
      // Nothing was corrected: do not touch the file. Rewriting it here would
      // drop the stamp another process left (this one may have loaded before the
      // correction), and the next flush of that other process would then max-merge
      // the inflated totals straight back in. The prune below is part of writing,
      // not of repairing, so it waits for a document that is really written — a
      // "pruned N of M" note over a write that never happened is a false report.
      if (corrected.size === 0) return { corrected, removedTokens: 0 }
      // The file's own document may still carry days the in-memory ledger just
      // pruned; writing it back unchanged would resurrect them for one flush
      // cycle (and forever, if the process dies in between).
      this.pruneForWrite(target)
      // The stamp tells every other process holding a stale copy that this file
      // is now corrected, so their next flush adopts it instead of max-merging
      // the inflated totals back in. It only moves forward: a clock that steps
      // back must not lower a stamp another process already recorded.
      this.seenRepairedAt = Math.max(this.seenRepairedAt, Date.now())
      try {
        await writeJsonAtomic(this.ledgerPath, ledgerFileDocument(target, { machine: this.machine, repairedAt: this.seenRepairedAt, retentionDays: this.declaredWindow() }))
      } catch (error) {
        // The correction is in memory but not on disk, and nothing else would
        // retry it: the next flush would see a file without a stamp and max-merge
        // the inflated buckets straight back in. The stamp stays advanced on
        // purpose — that flush then takes the stale-writer branch and writes this
        // repaired document, which is the retry this write gets.
        this.ledgerError = `ledger write failed (${error instanceof Error ? error.message : String(error)})`
        return undefined
      }
      // Our own growth is measured against what is now on disk; the buckets the
      // replay recovered but this document lacks are added by the next flush.
      this.ledgerWritten = structuredClone(target)
      this.ledgerError = undefined
      return { corrected, removedTokens }
    } catch (error) {
      this.ledgerError = `ledger write failed (${error instanceof Error ? error.message : String(error)})`
      return undefined
    }
  }

  /**
   * Prune days past retention. Runs at most once per local day and whenever
   * `retainDays` shrinks — not only at startup, so long-lived processes and
   * live settings changes both honor retention.
   */
  private pruneIfNeeded(): void {
    const todayKey = localDateKey(Date.now())
    if (this.lastPrune?.dayKey === todayKey && this.lastPrune.retainDays === this.options.retainDays) return
    // Same refusal as the write path: pruning in memory on a jumped clock would
    // hide days from the panel until the next flush merged them back.
    const pruned = this.pruneForWrite(this.ledger)
    this.lastPrune = { dayKey: todayKey, retainDays: this.options.retainDays }
    if (pruned > 0) this.scheduleFlush()
  }

  /**
   * Persist the probe snapshots and the spend watch.
   *
   * Two processes on one machine share this file too, and the watch is an
   * accrual: a blind overwrite lets the slower writer erase the spend the faster
   * one already counted. The merge keeps the larger accrual (it can only grow),
   * its own `since`, and its own last balance, so the pair stays consistent.
   */
  private async persistSnapshots(): Promise<void> {
    if (!this.loaded) return
    try {
      await mkdir(dirname(this.snapshotsPath), { recursive: true })
      const disk = await readFile(this.snapshotsPath, 'utf8').then(
        // Same BOM handling as the ledger: this file is rewritten on every
        // snapshot tick, so a parse that throws here silently stops persisting
        // the spend watch — the one number nothing else can reconstruct.
        (raw) => parseJsonText(raw) as { spendWatch?: unknown },
        () => undefined,
      )
      const theirs = readSpendWatch(disk?.spendWatch)
      const ours = this.spendWatch
      const watch = ours === undefined ? theirs : theirs === undefined || ours.accruedCny >= theirs.accruedCny ? ours : theirs
      await writeJsonAtomic(this.snapshotsPath, {
        version: 1,
        providers: Object.fromEntries(this.snapshots),
        ...(watch !== undefined ? { spendWatch: watch } : {}),
      })
      this.clearNote('snapshots')
    } catch (error) {
      // Counting is unaffected; the voucher's observed spend is what will not
      // survive a restart, so the panel says so.
      this.note('snapshots', `snapshot write failed (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  // ------------------------------------------------------------------
  // Poll loop
  // ------------------------------------------------------------------

  private rearmPoll(delayMs: number): void {
    if (this.disposed) return
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined
      // The catch is not decoration: `pollNow` is started without an await, and an
    // unhandled rejection (a probe route that throws before its own guard) ends the
    // host process instead of costing one poll cycle.
    void this.pollNow()
      .catch(() => {})
      .finally(() => this.rearmPoll(Math.max(30, this.options.pollIntervalSec) * 1000))
    }, delayMs)
  }

  /**
   * One poll cycle: enumerate routes, resolve credentials, probe.
   * A call while a cycle is already running joins that cycle instead of
   * returning immediately, so a manual refresh always waits for real probes.
   */
  pollNow(): Promise<void> {
    if (this.pollInFlight) return this.pollPromise ?? Promise.resolve()
    if (this.disposed) return Promise.resolve()
    this.pollInFlight = true
    const cycle = (async () => {
      try {
        this.pruneIfNeeded()
        const routes = this.listProviderRoutes()
        const seen = new Set<string>()
        for (const route of routes) {
          // Probes serialize at up to 2 × PROBE_TIMEOUT_MS per route; bail
          // out of a cycle that outlived the service.
          if (this.disposed) return
          seen.add(route.id)
          const adapter = adapterFor(route.id)
          if (adapter === undefined || (adapter.balance === undefined && adapter.plan === undefined)) continue
          await this.probeRoute(route, adapter)
        }
        for (const id of [...this.snapshots.keys()]) {
          if (!seen.has(id)) this.snapshots.delete(id)
        }
        if (this.disposed) return
        this.accrueDeepSeekSpend()
        await this.persistSnapshots()
      } finally {
        this.pollInFlight = false
        this.pollPromise = undefined
      }
    })()
    this.pollPromise = cycle
    return cycle
  }

  /**
   * Every route the service probes and renders: the runtime's live providers
   * plus the configurable directory's catalog entries, then alias-folded so a
   * dormant catalog entry cannot shadow the live route of the same adapter
   * family (see foldAliasRoutes).
   */
  private listProviderRoutes(): ProviderRoute[] {
    const routes = new Map<string, ProviderRoute>()
    const runtime = service<{ listProviders(): Array<{ id: string; name: string }>; listConfigurableProviders(): Array<{ provider: string; displayName: string }> }>(this.ctx, 'llm')
    if (runtime !== undefined) {
      try {
        for (const provider of runtime.listProviders()) {
          if (provider.id !== '') routes.set(provider.id, { id: provider.id, displayName: provider.name, live: true })
        }
        for (const provider of runtime.listConfigurableProviders()) {
          if (!routes.has(provider.provider)) routes.set(provider.provider, { id: provider.provider, displayName: provider.displayName, live: false })
        }
      } catch {
        // Registry hiccups degrade to an empty list; the next poll retries.
      }
    }
    return foldAliasRoutes([...routes.values()])
  }

  private async probeRoute(route: ProviderRoute, adapter: NonNullable<ReturnType<typeof adapterFor>>): Promise<void> {
    const credential = await this.resolveCredential(route.id)
    const previous = this.snapshots.get(route.id)
    // The balance endpoint is per ORIGIN, not per route key: a profile that
    // points a shared route id (`deepseek`) at another host is a different
    // account, and probing the official endpoint would print this account's
    // money under that route's name (issue #1688). Such a route reports the
    // balance as unsupported instead.
    const balanceApplies = balanceAppliesToRoute(adapter, this.routeBaseUrl(route.id))
    if (credential.key === undefined) {
      // Nothing to probe with (oauth grant, no credential): retained facts
      // would never refresh again, so the row resets to its credential
      // state instead of presenting stale data as current.
      this.snapshots.set(route.id, {
        provider: route.id,
        displayName: route.displayName || adapter.displayName,
        credential: credential.kind,
        supported: true,
        updatedAt: Date.now(),
      })
      return
    }
    const snapshot: ProviderSnapshotState = {
      provider: route.id,
      displayName: route.displayName || adapter.displayName,
      credential: credential.kind,
      supported: true,
      ...(adapter.balance !== undefined && !balanceApplies ? { balanceSupported: false } : {}),
      updatedAt: Date.now(),
    }
    const runProbe = async (kind: 'balance' | 'plan'): Promise<BalanceView | PlanView | undefined> => {
      const half = adapter[kind]
      if (half === undefined) return undefined
      if (kind === 'balance' && !balanceApplies) return undefined
      try {
        const spec = half.build({ apiKey: credential.key as string, ...(credential.accountId !== undefined ? { accountId: credential.accountId } : {}) })
        const response = await fetch(spec.url, withIdentityEncoding({
          headers: spec.headers,
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        }))
        const body: unknown = await response.json().catch(() => undefined)
        if (!response.ok) throw new Error(providerErrorMessage(response.status, body))
        const parsed = half.parse(response.status, body)
        if (parsed === undefined) throw new Error('unrecognized response shape')
        const updatedAt = Date.now()
        if (kind === 'balance') {
          const fact = parsed as BalanceParse
          return { currency: fact.currency, totalBalance: fact.totalBalance, updatedAt }
        }
        const plan = parsed as PlanParse
        return { planName: plan.planName, windows: plan.windows, updatedAt }
      } catch (error) {
        // Per-fact error slot: a success in the other probe half can no
        // longer clear this failure (and a stale fact always carries the
        // error line explaining why it is stale).
        const message = error instanceof Error ? error.message.slice(0, 200) : String(error)
        if (kind === 'balance') snapshot.balanceError = message
        else snapshot.planError = message
        return undefined
      }
    }
    const balance = await runProbe('balance')
    // A failed probe keeps the previous fact visible (stale but useful).
    if (balance !== undefined) snapshot.balance = balance as BalanceView
    else if (previous?.balance !== undefined) snapshot.balance = previous.balance
    const plan = await runProbe('plan')
    if (plan !== undefined) snapshot.plan = plan as PlanView
    else if (previous?.plan !== undefined) snapshot.plan = previous.plan
    this.snapshots.set(route.id, snapshot)
  }

  /**
   * Resolve the credential backing one route: pi-ai credential records
   * first, then the profile's apiKeyEnv reference, then the DeepSeek
   * official adapter's env reference. OAuth grants hand their stored access
   * token to the oauth-aware adapters (Codex plan quota); a stale token
   * fails its probe with a 401 and refreshes the next time the harness
   * itself runs that provider.
   */
  private async resolveCredential(provider: string): Promise<ResolvedCredential> {
    const credentials = service<{
      readRecord(key: unknown): Promise<{ kind: string; key?: string; env?: Record<string, string>; payload?: unknown } | undefined>
      resolve(ref: unknown): Promise<{ value: string } | undefined>
    }>(this.ctx, 'credentials')
    if (credentials === undefined) return { kind: 'none' }
    try {
      const record = await credentials.readRecord(credentialKey('llm-pi-ai', provider))
      if (record?.kind === 'api-key' && typeof record.key === 'string' && record.key !== '') {
        return { kind: 'api-key', key: record.key }
      }
      if (record?.kind === 'grant' && typeof record.payload === 'object' && record.payload !== null) {
        // pi-ai stores its OAuth credential verbatim: { type: 'oauth', access, refresh, expires, ... }.
        const payload = record.payload as Record<string, unknown>
        const access = typeof payload.access === 'string' && payload.access !== '' ? payload.access : undefined
        const accountId = typeof payload.chatgpt_account_id === 'string' && payload.chatgpt_account_id !== '' ? payload.chatgpt_account_id : undefined
        if (access !== undefined) return { kind: 'oauth', key: access, ...(accountId !== undefined ? { accountId } : {}) }
        return { kind: 'oauth' }
      }
    } catch {
      // Invalid record ids read as absent.
    }
    try {
      const profile = this.piAiProfile(provider)
      const envName = profile?.apiKeyEnv ?? (isDeepSeekProviderRoute(provider) ? this.deepseekApiKeyEnv() : undefined)
      if (typeof envName === 'string' && envName !== '') {
        const resolved = await credentials.resolve(credentialRef(envName))
        if (resolved?.value !== undefined && resolved.value !== '') return { kind: 'env', key: resolved.value }
      }
    } catch {
      // Malformed references read as absent.
    }
    return { kind: 'none' }
  }

  /** The llm-pi-ai profile object for one provider route, when configured. */
  private piAiProfile(provider: string): { apiKeyEnv?: string; baseURL?: string } | undefined {
    const section = readNamespace(this.ctx, 'llm-pi-ai') as { providers?: Record<string, { apiKeyEnv?: string; baseURL?: string }> } | undefined
    return section?.providers?.[provider]
  }

  /** The DeepSeek official adapter's credential reference name. */
  private deepseekApiKeyEnv(): string {
    const section = readNamespace(this.ctx, 'llm-deepseek') as { apiKeyEnv?: string } | undefined
    return section?.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
  }

  /** The DeepSeek official adapter's configured baseURL. */
  private deepseekBaseUrl(): string | undefined {
    const section = readNamespace(this.ctx, 'llm-deepseek') as { baseURL?: string } | undefined
    return section?.baseURL
  }

  /** The effective base URL for a provider route (pi-ai or deepseek). */
  private routeBaseUrl(provider: string): string | undefined {
    return this.piAiProfile(provider)?.baseURL ?? (isDeepSeekProviderRoute(provider) ? this.deepseekBaseUrl() : undefined)
  }

}
