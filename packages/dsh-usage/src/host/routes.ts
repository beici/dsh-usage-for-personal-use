import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isUsageAllowed } from './access.ts'
import { writeJson } from './http.ts'
import { isLedgerDateKey } from '../core/ledger.ts'
import type { UsageDayResponse, UsageRangeResponse } from '../core/types.ts'
import { UsageImportError } from './usage-service.ts'
import type { UsageService } from './usage-service.ts'

export const USAGE_API_PREFIX = '/api/dsh-usage'

/**
 * Overview route: provider balances, plan quotas, and token usage totals.
 * Personal account data behind the family trust fence — loopback always
 * passes, and a live paired-device cookie passes too when remote-web-ui is
 * loaded (issue #1592: the sidebar usage panel reads this from a paired LAN
 * browser); every unpaired LAN request keeps its 403.
 * @param ctx - host context; may expose remoteWebUiPairing.
 * @param service - the usage service.
 * @returns the route.
 */
export function makeUsageOverviewRoute(ctx: Context, service: UsageService): WebRoute {
  return {
    kind: 'exact',
    path: USAGE_API_PREFIX + '/overview',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (!isUsageAllowed(ctx, req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      writeJson(res, 200, service.overview(), { 'cache-control': 'no-store' })
    },
  }
}

/**
 * One retained day route: `GET /api/dsh-usage/day?date=YYYY-MM-DD` answers
 * that local day's per-provider and per-model totals, so the section's day
 * pickers can show a past day instead of only today. Same trust fence as the
 * overview route, and a key that is not a real local date is refused with 400
 * rather than folded into a bogus day.
 * @param ctx - host context; may expose remoteWebUiPairing.
 * @param service - the usage service.
 * @returns the route.
 */
export function makeUsageDayRoute(ctx: Context, service: UsageService): WebRoute {
  return {
    kind: 'exact',
    path: USAGE_API_PREFIX + '/day',
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (!isUsageAllowed(ctx, req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      const date = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('date') ?? ''
      if (!isLedgerDateKey(date)) {
        writeJson(res, 400, { ok: false, error: 'date must be YYYY-MM-DD' })
        return
      }
      writeJson(res, 200, { ok: true, day: service.day(date) } satisfies UsageDayResponse, { 'cache-control': 'no-store' })
    },
  }
}

/**
 * One window-aggregate route: `GET /api/dsh-usage/range?from=YYYY-MM-DD&to=YYYY-MM-DD`
 * answers the whole-window summary (per-provider, per-model breakdown) plus the
 * per-day series the trend chart buckets, in ONE request. This is what makes
 * the multi-month and multi-year windows viable — the per-day fetch path that
 * the short windows use would cost one request per recorded day, which for a
 * year-long window means hundreds of loopback round trips.
 * Same trust fence as the overview route; a malformed or inverted range is
 * refused with 400 rather than folded into a bogus span.
 * @param ctx - host context; may expose remoteWebUiPairing.
 * @param service - the usage service.
 * @returns the route.
 */
export function makeUsageRangeRoute(ctx: Context, service: UsageService): WebRoute {
  return {
    kind: 'exact',
    path: USAGE_API_PREFIX + '/range',
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (!isUsageAllowed(ctx, req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
      const from = query.get('from') ?? ''
      const to = query.get('to') ?? ''
      if (!isLedgerDateKey(from) || !isLedgerDateKey(to) || from > to) {
        writeJson(res, 400, { ok: false, error: 'from and to must be YYYY-MM-DD dates with from <= to' })
        return
      }
      writeJson(res, 200, { ok: true, ...service.range(from, to) } satisfies UsageRangeResponse, { 'cache-control': 'no-store' })
    },
  }
}

/**
 * Manual refresh: forces one probe cycle now and answers with the fresh
 * overview. Same trust fence as the overview route.
 * @param ctx - host context; may expose remoteWebUiPairing.
 * @param service - the usage service.
 * @returns the route.
 */
export function makeUsageRefreshRoute(ctx: Context, service: UsageService): WebRoute {
  return {
    kind: 'exact',
    path: USAGE_API_PREFIX + '/refresh',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (!isUsageAllowed(ctx, req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        await service.refresh()
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'refresh failed' })
        return
      }
      writeJson(res, 200, service.overview(), { 'cache-control': 'no-store' })
    },
  }
}

/**
 * Ledger export: this device's own history as a portable JSON document.
 *
 * Only this machine's ledger is exported. Peers are already counted wherever
 * their files exist, so exporting them too would make totals grow with every
 * round trip — the one failure mode the per-device file layout exists to avoid.
 * @param ctx - host context; may expose remoteWebUiPairing.
 * @param service - the usage service.
 * @returns the route.
 */
export function makeUsageExportRoute(ctx: Context, service: UsageService): WebRoute {
  return {
    kind: 'exact',
    path: USAGE_API_PREFIX + '/export',
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (!isUsageAllowed(ctx, req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const envelope = service.exportLedger()
      const body = JSON.stringify(envelope, null, 2)
      // A download rather than an inline view: the panel hands this to the
      // browser as a file, and the filename carries the device id so two
      // exports never collide in a Downloads folder.
      writeJson(res, 200, envelope, {
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="dsh-usage-ledger-${envelope.deviceId}.json"`,
        'x-usage-export-bytes': String(Buffer.byteLength(body, 'utf8')),
      })
    },
  }
}

/** Largest import body accepted, mirroring the service's own guard. */
const IMPORT_MAX_BYTES = 8 * 1024 * 1024

/**
 * Read a request body with a hard byte cap.
 *
 * The cap is enforced while streaming, not after: an oversized upload must not
 * be buffered into memory before being rejected.
 */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`body exceeds ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Ledger import: install another device's export as that device's file.
 *
 * Replaces the peer's file (keyed by the device id inside the document) rather
 * than merging numbers, so importing the same file twice is a no-op. Never
 * touches this device's own ledger, which is what makes "restore without
 * overwriting my data" true by construction rather than by policy.
 * @param ctx - host context; may expose remoteWebUiPairing.
 * @param service - the usage service.
 * @returns the route.
 */
export function makeUsageImportRoute(ctx: Context, service: UsageService): WebRoute {
  return {
    kind: 'exact',
    path: USAGE_API_PREFIX + '/import',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (!isUsageAllowed(ctx, req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body: string
      try {
        body = await readBody(req, IMPORT_MAX_BYTES)
      } catch (error) {
        writeJson(res, 413, { ok: false, error: error instanceof Error ? error.message : 'unreadable body' })
        return
      }
      try {
        const result = await service.importPeer(body)
        writeJson(res, 200, { ok: true, deviceId: result.deviceId, devices: service.overview().usage.devices ?? [] })
      } catch (error) {
        if (error instanceof UsageImportError) {
          writeJson(res, 400, { ok: false, error: error.message })
          return
        }
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'import failed' })
      }
    },
  }
}
