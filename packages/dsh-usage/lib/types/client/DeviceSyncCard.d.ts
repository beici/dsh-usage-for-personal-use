/**
 * The multi-device card: which ledger files back the totals above, plus the
 * manual export/import that moves one device's history to another.
 *
 * The design the card exposes is deliberately boring: there is no merge policy
 * to explain, because each machine owns exactly one file and the totals are a
 * sum over the files present. Export hands over this device's file; import
 * installs a peer's file under that peer's id. Neither direction can overwrite
 * the local history, so a round trip is safe to repeat.
 * @module @linxin666/dsh-usage/client/DeviceSyncCard
 */
import { type ReactNode } from 'react';
import type { DeviceLedgerEntryView } from '../core/types.ts';
/** The host half's device-sync API, as the browser half addresses it. */
export interface DeviceSyncApi {
    /** Download this device's ledger as a file. */
    exportLedger: () => Promise<void>;
    /** Install a peer's exported ledger; resolves with that peer's device id. */
    importLedger: (text: string) => Promise<{
        deviceId: string;
    }>;
    /**
     * Re-scan the persist directory for files copied in by hand. The answer is the
     * refreshed device list; the implementation also applies the fresh overview to
     * the panel's store, so the card does not ask the section to refetch after it.
     */
    rescan: () => Promise<DeviceLedgerEntryView[]>;
}
/**
 * The multi-device card. Device rows are the source list, not a picker: a peer
 * file is removed by deleting it from the DSH data directory, which the hint
 * says — an in-panel delete would need a confirmation surface the section has
 * nowhere to put.
 * @param props - the devices the overview reported, the sync API, and an optional read error.
 * @returns the card, or nothing when an older host serves no device list.
 */
export declare function DeviceSyncCard(props: {
    deviceId?: string;
    devices?: DeviceLedgerEntryView[];
    devicesError?: string;
    /** Absent on an older host face; the card then renders nothing. */
    api?: DeviceSyncApi;
    /** Called after an import so the section can refetch the summed overview. */
    onChanged: () => void;
}): ReactNode;
