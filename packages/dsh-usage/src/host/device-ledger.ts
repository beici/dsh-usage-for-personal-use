/**
 * Per-device ledger files: the storage shape that makes multi-device totals
 * additive without ever overwriting another machine's history.
 *
 * Why one file per device
 * -----------------------
 * A backup/restore round trip has to answer "whose numbers win?" and every
 * answer loses something:
 *  - overwrite: the restoring device's own usage disappears;
 *  - sum: importing the same file twice double-counts;
 *  - max: two devices on one account undercount.
 *
 * So there is no merge policy here at all: each device only ever writes ITS
 * OWN file (`usage-ledger.<deviceId>.json`), and the overview sums whatever
 * files are present. Peer files are read, never written, so syncing the same
 * file twice is idempotent by construction — the totals depend on the set of
 * files, not on how many times one arrived.
 *
 * Import is the same statement from the other side: installing a peer's
 * document REPLACES that peer's file (keyed by the device id inside it), so a
 * re-import converges instead of accumulating.
 * @module @linxin666/dsh-usage/host/device-ledger
 */

import { createHash } from 'node:crypto'
import { hostname, platform, userInfo } from 'node:os'
import { deserializeLedger } from '../core/ledger.ts'
import type { UsageLedgerDocument } from '../core/types.ts'

/** Prefix shared by every ledger file in the persist directory. */
export const LEDGER_FILE_PREFIX = 'usage-ledger.'
/** The pre-device-split single file; migrated into the local device file. */
export const LEGACY_LEDGER_FILE = 'usage-ledger.json'
/** Suffix all ledger files carry. */
const LEDGER_FILE_SUFFIX = '.json'
/** A device id must survive being used as a filename on every platform. */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/

/**
 * Whether a string is a usable device id. Rejects path separators, dot-only
 * names, leading/trailing punctuation, and anything over 64 characters — an
 * id arrives from an imported file, so it is untrusted input that becomes a
 * filename.
 */
export function isDeviceId(value: string): boolean {
  if (!DEVICE_ID_PATTERN.test(value)) return false
  return value !== '.' && value !== '..'
}

/**
 * Stable, filesystem-safe id for this machine.
 *
 * Deterministic rather than random: two runs (and a fresh install) must agree,
 * or every restart would start a new ledger file. The hash covers host name,
 * platform, and home directory so two machines sharing a default host name
 * (`DESKTOP-XXXX`) still differ.
 */
export function localDeviceId(): string {
  let user = ''
  try {
    user = userInfo().username
  } catch {
    user = ''
  }
  let host = ''
  try {
    host = hostname()
  } catch {
    host = 'dsh'
  }
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'dsh'
  const digest = createHash('sha256').update(`${host}\u0000${platform()}\u0000${user}`).digest('hex').slice(0, 6)
  return `${slug}-${digest}`
}

/** File name a device's ledger lives under. */
export function ledgerFileName(deviceId: string): string {
  return `${LEDGER_FILE_PREFIX}${deviceId}${LEDGER_FILE_SUFFIX}`
}

/**
 * Device id encoded in a ledger file name, or undefined for any other entry
 * (`usage-ledger.json` included — that legacy file is handled separately, and
 * an unrelated `usage-ledger.json.bak` must not be read as a device).
 */
export function deviceIdOfFile(name: string): string | undefined {
  if (!name.startsWith(LEDGER_FILE_PREFIX) || !name.endsWith(LEDGER_FILE_SUFFIX)) return undefined
  const id = name.slice(LEDGER_FILE_PREFIX.length, name.length - LEDGER_FILE_SUFFIX.length)
  return isDeviceId(id) ? id : undefined
}

/** One parsed ledger file. */
export interface LoadedLedgerFile {
  deviceId: string
  doc: UsageLedgerDocument
  updatedAt?: number
}

/**
 * Parse one peer ledger document from untrusted JSON.
 *
 * Accepts both the bare document (`{ version, days }`) and the export envelope
 * (`{ deviceId, ledger }`) so a hand-copied file works either way. Returns
 * `undefined` for anything unparseable — a corrupt peer file must degrade to
 * "that device is missing", never to a broken overview.
 */
export function parsePeerLedger(value: unknown): LoadedLedgerFile | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { deviceId?: unknown; ledger?: unknown; days?: unknown }
  // Envelope form: { deviceId, ledger: { version, days } }. The payload has to
  // be an object carrying `days`: `deserializeLedger` tolerates anything and
  // answers an empty document, so a string here would otherwise import as a
  // real-but-empty peer and show a device row that sums to nothing.
  if (typeof record.deviceId === 'string') {
    if (!isDeviceId(record.deviceId)) return undefined
    const ledger = record.ledger
    if (!hasDayMap(ledger)) return undefined
    return { deviceId: record.deviceId, doc: deserializeLedger(ledger) }
  }
  // Bare document form: the device id then comes from the file name.
  if (hasDayMap(value)) return { deviceId: '', doc: deserializeLedger(value) }
  return undefined
}

/** Whether `value` is a document-shaped payload with a `days` object. */
function hasDayMap(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const days = (value as { days?: unknown }).days
  return typeof days === 'object' && days !== null && Array.isArray(days) === false
}
