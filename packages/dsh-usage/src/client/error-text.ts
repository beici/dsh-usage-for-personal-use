/**
 * One translation table for host error text, shared by every surface that shows
 * one: the section card, the sidebar foot card and the device card all state a
 * failure in the user's language and keep the raw wire text in a `title`, where
 * a diagnostic belongs. The mapping lives here rather than in the card that
 * happened to grow it first, because three copies drift apart and one of them
 * ends up printing `usage api/dsh-usage/overview failed: 500` to a user.
 * @module @linxin666/dsh-usage/client/error-text
 */

import { t, type UsageKey } from './locales.ts'

/** Failures that mean "the host could not be reached", whatever the wording. */
const NETWORK_ERROR = /failed to fetch|networkerror|network error|econnrefused|econnreset|enotfound|socket hang up|load failed|timeout|timed out|abort/i

/** A non-2xx answer carries its status as `… failed: 500`. */
const STATUS_ERROR = /failed: (\d{3})\b/

/**
 * A transport error as the panel states it: the wire's own words ("Failed to
 * fetch", "ECONNREFUSED", a timeout) are diagnostics, not something a user can
 * act on, so the network-shaped ones read as one localized sentence instead.
 *
 * A non-2xx answer arrives as `usage api/… failed: 500` — the internal route and
 * a bare status code, which used to be printed verbatim next to the translated
 * sentence around it. The status is the one part worth repeating, so it gets its
 * own sentence. `fallback` names the sentence for everything else: an abort, a
 * JSON parse failure ("Unexpected token <"), or a local file the host could not
 * read — a read failure and a request failure are not the same thing to the
 * person reading it. Callers keep the raw text in a title attribute, so the
 * diagnostic is never lost.
 */
export function describeError(error: string, fallback: UsageKey = 'usage.error.unknown'): string {
  if (NETWORK_ERROR.test(error)) return t('usage.error.network')
  const status = STATUS_ERROR.exec(error)
  return status === null ? t(fallback) : t('usage.error.status', { status: status[1] })
}
