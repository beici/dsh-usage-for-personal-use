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
 * Full digest of this machine's identity, derived from host, platform and user.
 *
 * Only a fallback: the authoritative machine id is the random one this plugin
 * persists (`ensureMachineId`), because a digest that follows the host name
 * changes when the machine is renamed — and then the file written under the old
 * name looks like a peer holding a copy of this machine's own history.
 */
export declare function localMachineId(): string;
/** Name of the file that pins this machine's identity inside the persist dir. */
export declare const MACHINE_ID_FILE = "machine-id.json";
/**
 * The machine id this profile has already minted, creating one on first run.
 *
 * Random rather than derived, and written once: it has to survive a host rename,
 * a user rename, and a reinstall of the plugin, because it is what tells "this
 * machine, renamed" apart from "a second machine". A digest of the host name
 * cannot do that — it changes exactly when the rename happens.
 */
export declare function ensureMachineId(dir: string): Promise<string>;
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
    machine?: string;
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
