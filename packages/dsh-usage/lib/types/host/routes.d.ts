import type { Context } from '@deepseek-ai/cordis';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { UsageService } from './usage-service.ts';
export declare const USAGE_API_PREFIX = "/api/dsh-usage";
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
export declare function makeUsageOverviewRoute(ctx: Context, service: UsageService): WebRoute;
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
export declare function makeUsageDayRoute(ctx: Context, service: UsageService): WebRoute;
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
export declare function makeUsageRangeRoute(ctx: Context, service: UsageService): WebRoute;
/**
 * Manual refresh: forces one probe cycle now and answers with the fresh
 * overview. Same trust fence as the overview route.
 * @param ctx - host context; may expose remoteWebUiPairing.
 * @param service - the usage service.
 * @returns the route.
 */
export declare function makeUsageRefreshRoute(ctx: Context, service: UsageService): WebRoute;
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
export declare function makeUsageExportRoute(ctx: Context, service: UsageService): WebRoute;
/**
 * Ledger import: install another device's export as that device's file.
 *
 * Merges into the peer's file (keyed by the device id inside the document)
 * rather than replacing it: importing the same file twice still changes
 * nothing, while an older export of a device that kept counting no longer drops
 * the days that file already holds. Never touches this device's own ledger,
 * which is what makes "restore without overwriting my data" true by
 * construction rather than by policy.
 * @param ctx - host context; may expose remoteWebUiPairing.
 * @param service - the usage service.
 * @returns the route.
 */
export declare function makeUsageImportRoute(ctx: Context, service: UsageService): WebRoute;
