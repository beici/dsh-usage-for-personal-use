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
import { createLedgerDocument, deserializeLedger, foldUsage, ledgerDayKeys, localDateKey, mergeLedgerDelta, mergeLedgerMax, mergeLedgerSum, pruneLedger, subtractTotals, summarizeDays, totalTokens } from '../core/ledger.ts'
import { deviceIdOfFile, isDeviceId, LEGACY_LEDGER_FILE, ledgerFileName, localDeviceId, parsePeerLedger } from './device-ledger.ts'
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
 * Atomic JSON write through a unique temp file + fsync + rename. The temp
 * name is per-call so two overlapping flushes can never interleave into one
 * temp file, and the fsync closes the rename-lands-but-bytes-are-not-durable
 * window.
 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
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

  private ledger: UsageLedgerDocument = createLedgerDocument()
  /**
   * The document this process last wrote to disk. Another process on this
   * machine writes the same file, so a flush adds only what we folded since
   * this snapshot — adding the whole document would count its calls twice.
   */
  private ledgerWritten: UsageLedgerDocument | undefined
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
    | { kind: 'ok'; doc: UsageLedgerDocument }
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
    try {
      return { kind: 'ok', doc: deserializeLedger(JSON.parse(raw)) }
    } catch (error) {
      return { kind: 'corrupt', error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async loadPersisted(): Promise<void> {
    const read = await this.readLedgerFile()
    if (read.kind === 'unreadable') {
      // Keep the write guard armed: nothing may replace a file we could not read.
      this.ledgerError = `ledger unreadable (${read.error})`
      this.scheduleLoadRetry()
      return
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
    }
    if (read.kind === 'ok') this.absorb(this.ledger, read.doc)
    else if (read.kind === 'missing') await this.adoptLegacyLedger()
    await this.refreshPeers()
    await this.loadSnapshots()
    // The repair subtracts from the buckets as they were written, so it runs
    // before the replay's max-merge can restore the inflated totals.
    const repaired = await this.repairDuplicatedReplay()
    await this.backfillSessionLogs()
    // Prune last: the replay re-adds days the retention window already dropped,
    // so pruning first would only resurrect them.
    this.lastPrune = undefined
    this.pruneIfNeeded()
    // Only now may flushes overwrite the persisted files.
    this.loaded = true
    // Everything folded so far is already on disk: the first flush must add
    // only the calls that arrive after this point.
    this.ledgerWritten = structuredClone(this.ledger)
    if (read.kind !== 'corrupt') this.ledgerError = undefined
    if (repaired !== undefined) {
      // The file still holds the inflated totals and the merge-based flush
      // keeps the larger one, so the correction is written over it verbatim.
      // The marker follows the write: a marker without a corrected file would
      // block the only chance to undo the inflation.
      if (repaired.buckets === 0 || await this.writeLedgerVerbatim()) {
        await writeJsonAtomic(join(this.persistDir, DEDUPE_MARKER_FILE), {
          version: 1,
          appliedAt: Date.now(),
          buckets: repaired.buckets,
          removedTokens: repaired.removedTokens,
        }).catch(() => undefined)
      }
    }
    this.scheduleFlush()
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
      const watch = parsed.spendWatch
      if (typeof watch === 'object' && watch !== null && typeof watch.accruedCny === 'number' && Number.isFinite(watch.accruedCny) && watch.accruedCny >= 0
        && typeof watch.since === 'number' && Number.isFinite(watch.since) && watch.since > 0) {
        this.spendWatch = {
          accruedCny: watch.accruedCny,
          since: watch.since,
          ...(typeof watch.lastBalanceCny === 'number' && Number.isFinite(watch.lastBalanceCny) ? { lastBalanceCny: watch.lastBalanceCny } : {}),
        }
      }
    } catch {
      // Snapshots are a cache of probe results: a corrupt one costs one poll.
    }
  }

  /**
   * Fold the session transcripts back into the ledger.
   *
   * `session/event` only carries records appended while an instance is
   * mounted, so calls made before the first mount — or during a remount
   * window — exist nowhere else. A bucket keeps whichever total is larger:
   * replay never shrinks a live bucket, and a ledger rebuilt from an older
   * transcript never loses a newer live fold, so running this on every start
   * is idempotent.
   */
  private async backfillSessionLogs(): Promise<void> {
    try {
      await collectSessionLogUsage(join(dshHome(), 'sessions'), (replay) => {
        for (const [dayKey, providers] of Object.entries(replay.days)) {
          const atMs = new Date(dayKey + 'T12:00:00').getTime()
          if (!Number.isFinite(atMs)) continue
          const day = this.ledger.days[dayKey] ?? (this.ledger.days[dayKey] = {})
          for (const [provider, models] of Object.entries(providers)) {
            for (const [model, totals] of Object.entries(models)) {
              const bucket = day[provider]?.[model]
              if (bucket !== undefined && totalTokens(bucket) >= totalTokens(totals)) continue
              const folded = isDeepSeekProviderRoute(provider)
                ? { ...totals, cost: deepseekModelSpend(model, totals, atMs) }
                : totals
              const route = day[provider] ?? (day[provider] = {})
              route[model] = folded
            }
          }
        }
      })
    } catch {
      // A failed replay costs the pre-mount calls only; the live fold is intact.
    }
  }

  /**
   * One-time correction for the seeded-subagent duplicate.
   *
   * A seeded subagent's transcript opens with a verbatim copy of its parent's
   * assistant messages (same id, time and usage), and the replay used to fold
   * both copies into the same bucket. Deduping the replay stops new inflation
   * but cannot undo what is already written — the merge rule keeps the larger
   * total, so an inflated bucket would never come back down. The extra copies
   * are therefore subtracted once, exactly, and a sidecar marker records it:
   * subtracting twice would take real calls away.
   */
  private async repairDuplicatedReplay(): Promise<{ buckets: number; removedTokens: number } | undefined> {
    const markerPath = join(this.persistDir, DEDUPE_MARKER_FILE)
    try {
      await stat(markerPath)
      return undefined
    } catch {
      // No marker yet: this machine has never been repaired.
    }
    let buckets = 0
    let removedTokens = 0
    try {
      await collectSessionLogUsage(join(dshHome(), 'sessions'), () => {}, (dayKey, provider, model, totals) => {
        const bucket = this.ledger.days[dayKey]?.[provider]?.[model]
        if (bucket === undefined) return
        const next = subtractTotals(bucket, totals)
        const dropped = totalTokens(bucket) - totalTokens(next)
        if (dropped <= 0) return
        // Reprice: a stored cost cannot be split, and the replay priced the
        // bucket it inflated at the day's noon rate (see backfillSessionLogs).
        const atMs = new Date(dayKey + 'T12:00:00').getTime()
        const repriced = isDeepSeekProviderRoute(provider) && Number.isFinite(atMs)
          ? { ...next, cost: deepseekModelSpend(model, next, atMs) }
          : next
        this.ledger.days[dayKey]![provider]![model] = repriced
        buckets += 1
        removedTokens += dropped
      })
    } catch {
      // No marker written: the next start retries the scan.
      return undefined
    }
    return { buckets, removedTokens }
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
   */
  private async adoptLegacyLedger(): Promise<void> {
    const legacyPath = join(this.persistDir, LEGACY_LEDGER_FILE)
    let raw: string | undefined
    try {
      raw = await readFile(legacyPath, 'utf8')
    } catch {
      return // No legacy file: fresh install.
    }
    try {
      this.absorb(this.ledger, deserializeLedger(JSON.parse(raw)))
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
    if (written) await rename(legacyPath, `${legacyPath}.migrated`).catch(() => undefined)
  }

  /**
   * Re-read every peer ledger file in the persist directory.
   *
   * Peers are whatever `usage-ledger.<deviceId>.json` files are present, so
   * "importing" a device is just dropping its file in — and re-importing the
   * same file changes nothing, because the totals are derived from the set of
   * files rather than accumulated into state.
   */
  private async refreshPeers(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.persistDir)
    } catch {
      this.peers = []
      this.peersError = undefined
      return
    }
    const peers: LoadedLedgerFile[] = []
    const failures: string[] = []
    for (const name of names) {
      const deviceId = deviceIdOfFile(basename(name))
      if (deviceId === undefined || deviceId === this.deviceId) continue
      const filePath = join(this.persistDir, name)
      try {
        const [raw, info] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)])
        const parsed = parsePeerLedger(JSON.parse(raw))
        if (parsed === undefined) {
          failures.push(`${name}: not a usage ledger`)
          continue
        }
        // A renamed copy of another device's ledger would otherwise be summed in
        // under the wrong id — and a renamed copy of THIS machine's ledger would
        // double every call it holds. The document's own id outranks the name.
        if (parsed.deviceId !== '' && parsed.deviceId !== deviceId) {
          failures.push(`${name}: names device ${parsed.deviceId}`)
          continue
        }
        // The file name is authoritative for which device it is: a renamed
        // peer file must not silently impersonate another device.
        peers.push({ deviceId, doc: parsed.doc, updatedAt: info.mtimeMs })
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
      if (disk !== undefined) {
        if (this.ledgerWritten !== undefined) mergeLedgerDelta(disk, this.ledger, this.ledgerWritten)
        else mergeLedgerMax(disk, this.ledger)
        // Adopt the merged document: our view then includes the other
        // process's calls, and the next delta is measured against it.
        this.ledger = disk
      }
      await writeJsonAtomic(this.ledgerPath, this.ledger)
      this.ledgerWritten = structuredClone(this.ledger)
    } catch {
      // Persistence failures degrade silently; the in-memory ledger keeps counting.
    }
  }

  /** The ledger file as another writer left it, or undefined when absent/unreadable. */
  private async readDiskLedger(): Promise<UsageLedgerDocument | undefined> {
    try {
      const raw = await readFile(this.ledgerPath, 'utf8')
      return deserializeLedger(JSON.parse(raw))
    } catch {
      return undefined
    }
  }

  /**
   * Write this process's document over the file, ignoring what is there.
   *
   * The normal flush merges the file's growth in and keeps the larger total of
   * each bucket — right for adding calls, wrong for a correction, which has to
   * replace the number the old replay wrote. Only the duplicate repair uses it.
   */
  private async writeLedgerVerbatim(): Promise<boolean> {
    try {
      await mkdir(dirname(this.ledgerPath), { recursive: true })
      await writeJsonAtomic(this.ledgerPath, this.ledger)
      this.ledgerWritten = structuredClone(this.ledger)
      return true
    } catch (error) {
      this.ledgerError = `ledger write failed (${error instanceof Error ? error.message : String(error)})`
      return false
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
    const pruned = pruneLedger(this.ledger, todayKey, this.options.retainDays)
    this.lastPrune = { dayKey: todayKey, retainDays: this.options.retainDays }
    if (pruned > 0) this.scheduleFlush()
  }

  private async persistSnapshots(): Promise<void> {
    if (!this.loaded) return
    try {
      await mkdir(dirname(this.snapshotsPath), { recursive: true })
      await writeJsonAtomic(this.snapshotsPath, {
        version: 1,
        providers: Object.fromEntries(this.snapshots),
        ...(this.spendWatch !== undefined ? { spendWatch: this.spendWatch } : {}),
      })
    } catch {
      // Same silent degradation as the ledger.
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
