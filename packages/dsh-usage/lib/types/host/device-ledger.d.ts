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
/**
 * Full digest of this machine's identity, written into every ledger file.
 *
 * The device id is that digest truncated, so a hostname rename (or a change of
 * user) mints a NEW id while the old file keeps the old one — and the old file
 * then looks like a peer device holding a copy of this machine's own history.
 * The untruncated digest is what lets a reader recognise that copy: two files
 * with the same `machine` are one machine, whatever their ids say.
 */
export declare function localMachineId(): string;
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
    /** Full machine digest the writer recorded, when it recorded one. */
    machine?: string;
    doc: UsageLedgerDocument;
    updatedAt?: number;
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
 * lowered.
 */
export declare function ledgerFileDocument(doc: Readonly<UsageLedgerDocument>, extra?: {
    repairedAt?: number;
}): UsageLedgerDocument & {
    deviceId: string;
    machine: string;
    repairedAt?: number;
};
/**
 * Parse one peer ledger document from untrusted JSON.
 *
 * Accepts both the bare document (`{ version, days }`) and the export envelope
 * (`{ deviceId, ledger }`) so a hand-copied file works either way. Returns
 * `undefined` for anything unparseable — a corrupt peer file must degrade to
 * "that device is missing", never to a broken overview.
 */
export declare function parsePeerLedger(value: unknown): LoadedLedgerFile | undefined;
