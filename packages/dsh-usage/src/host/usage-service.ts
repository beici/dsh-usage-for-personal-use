/**
 * The dsh-usage host service: folds live session usage into the persistent
 * ledger, probes each configured provider's balance/coding-plan endpoint on
 * a poll cycle, and serves the current provider's strip-ready view inside
 * the overview document. Secrets stay in the host process; the browser only
 * ever sees the overview document.
 * @module @linxin666/dsh-usage/host/usage-service
 */

import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
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
import { countPrunable, createLedgerDocument, deserializeLedger, foldUsage, ledgerDayKeys, localDateKey, maxTotals, mergeLedgerDelta, mergeLedgerMax, mergeLedgerSum, pruneLedger, subtractTotals, summarizeDays, totalTokens } from '../core/ledger.ts'
import { deviceIdOfFile, ensureMachineId, isDeviceId, ledgerFileDocument, LEGACY_LEDGER_FILE, ledgerFileName, localDeviceId, localMachineId, parsePeerLedger } from './device-ledger.ts'
import type { LoadedLedgerFile } from './device-ledger.ts'
import { collectSessionLogUsage } from './session-log-backfill.ts'
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
}

/** What the repair actually wrote: only the buckets it really corrected. */
interface RepairWriteResult {
  corrected: Map<string, UsageTokenTotals>
  removedTokens: number
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

/** Marker key for one bucket: the day, the route and the model it belongs to. */
function repairKey(dayKey: string, provider: string, model: string): string {
  return `${dayKey}\u0000${provider}\u0000${model}`
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

/** How many trend days the overview serves. */
const TREND_DAYS = 30

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
  /** True once the persisted document has been folded into memory this boot. */
  private loadAbsorbed = false
  /**
   * The smallest retention this process has seen applied.
   *
   * A lower setting than this means the user shrank the window on purpose, which
   * the "clock jumped" guard in `pruneForWrite` must not veto.
   */
  private retentionSeen: number
  /**
   * This machine's identity as recorded in every file it writes.
   *
   * Pinned in `machine-id.json` on first run rather than derived from the host
   * name: a rename must not make this machine look like a second device.
   */
  private machine = localMachineId()
  /**
   * The deduped replay of this boot, kept so a flush that must not max-merge
   * (a file another process repaired) can still add the buckets only the replay
   * recovers — those are not expressible as growth since our last write.
   */
  private replayDoc: UsageLedgerDocument | undefined

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
  /** Retry bookkeeping for a ledger file that could not be read this boot. */
  private loadRetries = 0
  private loadRetryTimer: ReturnType<typeof setTimeout> | undefined
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
    this.sessionListenerDisposer = this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))
    void this.loadPersisted()
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
    return this.flushLedger()
  }

  /** Re-apply options to this running instance; retention shrink prunes now. */
  applyOptions(options: UsageServiceOptions): void {
    this.options = options
    this.pruneIfNeeded()
  }

  /** Force one poll now (manual refresh route); joins an in-flight cycle. */
  async refresh(): Promise<void> {
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
      exportedAt: new Date().toISOString(),
      ledger: this.ledger,
    }
  }

  /**
   * Install a peer's exported ledger as that device's file.
   *
   * REPLACES the peer file rather than merging into it, which is what makes a
   * repeated import idempotent: the totals served are a sum over files that
   * exist, so importing the same document twice changes nothing. The device id
   * comes from inside the document (validated as a filename-safe token), so the
   * receiving machine never has to know the sender's file name.
   * @param text - raw JSON of an export envelope or a bare ledger document.
   * @returns the device id that was written.
   */
  async importPeer(text: string): Promise<{ deviceId: string }> {
    if (Buffer.byteLength(text, 'utf8') > IMPORT_MAX_BYTES) {
      throw new UsageImportError(`ledger exceeds ${IMPORT_MAX_BYTES} bytes`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
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
    await writeJsonAtomic(join(this.persistDir, ledgerFileName(claimedId)), {
      schema: LEDGER_EXPORT_SCHEMA,
      version: 1,
      deviceId: claimedId,
      // Carry the exporting machine's id through the round trip: without it the
      // file can no longer prove where it came from, and the peer scan refuses
      // to count a document it cannot attribute.
      ...(doc.machine === undefined ? {} : { machine: doc.machine }),
      exportedAt: new Date().toISOString(),
      ledger: doc.doc,
    })
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
    const days = allKeys.slice(-TREND_DAYS)
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
        // Every retained day, not just the trend window: the day picker's
        // option list reaches back to the oldest day retention still keeps.
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
    for (const peer of this.peers) mergeLedgerSum(merged, peer.doc)
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
    | { kind: 'ok'; doc: UsageLedgerDocument; repairedAt?: number }
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
    return parsed.kind === 'ok' ? { kind: 'ok', doc: parsed.doc, repairedAt: parsed.repairedAt } : { kind: 'corrupt', error: parsed.error }
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
  private ledgerFromJson(raw: string): { kind: 'ok'; doc: UsageLedgerDocument; repairedAt?: number } | { kind: 'corrupt'; error: string } {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return { kind: 'corrupt', error: error instanceof Error ? error.message : String(error) }
    }
    if (typeof parsed !== 'object' || parsed === null) return { kind: 'corrupt', error: 'not a ledger document' }
    const record = parsed as Record<string, unknown>
    const deviceId = typeof record.deviceId === 'string' ? record.deviceId : ''
    if (deviceId !== '' && deviceId !== localDeviceId()) return { kind: 'corrupt', error: `names device ${deviceId}` }
    const inner = typeof record.ledger === 'object' && record.ledger !== null ? record.ledger : record
    // A document with no `days` object is not an empty ledger, it is a shape we
    // do not understand (a future version's envelope, a half-written file). Read
    // as "no history" it would be overwritten by the first flush, so it is
    // treated as unreadable and left alone.
    if (typeof (inner as Record<string, unknown>).days !== 'object' || (inner as Record<string, unknown>).days === null) {
      return { kind: 'corrupt', error: 'no days in document' }
    }
    const repairedAt = typeof record.repairedAt === 'number' && Number.isFinite(record.repairedAt) ? record.repairedAt : undefined
    try {
      return { kind: 'ok', doc: deserializeLedger(inner), ...(repairedAt !== undefined ? { repairedAt } : {}) }
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
      else if (!this.loadAbsorbed) this.ledger = structuredClone(this.loadBaseline)
      await this.loadPersistedOnce()
      if (this.loaded) this.loadBaseline = undefined
    } catch (error) {
      // Nothing below may reject out of the loader: it is started without an
      // await, and an unhandled rejection ends the host process.
      this.ledgerError = `ledger load failed (${error instanceof Error ? error.message : String(error)})`
      this.scheduleLoadRetry()
    }
  }

  private async loadPersistedOnce(): Promise<void> {
    this.machine = await ensureMachineId(this.persistDir)
    let read = await this.readLedgerFile()
    /** True when this boot starts without the history the ledger used to hold. */
    let lostHistory = false
    if (read.kind === 'unreadable') {
      // Keep the write guard armed: nothing may replace a file we could not read.
      this.ledgerError = `ledger unreadable (${read.error})`
      this.scheduleLoadRetry()
      return
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
    } else if (read.kind === 'missing') await this.adoptLegacyLedger()
    // The oldest days have no transcripts: the ledger is the only copy, and a
    // corrupt file takes them with it. The pre-migration file still holds them,
    // so a boot that just lost its ledger folds that history back in.
    if (lostHistory) await this.restoreMigratedHistory()
    await this.refreshPeers()
    await this.loadSnapshots()
    // One replay pass serves both the backfill and the repair.
    const replay = await this.replaySessionLogs()
    this.replayDoc = replay.doc
    if (replay.skipped > 0) {
      // Say it out loud: a replay cut short by the per-start cap would otherwise
      // read as "the transcripts hold nothing older", i.e. as lost history.
      this.note('replay-cap', `${replay.skipped} older transcripts beyond the replay cap of ${replay.files} were not replayed`)
    }
    // The repair subtracts from the buckets as written, judged against the
    // deduped replay of the same pass and against what an earlier start already
    // left behind: a bucket that matches either was never inflated (or has
    // already been corrected), so real calls are never taken away.
    const prior = await this.readRepairRecord()
    const repaired = await this.repairDuplicatedReplay(replay, prior)
    // Prune after the replay (it re-adds days retention already dropped) and
    // before the write below, so the file gets the pruned document too.
    this.lastPrune = undefined
    this.pruneIfNeeded()
    // Only now may flushes overwrite the persisted files.
    this.loaded = true
    // A successful load restores the retry budget: a transient lock later in the
    // process's life must not find it spent.
    this.loadRetries = 0
    // Everything folded so far is already on disk: the first flush must add
    // only the calls that arrive after this point.
    this.ledgerWritten = structuredClone(this.ledger)
    if (read.kind !== 'corrupt') this.ledgerError = undefined
    if (repaired.buckets > 0) {
      // The correction is written first and claimed second: a crash in between
      // re-runs a repair that is idempotent by construction, while the opposite
      // order would leave a claim standing over a ledger that still holds the
      // inflated totals. The marker is a record, not a gate — the next start
      // judges the buckets again instead of trusting it, so a ledger restored
      // from a backup is corrected instead of staying inflated forever.
      const written = await this.persistRepair(repaired.repaired)
      // Only the buckets that were really corrected are recorded: a claim over a
      // correction another process's write prevented would be a false record,
      // and the floors it holds are what a later start must not subtract below.
      if (written !== undefined && written.corrected.size > 0) {
        await writeJsonAtomic(join(this.persistDir, DEDUPE_MARKER_FILE), {
          version: 2,
          appliedAt: Date.now(),
          buckets: written.corrected.size,
          removedTokens: written.removedTokens,
          // The floor for every later start: these are the totals the repair
          // left in each bucket, so a bucket still at them is not re-subtracted.
          // Floors from earlier starts are carried over — dropping them would
          // let a later repair on another day take real calls out of a bucket
          // this run no longer knows about.
          after: {
            ...Object.fromEntries([...prior].map(([key, totals]) => [key, totals])),
            ...Object.fromEntries([...written.corrected]),
          },
        }).catch(() => undefined)
      }
    }
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
    this.notes.set(kind, text)
  }

  /** Drop a note whose condition no longer holds. */
  private clearNote(kind: string): void {
    this.notes.delete(kind)
  }

  /** The notes as one line, oldest first, capped so the panel stays readable. */
  private ledgerNoteText(): string | undefined {
    const texts = [...this.notes.values()].slice(-3)
    return texts.length === 0 ? undefined : texts.join('; ')
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
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw) as { providers?: Record<string, ProviderSnapshotState>; spendWatch?: SpendWatch }
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
  private async replaySessionLogs(): Promise<ReplayPass> {
    const pass: ReplayPass = { doc: createLedgerDocument(), duplicates: new Map(), files: 0, replayed: 0, skipped: 0 }
    try {
      const counts = await collectSessionLogUsage(join(dshHome(), 'sessions'), (replay) => {
        pass.doc = replay
        for (const [dayKey, providers] of Object.entries(replay.days)) {
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

  /**
   * Correction for the seeded-subagent duplicate.
   *
   * A seeded subagent's transcript opens with a verbatim copy of its parent's
   * assistant messages (same id, time and usage), and the replay used to fold
   * both copies into the same bucket. Deduping the replay stops new inflation
   * but cannot undo what is already written — the merge rule keeps the larger
   * total, so an inflated bucket would never come back down. The extra copies
   * are therefore subtracted once, and a sidecar marker records what was done.
   *
   * The subtraction is judged twice over, because a wrong subtraction cannot be
   * undone by any later merge:
   *
   * - `clean` is the deduped replay, the truth for that day. A bucket at or
   *   below it holds no copy at all, so it is left alone.
   * - `prior` is what an earlier start already left in the bucket (read back
   *   from the marker). A bucket still at that floor has already been corrected
   *   — subtracting again on every start would slowly eat real calls, which is
   *   exactly what a plain "big enough to subtract" guard allows once the day
   *   holds calls the replay cannot see.
   */
  private async repairDuplicatedReplay(replay: ReplayPass, prior: Map<string, UsageTokenTotals>): Promise<RepairResult> {
    const repaired = new Map<string, RepairBucket>()
    let buckets = 0
    let removedTokens = 0
    for (const [key, duplicate] of replay.duplicates) {
      // The ledger may spell the route differently than the transcript does
      // (`WorkBuddy` vs `workbuddy`): a bucket that drifted is still the bucket
      // the copies landed in, and a repair that only matches exact strings would
      // skip it while the replay adds a second bucket beside it.
      const target = findLedgerBucket(this.ledger.days[duplicate.dayKey], duplicate.provider, duplicate.model)
      if (target === undefined) continue
      const bucket = target.totals
      const clean = findLedgerBucket(replay.doc.days[duplicate.dayKey], duplicate.provider, duplicate.model)?.totals ?? emptyTotals()
      // Where the bucket stood before this repair: the total an earlier start
      // already left behind, or — on the first start — what the deduped replay
      // bills. Either way, a copy on top of it is exactly `base + copies`.
      const base = prior.get(key) ?? clean
      // How far the bucket has moved past that floor. A copy sits exactly on the
      // floor, so growth equal to the copies is the only state this repair can
      // undo: growth below it means no full copy is there, and growth above it
      // means real calls the replay cannot see are mixed in (or the file was
      // grown by another process since) — indistinguishable from copies, and
      // taking them away is the one mistake no later merge can bring back.
      if (bucket.calls - base.calls !== duplicate.totals.calls) continue
      if (totalTokens(bucket) - totalTokens(base) !== totalTokens(duplicate.totals)) continue
      const next = maxTotals(subtractTotals(bucket, duplicate.totals), base)
      const dropped = totalTokens(bucket) - totalTokens(next)
      if (dropped <= 0) continue
      // Reprice: a stored cost cannot be split, and the replay priced the
      // bucket it inflated at the day's noon rate (see replaySessionLogs).
      const repriced = this.priceBucket(duplicate.dayKey, target.provider, target.model, next)
      this.ledger.days[duplicate.dayKey]![target.provider]![target.model] = repriced
      repaired.set(key, { ...duplicate, provider: target.provider, model: target.model, clean, after: repriced })
      buckets += 1
      removedTokens += dropped
    }
    return { buckets, removedTokens, repaired }
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
   * What the last repair left in each bucket, read back from the marker.
   *
   * The marker is a record, not a gate: the numbers it holds are the floor a
   * later start must not subtract below. A marker written before this field
   * existed (or one damaged by hand) yields an empty map, and the repair then
   * falls back to the replay's own total.
   */
  private async readRepairRecord(): Promise<Map<string, UsageTokenTotals>> {
    const record = new Map<string, UsageTokenTotals>()
    let raw: string
    try {
      raw = await readFile(join(this.persistDir, DEDUPE_MARKER_FILE), 'utf8')
    } catch {
      return record
    }
    try {
      const parsed = JSON.parse(raw) as { after?: unknown }
      if (typeof parsed.after !== 'object' || parsed.after === null) return record
      for (const [key, value] of Object.entries(parsed.after as Record<string, unknown>)) {
        const totals = readTotals(value)
        if (totals !== undefined) record.set(key, totals)
      }
    } catch {
      // A damaged marker only means the repair re-judges from the replay.
    }
    return record
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
        const doc = deserializeLedger(JSON.parse(raw))
        const days = Object.keys(doc.days).length
        if (days === 0) continue
        mergeLedgerMax(this.ledger, doc)
        restored += days
      } catch {
        // Unparseable: leave it alone, the quarantine note already says the
        // current file was unreadable.
      }
    }
    if (restored === 0) return
    // The restored days are as old as the history gets: apply retention to them
    // the same way a normal load would, or the merge would resurrect days the
    // user already let go.
    pruneLedger(this.ledger, localDateKey(Date.now()), this.options.retainDays)
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
      this.absorb(this.ledger, deserializeLedger(JSON.parse(source.raw)))
      pruneLedger(this.ledger, localDateKey(Date.now()), this.options.retainDays)
      this.lastPrune = { dayKey: localDateKey(Date.now()), retainDays: this.options.retainDays }
    } catch {
      return // Unparseable legacy file: leave it untouched for the user to inspect.
    }
    // Written before the rename so a crash mid-migration cannot lose the data.
    // Not `flushLedger()`: that defers to `loaded`, and the migration runs
    // precisely while `loaded` is still false. The write goes straight to this
    // device's file instead, and only a successful one retires the legacy file.
    const written = await writeJsonAtomic(this.ledgerPath, this.ledger).then(
      () => true,
      () => false,
    )
    if (written && source.path === legacyPath) await rename(legacyPath, migratedPath).catch(() => undefined)
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
  private async refreshPeers(): Promise<void> {
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
    const localMachine = this.machine
    for (const name of names) {
      const file = basename(name)
      const deviceId = deviceIdOfFile(file)
      if (deviceId === undefined) continue
      // Our own ledger, and every copy of it: a backup (`…p15-22893b.bak.json`)
      // keeps the device prefix, so summing it as a peer would double this
      // machine's own calls.
      if (deviceId === this.deviceId || deviceId.startsWith(this.deviceId + '.')) continue
      const filePath = join(this.persistDir, name)
      try {
        const [raw, info] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)])
        const parsed = parsePeerLedger(JSON.parse(raw))
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
          // Written before this build stamped its machine, or placed by hand: it
          // cannot prove which machine it came from. Counting it as a device is
          // how one machine's own history gets summed twice, so it is reported
          // and left out until it is re-exported by a build that stamps identity.
          failures.push(`${name}: no machine id in the document, not summed`)
          continue
        }
        if (parsed.machine !== undefined && parsed.machine === localMachine) {
          // This machine under an older name: the host was renamed, so a new
          // device id was minted while this file kept the old one. Its calls are
          // this machine's own, so they are folded in (max merge: the same days
          // are also replayed from the transcripts) instead of being summed as a
          // second device — and the file itself is left where it is, because a
          // peer may still be reading it.
          mergeLedgerMax(this.ledger, parsed.doc)
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
    peers.sort((a, b) => a.deviceId.localeCompare(b.deviceId))
    this.peers = peers
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
      // the last flush would otherwise own the history. Take the file's version
      // and add only our own growth since our last write.
      const disk = await this.readDiskLedger()
      if (disk.kind === 'bad') {
        // The bytes may be a real ledger we merely failed to parse: writing
        // over them would destroy the only copy.
        this.ledgerError = `ledger unreadable (${disk.error}); write skipped`
        return
      }
      if (disk.kind === 'ok') {
        const target = disk.doc
        const stamp = disk.repairedAt ?? 0
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
        } else if (this.seenRepairedAt > 0 && disk.repairedAt === undefined) {
          // We know this file was corrected, but the copy on disk carries no
          // stamp: a process running the previous build rewrote it whole. Its
          // document holds the inflated buckets we already repaired, so a max
          // merge would undo the repair; take our own growth only and stamp the
          // file again below.
          this.note('stale-writer', 'a build without ledger identity rewrote the file; its inflated buckets were not re-adopted')
          if (this.ledgerWritten !== undefined) mergeLedgerDelta(target, this.ledger, this.ledgerWritten)
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
        this.pruneForWrite(this.ledger)
      }
      await writeJsonAtomic(this.ledgerPath, this.ledgerFileDocument())
      this.ledgerWritten = structuredClone(this.ledger)
      this.ledgerError = undefined
    } catch (error) {
      // Persistence failures must not stop the counting, but the panel has to
      // say why these numbers will not survive a restart.
      this.ledgerError = `ledger write failed (${error instanceof Error ? error.message : String(error)})`
    }
  }

  /** This process's ledger as a file document: the identity travels with it. */
  private ledgerFileDocument(): UsageLedgerDocument & { deviceId: string; machine: string; repairedAt?: number } {
    return ledgerFileDocument(this.ledger, this.seenRepairedAt > 0 ? { repairedAt: this.seenRepairedAt } : undefined)
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
    // settings change). A jump looks different from a shrink: it makes *every*
    // recorded day fall outside the window at once, while a shrink keeps the
    // recent days and drops the rest.
    const shrank = this.options.retainDays < this.retentionSeen
    this.retentionSeen = Math.min(this.retentionSeen, this.options.retainDays)
    if (!shrank && days >= 4 && prunable === days) {
      this.note('retention', `retention skipped: the clock would drop all ${days} recorded days`)
      return 0
    }
    if (prunable === 0) this.clearNote('retention')
    return pruneLedger(doc, todayKey, this.options.retainDays)
  }

  /** The ledger file as another writer left it: absent, parsed, or unreadable. */
  private async readDiskLedger(): Promise<
    | { kind: 'missing' }
    | { kind: 'ok'; doc: UsageLedgerDocument; repairedAt?: number }
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
      ? { kind: 'ok', doc: parsed.doc, ...(parsed.repairedAt !== undefined ? { repairedAt: parsed.repairedAt } : {}) }
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
        // Same judgement as the in-memory pass, anchored at the repaired total:
        // only a bucket sitting exactly one copy above it is corrected. One that
        // merely grew is left alone — those are calls another process folded
        // while the replay ran, and a verbatim overwrite would drop them.
        if (bucket.calls - entry.after.calls !== entry.totals.calls) continue
        if (totalTokens(bucket) - totalTokens(entry.after) !== totalTokens(entry.totals)) continue
        const next = maxTotals(subtractTotals(bucket, entry.totals), entry.after)
        target.days[entry.dayKey]![found.provider]![found.model] =
          this.priceBucket(entry.dayKey, found.provider, found.model, next)
        const key = repairKey(entry.dayKey, found.provider, found.model)
        corrected.set(key, next)
        removedTokens += totalTokens(entry.totals)
      }
      // The file's own document may still carry days the in-memory ledger just
      // pruned; writing it back unchanged would resurrect them for one flush
      // cycle (and forever, if the process dies in between).
      this.pruneForWrite(target)
      // Nothing was corrected: do not touch the file. Rewriting it here would
      // drop the stamp another process left (this one may have loaded before the
      // correction), and the next flush of that other process would then max-merge
      // the inflated totals straight back in.
      if (corrected.size === 0) return { corrected, removedTokens: 0 }
      // The stamp tells every other process holding a stale copy that this file
      // is now corrected, so their next flush adopts it instead of max-merging
      // the inflated totals back in. It only moves forward: a clock that steps
      // back must not lower a stamp another process already recorded.
      this.seenRepairedAt = Math.max(this.seenRepairedAt, Date.now())
      await writeJsonAtomic(this.ledgerPath, ledgerFileDocument(target, { machine: this.machine, repairedAt: this.seenRepairedAt }))
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
        (raw) => JSON.parse(raw) as { spendWatch?: unknown },
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
      void this.pollNow().finally(() => this.rearmPoll(Math.max(30, this.options.pollIntervalSec) * 1000))
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
