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

import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { hostname, platform, userInfo } from 'node:os'
import { join } from 'node:path'
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
 *
 * A dot is rejected outright: every id this plugin mints is a host slug plus a
 * hex digest, so a dotted name is never one of ours — it is a copy sitting next
 * to the real file (`usage-ledger.<id>.bak.json`). Reading those as devices is
 * how one machine's history gets summed twice.
 */
export function isDeviceId(value: string): boolean {
  if (!DEVICE_ID_PATTERN.test(value)) return false
  if (value.includes('.')) return false
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
  return `${machineSlug()}-${machineDigest().slice(0, 6)}`
}

/**
 * Full digest of this machine's identity, derived from host, platform and user.
 *
 * Only a fallback: the authoritative machine id is the random one this plugin
 * persists (`ensureMachineId`), because a digest that follows the host name
 * changes when the machine is renamed — and then the file written under the old
 * name looks like a peer holding a copy of this machine's own history.
 */
export function localMachineId(): string {
  return machineDigest()
}

/** Name of the file that pins this machine's identity inside the persist dir. */
export const MACHINE_ID_FILE = 'machine-id.json'

/**
 * The machine id this profile has already minted, creating one on first run.
 *
 * Random rather than derived, and written once: it has to survive a host rename,
 * a user rename, and a reinstall of the plugin, because it is what tells "this
 * machine, renamed" apart from "a second machine". A digest of the host name
 * cannot do that — it changes exactly when the rename happens.
 */
export async function ensureMachineId(dir: string): Promise<string> {
  const path = join(dir, MACHINE_ID_FILE)
  const read = async (): Promise<string | undefined> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      const id = (parsed as { machineId?: unknown } | null)?.machineId
      return typeof id === 'string' && MACHINE_ID_PATTERN.test(id) ? id : undefined
    } catch {
      return undefined
    }
  }
  const known = await read()
  if (known !== undefined) return known
  const minted = randomUUID().replace(/-/g, '')
  try {
    await mkdir(dir, { recursive: true })
    // Two processes starting together both find no file and both mint an id;
    // whichever writes second must lose, or the two of them spend the session
    // stamping documents with ids that disagree — and a file stamped with the
    // losing id looks like a different machine to its own sibling.
    await writeFile(path, machineIdBody(minted, []), { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    // Losing the race is the expected path: read back what the winner wrote.
    const settled = await read()
    if (settled !== undefined) return settled
    if ((error as { code?: string }).code !== 'EEXIST') {
      // A read-only profile cannot pin the id: the digest still names this
      // machine well enough for one run, and the next writable start mints the
      // real one.
      return localMachineId()
    }
    // The file exists but is unreadable: overwrite it rather than run unpinned,
    // but keep whatever id it still holds so files stamped with it stay
    // recognisable as this machine instead of turning into a phantom peer.
    const salvage = (await readRawIds(path)).filter((id) => id !== minted)
    try {
      await writeFile(path, machineIdBody(minted, salvage), 'utf8')
      return minted
    } catch {
      return localMachineId()
    }
  }
  return minted
}

/** The pinned-id file body: the live id plus every id this profile used before. */
function machineIdBody(machineId: string, previous: string[]): string {
  return `${JSON.stringify({ version: 2, machineId, previous }, null, 2)}\n`
}

/** Every id-shaped string in a file we failed to parse, newest first. */
async function readRawIds(path: string): Promise<string[]> {
  try {
    const raw = await readFile(path, 'utf8')
    const found = raw.match(/[0-9a-f]{32}/g) ?? []
    return [...new Set(found)]
  } catch {
    return []
  }
}

/**
 * Ids this profile has used before.
 *
 * A re-minted pin (a lost `machine-id.json`, a moved profile, an upgrade from a
 * build that never pinned one) leaves older files stamped with the old id. Those
 * files are this machine's own history, so they have to be folded in rather than
 * summed as a second device — the difference is a permanently doubled total.
 */
export async function readMachineAliases(dir: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, MACHINE_ID_FILE), 'utf8'))
    const list = (parsed as { previous?: unknown } | null)?.previous
    if (!Array.isArray(list)) return []
    return list.filter((id): id is string => typeof id === 'string' && MACHINE_ID_PATTERN.test(id))
  } catch {
    return []
  }
}

/** 32 lowercase hex characters: what `ensureMachineId` mints and accepts. */
const MACHINE_ID_PATTERN = /^[0-9a-f]{32}$/

/** The slug half of the device id (host name, made filename-safe). */
function machineSlug(): string {
  return readHost()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'dsh'
}

/** sha256 over host, platform and user — the whole identity, not a truncation. */
function machineDigest(): string {
  return createHash('sha256').update(`${readHost()}\u0000${platform()}\u0000${readUser()}`).digest('hex')
}

function readHost(): string {
  try {
    return hostname()
  } catch {
    return 'dsh'
  }
}

function readUser(): string {
  try {
    return userInfo().username
  } catch {
    return ''
  }
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
  /** Full machine digest the writer recorded, when it recorded one. */
  machine?: string
  doc: UsageLedgerDocument
  updatedAt?: number
  /** Retention the writer had applied, so a lowered setting survives a restart. */
  retentionDays?: number
}

/**
 * The document as it is written to disk: the ledger plus the identity of the
 * machine that wrote it.
 *
 * `days` stays at the top level on purpose. An older build reads a document
 * whose `days` is missing as an empty ledger, so nesting the payload (the
 * `/export` envelope does exactly that) would let a downgrade overwrite the
 * history with nothing. `repairedAt` marks the last correction, so a process
 * that loaded before the correction cannot raise a bucket a newer write
 * lowered. `retentionDays` records which window the writer pruned to: without
 * it a restart cannot tell "the user lowered retention while we were down" from
 * "the clock jumped", and it refuses the prune forever.
 */
export function ledgerFileDocument(
  doc: Readonly<UsageLedgerDocument>,
  extra?: { repairedAt?: number; machine?: string; retentionDays?: number },
): UsageLedgerDocument & { deviceId: string; machine: string; repairedAt?: number; retentionDays?: number } {
  return {
    ...doc,
    deviceId: localDeviceId(),
    machine: extra?.machine ?? localMachineId(),
    ...(extra?.repairedAt !== undefined ? { repairedAt: extra.repairedAt } : {}),
    ...(extra?.retentionDays !== undefined ? { retentionDays: extra.retentionDays } : {}),
  }
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
  const record = value as { deviceId?: unknown; machine?: unknown; ledger?: unknown; days?: unknown; retentionDays?: unknown }
  const machine = typeof record.machine === 'string' && record.machine !== '' ? record.machine : undefined
  const retentionDays = typeof record.retentionDays === 'number' && Number.isFinite(record.retentionDays) ? record.retentionDays : undefined
  // Envelope form: { deviceId, ledger: { version, days } }. The payload has to
  // be an object carrying `days`: `deserializeLedger` tolerates anything and
  // answers an empty document, so a string here would otherwise import as a
  // real-but-empty peer and show a device row that sums to nothing.
  if (typeof record.deviceId === 'string') {
    if (!isDeviceId(record.deviceId)) return undefined
    // Two shapes carry the id: the export envelope (`{deviceId, ledger}`) and the
    // file this build writes (`{deviceId, machine, days}`). Only the envelope
    // nests the payload, so accepting just that one silently rejected every peer
    // file written by this build — the device simply disappeared from the panel.
    const payload = hasDayMap(record.ledger) ? record.ledger : hasDayMap(value) ? value : undefined
    if (payload === undefined) return undefined
    return { deviceId: record.deviceId, machine, doc: deserializeLedger(payload), retentionDays }
  }
  // Bare document form: the device id then comes from the file name. Callers
  // must not trust it — a bare document carries no proof of which machine wrote
  // it, and this build writes its own files WITH the id (see
  // `ledgerFileDocument`), so a bare file is a copy, not a device.
  if (hasDayMap(value)) return { deviceId: '', machine, doc: deserializeLedger(value), retentionDays }
  return undefined
}

/** Whether `value` is a document-shaped payload with a `days` object. */
function hasDayMap(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const days = (value as { days?: unknown }).days
  return typeof days === 'object' && days !== null && Array.isArray(days) === false
}
