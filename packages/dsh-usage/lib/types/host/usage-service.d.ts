/**
 * The dsh-usage host service: folds live session usage into the persistent
 * ledger, probes each configured provider's balance/coding-plan endpoint on
 * a poll cycle, and serves the current provider's strip-ready view inside
 * the overview document. Secrets stay in the host process; the browser only
 * ever sees the overview document.
 * @module @linxin666/dsh-usage/host/usage-service
 */
import type { Context } from '@deepseek-ai/cordis';
import type { DeviceLedgerEntryView, UsageDayView, UsageLedgerExport, UsageOverviewView, UsageRangeResponse } from '../core/types.ts';
/**
 * Persisted accrual state for the official DeepSeek family's real spend:
 * consecutive observations of the official CNY balance, decreases counted
 * as spent (a rise is a top-up and never accrues). `since` is the first
 * observation; the ledger keeps no such fact, so this watch is the only
 * source of the voucher's observed-spend figure.
 */
export interface SpendWatch {
    /** Total observed decrease since `since`, in CNY. */
    accruedCny: number;
    /** Epoch ms of the first balance observation. */
    since: number;
    /** The balance the previous observation ended on, when one exists. */
    lastBalanceCny?: number;
}
/** Poll-loop options; re-applied live on settings change. */
export interface UsageServiceOptions {
    pollIntervalSec: number;
    retainDays: number;
}
/**
 * A rejected import, distinguished from an I/O failure so the route can answer
 * 400 for "that file is not a ledger" and 500 for "the disk refused".
 */
export declare class UsageImportError extends Error {
    constructor(message: string);
}
export declare class UsageService {
    private readonly ctx;
    private options;
    private readonly persistDir;
    /**
     * This machine's own ledger file. Every write goes here and nowhere else —
     * see device-ledger.ts for why there is no "import overwrites" path.
     */
    private readonly ledgerPath;
    private readonly snapshotsPath;
    /** This machine's stable id; peers are keyed by theirs. */
    private readonly deviceId;
    /**
     * Peer ledgers, keyed by device id. Read-only: refreshed on load, on flush,
     * and on demand from the panel. They are summed into the served view but
     * never written back to disk.
     */
    private peers;
    /** Last peer scan failure, surfaced in the overview so a silent empty merge is visible. */
    private peersError;
    /**
     * Last ledger load failure, surfaced in the overview. A file that could not be
     * read is never overwritten, so this is the only trace of why the totals are
     * empty this boot.
     */
    private ledgerError;
    /**
     * A condition the user should know about that is not an error: a replay cut
     * short by the per-start cap, or a file that turned out to belong to another
     * device. Shown next to `ledgerError`, because a silently shortened history
     * reads exactly like a complete one.
     *
     * Keyed by kind, so a condition that repeats every flush states itself once
     * instead of growing a sentence longer on every write.
     */
    private readonly notes;
    /** The document as it was before the first load absorb, so a retry starts clean. */
    private loadBaseline;
    /** True once the persisted document has been folded into memory this boot. */
    private loadAbsorbed;
    /**
     * The smallest retention this process has seen applied.
     *
     * A lower setting than this means the user shrank the window on purpose, which
     * the "clock jumped" guard in `pruneForWrite` must not veto. Seeded from the
     * retention the file itself records, so a setting changed while the app was
     * closed is still recognised as a shrink instead of looking like a jump.
     */
    private retentionSeen;
    /**
     * This machine's identity as recorded in every file it writes.
     *
     * Pinned in `machine-id.json` on first run rather than derived from the host
     * name: a rename must not make this machine look like a second device.
     */
    private machine;
    /**
     * Ids this profile used before the current pin: a re-minted pin leaves files
     * stamped with an older id, and those are this machine's own history, not a
     * second device. Folded in (max merge) instead of summed.
     */
    private readonly machineAliases;
    /**
     * The deduped replay of this boot, kept so a flush that must not max-merge
     * (a file another process repaired) can still add the buckets only the replay
     * recovers — those are not expressible as growth since our last write.
     */
    private replayDoc;
    private ledger;
    /**
     * The document this process last wrote to disk. Another process on this
     * machine writes the same file, so a flush adds only what we folded since
     * this snapshot — adding the whole document would count its calls twice.
     */
    private ledgerWritten;
    /**
     * Newest `repairedAt` this process has already accounted for. A file carrying
     * a later stamp was corrected by another process after we loaded, and its
     * (lower) buckets must not be raised again by our stale copy.
     */
    private seenRepairedAt;
    private readonly snapshots;
    /** The official DeepSeek family's real-spend watch (see SpendWatch). */
    private spendWatch;
    /** Per-live-session route attribution (WeakMap: disposed sessions age out). */
    private readonly sessionRoutes;
    /** The most recent route seen this boot; the sidebar strip and the header highlight follow it. */
    private current;
    private sessionListenerDisposer;
    private pollTimer;
    private flushTimer;
    private pollInFlight;
    /** The running poll cycle; manual refresh joins it instead of no-oping. */
    private pollPromise;
    /** Serialized ledger flushes: overlapping debounce/stop flushes queue, never interleave. */
    private flushChain;
    /** True once loadPersisted finished; nothing may overwrite the files before that. */
    private loaded;
    /** Retry bookkeeping for a ledger file that could not be read this boot. */
    private loadRetries;
    private loadRetryTimer;
    private disposed;
    /** Last prune guard: once per local day, and whenever retention shrinks. */
    private lastPrune;
    constructor(ctx: Context, options: UsageServiceOptions);
    /** Start the listeners, load persisted state, and arm the first poll. */
    start(): void;
    /**
     * Stop timers and flush pending ledger writes. The returned promise
     * resolves after the final flush lands, so a successor instance (the Host
     * reloads the profile row on a config change) can serialize its first load
     * behind it.
     */
    stop(): Promise<void>;
    /** Re-apply options to this running instance; retention shrink prunes now. */
    applyOptions(options: UsageServiceOptions): void;
    /** Force one poll now (manual refresh route); joins an in-flight cycle. */
    refresh(): Promise<void>;
    /** This machine's stable id — the key its exported ledger carries. */
    get device(): string;
    /**
     * This device's own ledger as a portable export envelope.
     *
     * Contains only this machine's history: peers are already counted on the
     * receiving side when their files are present, so re-exporting them would
     * make totals grow with each round trip.
     */
    exportLedger(): UsageLedgerExport;
    /**
     * Install a peer's exported ledger as that device's file.
     *
     * REPLACES the peer file rather than merging into it, which is what makes a
     * repeated import idempotent: the totals served are a sum over files that
     * exist, so importing the same document twice changes nothing. The device id
     * comes from inside the document (validated as a filename-safe token), so the
     * receiving machine never has to know the sender's file name.
     * @param text - raw JSON of an export envelope or a bare ledger document.
     * @returns the device id that was written.
     */
    importPeer(text: string): Promise<{
        deviceId: string;
    }>;
    /** Re-scan peer files; the panel calls this after a file is dropped in by hand. */
    rescanPeers(): Promise<DeviceLedgerEntryView[]>;
    /** Assemble the overview document the browser section renders. */
    overview(): UsageOverviewView;
    /** Every ledger file backing the served totals, this device first. */
    private deviceEntries;
    /**
     * The served document: this device's ledger plus every peer's, summed.
     *
     * Summed, not merged by max: two devices on one account genuinely spent both
     * sets of tokens, so the ledger a user expects is the sum. Nothing here is
     * ever written back — `this.ledger` stays this device's own history, which is
     * what makes a repeated peer import idempotent (the same file is read twice,
     * not added twice).
     */
    private mergedLedger;
    /**
     * The strip-ready current-provider view: the resolved display name plus
     * today's ledger totals for the provider's adapter family (the route
     * itself when adapter-less). `today` is absent on a day without usage —
     * a strip about nothing is noise, not information.
     */
    private currentView;
    /**
     * One retained local day aggregated per provider and model, as the day
     * route serves it. A day the ledger never held — pruned by retention, or
     * simply without usage — reads as a zeroed day rather than an error, so a
     * picker selection that aged out degrades to "no usage" instead of a broken
     * panel. The route gates the key's shape before it gets here.
     */
    day(dateKey: string): UsageDayView;
    /**
     * One window aggregated per provider and model, plus the per-day series the
     * trend chart buckets. Reads the merged ledger (local + imported peers), so
     * a single request answers a window that would otherwise cost one small
     * fetch per recorded day — the shape that makes multi-month windows viable.
     * Each series row also carries the day's per-model split aggregated across
     * providers, so the browser can stack the trend bars by model without one
     * day fetch per recorded day.
     * @param from - local date key `YYYY-MM-DD`, inclusive.
     * @param to - local date key `YYYY-MM-DD`, inclusive.
     */
    range(from: string, to: string): Omit<UsageRangeResponse, 'ok'>;
    /** One day of the merged ledger aggregated per provider. */
    private daySummaryIn;
    /** One local day aggregated per provider. */
    private daySummary;
    /**
     * Today's ledger totals for one provider's adapter family — the exact
     * route when adapter-less, the merged family otherwise, so aliased routes
     * of one account (the deepseek catalog id and its runtime alias) fold
     * together.
     */
    private familyUsageToday;
    /**
     * Accrue the official DeepSeek family's real spend from observed CNY
     * balance decreases; a balance rise is a top-up and never counts. The
     * family's route ids can alias one account, so the watch follows the
     * largest balance seen this cycle and accrues only decreases of that
     * series — a failed probe keeps the stale balance and accrues nothing
     * until the next success reports the whole drop at once.
     */
    private accrueDeepSeekSpend;
    /**
     * The display name for a route key: the LLM runtime's first, then the
     * adapter's, then the id itself — the snapshot may not exist for
     * adapter-less routes, yet the sidebar strip still needs a legible title.
     */
    private routeDisplayName;
    private onSessionEvent;
    /**
     * Normalize a provider TokenUsage into the ledger bucket (one call). The
     * DeepSeek official family is priced at the fold instant (its billing
     * period is time-of-day); other families stay unpriced (cost 0).
     */
    private totalsFrom;
    /**
     * Read this device's ledger file, telling the three failures apart: absent,
     * unreadable (locked or permission-denied — the data may still be there), and
     * corrupt (present but unparseable). Only "absent" may start a fresh file;
     * treating either failure as "no history" would let the next flush replace a
     * real ledger with an empty one.
     */
    private readLedgerFile;
    /**
     * Parse ledger JSON, accepting the `/export` envelope as well as a bare document.
     *
     * An export wraps the document as `{schema, version, deviceId, exportedAt,
     * ledger}`, and restoring a backup means dropping exactly that file back in
     * place. Reading only the top-level `days` would call it a valid *empty*
     * ledger, and the first flush would then write that emptiness over the
     * history — while `importPeer` refuses this device's own export, leaving no
     * recovery path at all. So the envelope is unwrapped here, and a file naming
     * another device is refused instead of adopted (it belongs in the peers path).
     */
    private ledgerFromJson;
    private loadPersisted;
    private loadPersistedOnce;
    /**
     * Record a non-fatal note the panel shows beside the numbers.
     *
     * Notes are keyed: a condition that holds on every flush ("retention
     * skipped …") must not append itself again and again, or the line the user
     * reads grows for as long as the process runs.
     */
    private note;
    /** Drop a note whose condition no longer holds. */
    private clearNote;
    /** Drop every note whose kind starts with `prefix` (peer notes, per scan). */
    private clearNotesWithPrefix;
    /**
     * Whether a machine id taken from a file names this machine.
     *
     * Three cases count: the live pin, an id this profile used before (a lost
     * `machine-id.json` mints a new one while older files keep the old stamp), and
     * the derived digest that builds before the pin stamped into their files. All
     * three hold this machine's own history; summing any of them as a second device
     * would count those calls twice. Two machines whose host name, user and
     * platform are identical share a digest — that undercounts, which is the lesser
     * evil compared with a permanently doubled history.
     */
    private sameMachine;
    /** Remember an id this profile has written under, so its old files fold in. */
    private rememberMachine;
    /** The notes as one line, oldest first, capped so the panel stays readable. */
    private ledgerNoteText;
    /** Retry a ledger read that failed for a transient reason (lock, sharing). */
    private scheduleLoadRetry;
    /** Revive the probe cache and the spend watch; both are best-effort. */
    private loadSnapshots;
    /**
     * Fold the session transcripts back into the ledger.
     *
     * `session/event` only carries records appended while an instance is
     * mounted, so calls made before the first mount — or during a remount
     * window — exist nowhere else. Every bucket is merged field by field with the
     * larger value winning: replay never shrinks a live bucket, and a ledger
     * rebuilt from an older transcript never loses a newer live fold, so running
     * this on every start is idempotent. (Field by field, because the two sides
     * can each carry a field the other lacks — a cost estimate, cache-read
     * tokens — and picking one bucket wholesale would delete them.)
     *
     * The pass also reports the duplicate copies it dropped, so the repair below
     * can use them without walking the transcripts (287 MB, ~18 s) again.
     */
    private replaySessionLogs;
    /**
     * Correction for the seeded-subagent duplicate.
     *
     * A seeded subagent's transcript opens with a verbatim copy of its parent's
     * assistant messages (same id, time and usage), and the replay used to fold
     * both copies into the same bucket. Deduping the replay stops new inflation
     * but cannot undo what is already written — the merge rule keeps the larger
     * total, so an inflated bucket would never come back down. The extra copies
     * are therefore subtracted once, and a sidecar marker records what was done.
     *
     * The subtraction is judged twice over, because a wrong subtraction cannot be
     * undone by any later merge:
     *
     * - `clean` is the deduped replay, the truth for that day. A bucket at or
     *   below it holds no copy at all, so it is left alone.
     * - `prior` is what an earlier start already left in the bucket (read back
     *   from the marker). A bucket still at that floor has already been corrected
     *   — subtracting again on every start would slowly eat real calls, which is
     *   exactly what a plain "big enough to subtract" guard allows once the day
     *   holds calls the replay cannot see.
     */
    private repairDuplicatedReplay;
    /**
     * Price one bucket at its day's noon rate.
     *
     * Shared by the repair and the file-side pass so both write the same numbers:
     * the day is priced as a whole, which is why the noon instant stands in for
     * the calls inside it.
     */
    private priceBucket;
    /**
     * What the last repair left in each bucket, read back from the marker.
     *
     * The marker is a record, not a gate: the numbers it holds are the floor a
     * later start must not subtract below. A marker written before this field
     * existed (or one damaged by hand) yields an empty map, and the repair then
     * falls back to the replay's own total.
     */
    private readRepairRecord;
    /**
     * Fold a parsed document into a target ledger.
     *
     * Accumulates rather than replaces: folds that landed while the file was
     * being read (a session finishing during startup) must survive the load.
     */
    private absorb;
    /**
     * One-time migration off `usage-ledger.json`.
     *
     * Renamed rather than deleted: if the migration is wrong the user's only
     * pre-existing history would otherwise be gone, and a `.migrated` sibling is
     * cheap. A failed rename (read-only directory) leaves the legacy file in
     * place — the next start retries, and the ledger is still summed in.
     *
     * The `.migrated` sibling is read as well: it is what a successful migration
     * leaves behind, and it is the only copy of the pre-migration history once
     * this device's file is deleted or damaged. Re-adopting it is safe — the fold
     * is a merge, and the buckets it restores are the ones the file states.
     */
    /**
     * Fold the pre-migration history back in after the ledger was lost.
     *
     * The oldest days predate the session transcripts this build replays, so the
     * ledger file is their only copy. When a corrupt file is quarantined the fresh
     * document starts empty and that history would be gone for good; the legacy
     * file (or its `.migrated` sibling) still states it, and the merge is a max —
     * it can only restore days the new document does not have.
     */
    private restoreMigratedHistory;
    private adoptLegacyLedger;
    /**
     * Re-read every peer ledger file in the persist directory.
     *
     * Peers are whatever `usage-ledger.<deviceId>.json` files are present, so
     * "importing" a device is just dropping its file in — and re-importing the
     * same file changes nothing, because the totals are derived from the set of
     * files rather than accumulated into state.
     *
     * A file only counts as a device when its own document proves which machine
     * wrote it: this build stamps `deviceId` and `machine` into every ledger it
     * writes, so a file without them is a copy (a renamed backup, a hand-placed
     * duplicate) and summing it would count this machine's calls twice. Every
     * refusal is reported rather than swallowed, because a silently missing
     * device reads exactly like a device that never existed.
     */
    private refreshPeers;
    private scheduleFlush;
    /**
     * Queue one ledger flush behind the previous one. Debounce and stop-time
     * flushes serialize here, so two `writeJsonAtomic` calls can never run
     * concurrently on the same path.
     */
    private flushLedger;
    private writeLedgerOnce;
    /**
     * Run `work` while holding the ledger lock file.
     *
     * The lock is advisory and best effort by design: a stale lock (a crashed
     * process) must not block writing forever, so it is broken after
     * `LOCK_STALE_MS`, and a run that cannot take it proceeds anyway — losing one
     * interleaved write is recoverable on the next replay, while refusing to write
     * at all loses every call made after it.
     */
    private withLedgerLock;
    private writeLedgerLocked;
    /** This process's ledger as a file document: the identity travels with it. */
    private ledgerFileDocument;
    /**
     * Prune a document about to be written, refusing a prune that would delete
     * most of the history at once.
     *
     * Retention is measured against the clock, so one jump forward (a dead BIOS
     * battery, an NTP correction, a timezone change read as a new date) would
     * otherwise drop every day outside the window in a single flush — silently,
     * because the panel simply shows fewer days.
     */
    private pruneForWrite;
    /** The ledger file as another writer left it: absent, parsed, or unreadable. */
    private readDiskLedger;
    /**
     * Write the duplicate repair over the file, keeping what other writers added.
     *
     * A verbatim overwrite would also drop the calls another process folded while
     * this one spent ~18 s replaying the transcripts, so the correction is applied
     * to the file's own document: a bucket is capped at its repaired value only
     * while it still carries the inflated total.
     *
     * Returns only the buckets that were really written, so the marker records a
     * correction that happened rather than one that was intended.
     */
    private persistRepair;
    /**
     * Prune days past retention. Runs at most once per local day and whenever
     * `retainDays` shrinks — not only at startup, so long-lived processes and
     * live settings changes both honor retention.
     */
    private pruneIfNeeded;
    /**
     * Persist the probe snapshots and the spend watch.
     *
     * Two processes on one machine share this file too, and the watch is an
     * accrual: a blind overwrite lets the slower writer erase the spend the faster
     * one already counted. The merge keeps the larger accrual (it can only grow),
     * its own `since`, and its own last balance, so the pair stays consistent.
     */
    private persistSnapshots;
    private rearmPoll;
    /**
     * One poll cycle: enumerate routes, resolve credentials, probe.
     * A call while a cycle is already running joins that cycle instead of
     * returning immediately, so a manual refresh always waits for real probes.
     */
    pollNow(): Promise<void>;
    /**
     * Every route the service probes and renders: the runtime's live providers
     * plus the configurable directory's catalog entries, then alias-folded so a
     * dormant catalog entry cannot shadow the live route of the same adapter
     * family (see foldAliasRoutes).
     */
    private listProviderRoutes;
    private probeRoute;
    /**
     * Resolve the credential backing one route: pi-ai credential records
     * first, then the profile's apiKeyEnv reference, then the DeepSeek
     * official adapter's env reference. OAuth grants hand their stored access
     * token to the oauth-aware adapters (Codex plan quota); a stale token
     * fails its probe with a 401 and refreshes the next time the harness
     * itself runs that provider.
     */
    private resolveCredential;
    /** The llm-pi-ai profile object for one provider route, when configured. */
    private piAiProfile;
    /** The DeepSeek official adapter's credential reference name. */
    private deepseekApiKeyEnv;
    /** The DeepSeek official adapter's configured baseURL. */
    private deepseekBaseUrl;
    /** The effective base URL for a provider route (pi-ai or deepseek). */
    private routeBaseUrl;
}
