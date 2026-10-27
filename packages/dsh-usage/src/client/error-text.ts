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

/**
 * A settings save: a transport failure reads as one localized sentence, but a
 * validation message from the host ("retainDays must be at least 1") is the one
 * part a user can act on, so it is shown as written. The row used to append the
 * generic "请求失败" to every failure, which turned a rejected number into a
 * network error that never happened (round-21 audit L1).
 */
export function describeSettingError(error: string): string {
  if (NETWORK_ERROR.test(error)) return t('usage.error.network')
  const status = STATUS_ERROR.exec(error)
  if (status !== null) return t('usage.error.status', { status: status[1] })
  return error
}

/**
 * The voucher's own draw failure already *is* the sentence: wrapping it in
 * "failed to render the voucher: …" printed it twice. Anything else keeps the
 * wrapper, so a real cause still reads as a cause.
 */
export function drawErrorText(error: string): string {
  const detail = describeError(error, 'usage.bank.drawFailed')
  return detail === t('usage.bank.drawFailed') ? detail : t('usage.bank.drawError', { error: detail })
}
