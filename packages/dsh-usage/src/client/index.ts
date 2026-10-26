/**
 * dsh-usage browser half — seats the first-level 使用统计 settings section
 * (below the Workshop entry) plus the compact usage glance card below the
 * sidebar's Settings row. The section polls the host overview only while it
 * is open; the foot card runs its own relaxed loop because the sidebar foot
 * is permanently mounted. All provider probing and credential handling
 * happens in the host half; this bundle only renders the overview document.
 * @module @linxin666/dsh-usage/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the shared-forms Context merge (ctx.configForms).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ctx.slots merge (the renderer owns the slot registry since 0.1.2).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createUsageStore, type UsageStoreInstance } from './usage-store.ts'
import { UsageSectionCard, type UsageSectionFace, type UsageSettings } from './UsageSectionCard.tsx'
import { mountUsageFootCard, openUsageSettings, type ShortcutsServiceFace } from './foot-card-mount.tsx'
import { NS, en, zh, t } from './locales.ts'
import { createServedEntryForm } from './settings-entry-form.ts'
import type { DeviceLedgerEntryView, UsageDayResponse, UsageDayView, UsageOverviewView, UsageRangeResponse } from '../core/types.ts'
import type { DeviceSyncApi } from './DeviceSyncCard.tsx'

/** The host usage API as the browser sees it (same-origin JSON endpoints). */
interface UsageHttpApi {
  overview(): Promise<UsageOverviewView>
  /** One retained local day (YYYY-MM-DD), the day pickers' detail fetch. */
  day(date: string): Promise<UsageDayView>
  /** One window aggregate (from/to local-date keys): totals, providers, series. */
  range(from: string, to: string): Promise<UsageRangeResponse>
  refresh(): Promise<UsageOverviewView>
  /** Download this device's ledger envelope as a JSON file. */
  exportLedger(): Promise<void>
  /** Install another device's envelope; the host keys it by its own deviceId. */
  importLedger(text: string): Promise<{ deviceId: string }>
  /** Re-scan the persist directory for files copied in by hand. */
  rescan(): Promise<DeviceLedgerEntryView[]>
}

/** Hard ceiling for one usage API call; a stalled host must not pile up requests. */
const USAGE_FETCH_TIMEOUT_MS = 20_000

async function usageFetch<T>(path: string, method: 'GET' | 'POST'): Promise<T> {
  const response = await fetch(path, {
    ...(method === 'POST' ? { method: 'POST' } : {}),
    signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error('usage ' + path + ' failed: ' + response.status)
  return (await response.json()) as T
}

const usageApi: UsageHttpApi = {
  // DOCUMENT-RELATIVE routes (issue #1707): the GUI is served with
  // `<base href="./">`, so a sub-path deployment resolves these against its
  // entry directory instead of escaping to the origin root.
  overview: () => usageFetch('api/dsh-usage/overview', 'GET'),
  day: async (date: string) => (await usageFetch<UsageDayResponse>('api/dsh-usage/day?date=' + encodeURIComponent(date), 'GET')).day,
  range: (from: string, to: string) => usageFetch(`api/dsh-usage/range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, 'GET'),
  refresh: () => usageFetch('api/dsh-usage/refresh', 'POST'),
  // The export route answers with a document-disposition attachment, so the
  // browser hands it to a download instead of rendering raw JSON. The blob is
  // fetched here rather than navigated to, so a failure surfaces as an error
  // message in the card instead of replacing the GUI.
  exportLedger: async () => {
    const response = await fetch('api/dsh-usage/export', { signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS) })
    if (!response.ok) throw new Error('usage export failed: ' + response.status)
    const blob = await response.blob()
    const match = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')
    const name = match?.[1] ?? 'dsh-usage-ledger.json'
    const url = URL.createObjectURL(blob)
    try {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    } finally {
      // Revoked on a later tick: some browsers cancel a download whose blob URL
      // disappears in the same frame as the click.
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
    }
  },
  importLedger: async (text: string) => {
    const response = await fetch('api/dsh-usage/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: text,
      signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS * 3),
    })
    const payload = await response.json().catch(() => undefined) as { ok?: boolean; deviceId?: string; error?: string } | undefined
    if (!response.ok || payload?.ok !== true || typeof payload.deviceId !== 'string') {
      throw new Error(payload?.error ?? 'usage import failed: ' + response.status)
    }
    return { deviceId: payload.deviceId }
  },
  rescan: async () => {
    // A rescan is just a fresh overview read: the host re-reads the persist
    // directory on every load, and the overview carries the resulting device
    // list, so there is no separate route to keep in sync.
    const snapshot = await usageFetch<UsageOverviewView>('api/dsh-usage/overview', 'GET')
    return snapshot.usage.devices ?? []
  },
}

/**
 * Settings namespace the section edits: the family identity of this plugin's
 * own settings form, and the row id a standalone bundle install carries.
 */
const USAGE_SETTINGS_NS = 'dsh-usage'

/** Profile entry id the family aggregate's generated row carries. */
const AGGREGATE_ENTRY_ID = 'web-ui-usage'

/** Profile entry ids this package's patch rows carry, most likely first. */
const USAGE_ENTRY_IDS: readonly string[] = [AGGREGATE_ENTRY_ID, 'usage', USAGE_SETTINGS_NS]

/** First-level nav position: directly below the Workshop section (order 150). */
const SECTION_ORDER = 151

/** Required services. */
export const inject = ['slots', 'locale', 'connection', 'configForms', 'remote']

export type { UsageSectionProps, UsageSectionFace } from './UsageSectionCard.tsx'
export type { DeviceSyncApi } from './DeviceSyncCard.tsx'
export type { UsageUiState } from './usage-store.ts'
export type { UsageSettings }

/**
 * One settings namespace a family card binds. The 0.1.7 client exports no spec
 * type (the form controller takes it privately), so the binder's input shape is
 * restated here.
 */
export interface UsageSettingsBindSpec<T> {
  /** Settings namespace registered by the owning host plugin. */
  namespace: string
  /** Narrow one wire section; undefined keeps the last accepted value. */
  decode?: (section: unknown) => T | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Optional family settings binder provided by dsh-web-settings; absent when
     * that group plugin is not installed, so callers fall back to the native
     * per-entry forms (`ctx.configForms`).
     */
    webUiSettings?: { bind<S>(spec: UsageSettingsBindSpec<S>): ConfigForm<S> }
    /**
     * Optional shell keyboard command service provided by dsh-client-shortcuts
     * (ships no client types); absent when that plugin is not installed, so the
     * foot card falls back to its visible account-menu path.
     */
    shortcuts?: ShortcutsServiceFace
  }
}

/**
 * Client plugin body: register dictionaries and seat the settings section.
 * The overview poll loop and the store live with the section component's
 * mount cycle, so no background traffic exists while the page is closed.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'dsh-usage: dictionaries')

  // The family binder is what maps this namespace onto the row's profile entry
  // id and hands back the native form. Without the group plugin the shared forms
  // service is addressed on the entry id the describe mirror justifies, rebound
  // as soon as the mirror answers: the namespace itself is only an entry id on a
  // standalone install, so binding it on the aggregate left the form unavailable
  // and the row's controls disabled.
  const binder = ctx.get('webUiSettings')
  const settingsForm = binder !== undefined
    ? binder.bind<UsageSettings>({ namespace: USAGE_SETTINGS_NS })
    : createServedEntryForm<UsageSettings>({ forms: ctx.configForms, entryIds: USAGE_ENTRY_IDS })

  // One store instance per apply body; the section mounts and unmounts with
  // the settings page, and the store survives between visits so the last
  // overview renders instantly on reopen.
  const store: UsageStoreInstance = createUsageStore().create()

  let pollSeq = 0
  const poll = (): void => {
    const seq = pollSeq + 1
    pollSeq = seq
    usageApi.overview().then((snapshot) => {
      if (seq !== pollSeq) return
      store.actions.setSnapshot(snapshot)
    }, (error: unknown) => {
      if (seq !== pollSeq) return
      // Surface the transport's own message: a 404 here means the host has no
      // /api/dsh-usage/overview route (plugin disabled), which the panel must be
      // able to tell apart from a genuine failure.
      store.actions.setState('error', error instanceof Error ? error.message : String(error))
    })
  }
  // The refresh response is authoritative: it reflects the completed probe
  // cycle, so it applies even when a faster section poll already bumped the
  // sequence past it (the poll's pre-cycle snapshot is the stale one). It must
  // not touch `pollSeq` though — rewinding the counter lets a poll that was
  // already in flight keep its claim on a sequence number, and the older of the
  // two answers then wins simply by landing last.
  const refresh = (): void => {
    const seq = pollSeq + 1
    pollSeq = seq
    usageApi.refresh().then((snapshot) => {
      store.actions.setSnapshot(snapshot)
    }, (error: unknown) => {
      if (seq !== pollSeq) return
      store.actions.setState('error', error instanceof Error ? error.message : String(error))
    })
  }

  // The day pickers fetch their own day: the overview carries today (always
  // live) plus the list of recorded days, and one selected day is a single
  // small local request the 10 s poll has no reason to repeat.
  const loadDay = (date: string): Promise<UsageDayView> => usageApi.day(date)

  // The multi-month windows read one aggregate per window: whole-span totals,
  // the provider breakdown, and the per-day series the trend chart buckets.
  const loadRange = (from: string, to: string): Promise<UsageRangeResponse> => usageApi.range(from, to)

  const deviceSync: DeviceSyncApi = {
    exportLedger: () => usageApi.exportLedger(),
    importLedger: (text: string) => usageApi.importLedger(text),
    rescan: () => usageApi.rescan(),
  }

  const face = (): UsageSectionFace => ({ store, poll, refresh, loadDay, loadRange, settings: settingsForm, deviceSync })

  // Sidebar foot card: the compact usage glance seated below the shell's
  // Settings row. It shares the section's store and poll path (the sequence
  // guard absorbs interleaved calls), runs its own relaxed poll loop, and
  // opens the settings panel on the usage section when clicked.
  const disposeFootCard = mountUsageFootCard({
    store,
    poll,
    settings: settingsForm,
    // The shortcuts service (soft-probed like webUiSettings above) lets the
    // opener invoke settings.open directly; without it the card degrades to
    // the account-menu path.
    onOpen: () => { openUsageSettings(() => t('usage.title'), { shortcuts: ctx.get('shortcuts') as ShortcutsServiceFace | undefined }) },
    locale: ctx.locale,
  })
  ctx.effect(() => () => {
    try {
      disposeFootCard()
    } catch {
      // Card container already gone (teardown race).
    }
  }, 'dsh-usage: sidebar foot card')

  ctx.slots.inject('settings.section', () => {
    try {
      const unregister = ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-usage',
        order: SECTION_ORDER,
        label: () => ctx.locale.bind(NS)('usage.title'),
        locale: NS,
        inject: face,
      }, UsageSectionCard)
      return () => {
        unregister()
      }
    } catch {
      return () => {}
    }
  })
}
