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
import type { UsageLedgerDocument } from '../core/types.ts';
/** Prefix shared by every ledger file in the persist directory. */
export declare const LEDGER_FILE_PREFIX = "usage-ledger.";
/** The pre-device-split single file; migrated into the local device file. */
export declare const LEGACY_LEDGER_FILE = "usage-ledger.json";
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
export declare function isDeviceId(value: string): boolean;
/**
 * Stable, filesystem-safe id for this machine.
 *
 * Deterministic rather than random: two runs (and a fresh install) must agree,
 * or every restart would start a new ledger file. The hash covers host name,
 * platform, and home directory so two machines sharing a default host name
 * (`DESKTOP-XXXX`) still differ.
 */
export declare function localDeviceId(): string;
/** File name a device's ledger lives under. */
export declare function ledgerFileName(deviceId: string): string;
/**
 * Device id encoded in a ledger file name, or undefined for any other entry
 * (`usage-ledger.json` included — that legacy file is handled separately, and
 * an unrelated `usage-ledger.json.bak` must not be read as a device).
 */
export declare function deviceIdOfFile(name: string): string | undefined;
/** One parsed ledger file. */
export interface LoadedLedgerFile {
    deviceId: string;
    doc: UsageLedgerDocument;
    updatedAt?: number;
}
/**
 * Parse one peer ledger document from untrusted JSON.
 *
 * Accepts both the bare document (`{ version, days }`) and the export envelope
 * (`{ deviceId, ledger }`) so a hand-copied file works either way. Returns
 * `undefined` for anything unparseable — a corrupt peer file must degrade to
 * "that device is missing", never to a broken overview.
 */
export declare function parsePeerLedger(value: unknown): LoadedLedgerFile | undefined;
