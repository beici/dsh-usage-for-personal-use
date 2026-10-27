/**
 * The usage ledger: a pure fold from session usage facts into a per-day,
 * per-provider, per-model totals document, plus its JSON serialization.
 * Host-side state lives only in the document; the service owns persistence.
 * @module @linxin666/dsh-usage/core/ledger
 */
import { type UsageLedgerDocument, type UsageProviderSummary, type UsageTokenTotals } from './types.ts';
/** Local-date key (`YYYY-MM-DD`) for an epoch ms timestamp. */
export declare function localDateKey(ms: number): string;
/**
 * Whether `key` is a real local-date key (`YYYY-MM-DD`). The shape check is
 * round-tripped: an impossible date (9999-99-99) parses to NaN and a rollover
 * (2026-02-30) lands on another day, so both would otherwise fold into a bogus,
 * never-pruned bucket. Shared by the persisted-document reader and the day
 * route's query gate.
 */
export declare function isLedgerDateKey(key: string): boolean;
/** An empty ledger document. */
export declare function createLedgerDocument(): UsageLedgerDocument;
/**
 * Fold one usage report into the ledger in place. `provider` is the route key
 * and `model` the provider-owned model id the step ran under. Reports keyed
 * by prototype-plumbing names are dropped.
 */
export declare function foldUsage(doc: UsageLedgerDocument, atMs: number, provider: string, model: string, usage: Readonly<UsageTokenTotals>): void;
/**
 * Sum every bucket of `source` into `target`, in place.
 *
 * Distinct from a re-load of the SAME document: two devices that each ran a
 * model on one shared account did both spend those tokens, so their ledgers
 * add. `foldUsage` is the primitive because a bucket sum is exactly what it
 * does; the day key comes from the stored date, so a peer's timestamps never
 * leak into the local clock.
 */
export declare function mergeLedgerSum(target: UsageLedgerDocument, source: Readonly<UsageLedgerDocument>): void;
/** Total tokens of a bucket (billed input + output; reasoning is inside output). */
export declare function totalTokens(totals: Readonly<UsageTokenTotals>): number;
/**
 * Merge `source` into `target`, keeping the larger value of every field.
 *
 * The right rule when two processes on ONE machine write the same ledger file:
 * both observe a subset of the same calls, so a bucket sum would count the
 * calls both of them saw twice, while the larger value is the more complete
 * view of that day. (Peer devices are the opposite case — see mergeLedgerSum.)
 *
 * The merge is per field, not per bucket: choosing one bucket wholesale and
 * copying it over the other drops every field `totalTokens` ignores (a bucket
 * with cache-read tokens or a cost estimate loses them to a larger-but-poorer
 * one). Buckets only ever grow, so the per-field maximum is also monotone.
 */
export declare function mergeLedgerMax(target: UsageLedgerDocument, source: Readonly<UsageLedgerDocument>): void;
/**
 * `bucket` minus `extra`, floored at zero per field.
 *
 * Only used by the one-time duplicate-replay repair, where `extra` is a copy
 * that was folded twice. `cost` comes back as 0 because the caller reprices
 * the shrunken bucket from its tokens — a stored cost cannot be split.
 */
export declare function subtractTotals(bucket: Readonly<UsageTokenTotals>, extra: Readonly<UsageTokenTotals>): UsageTokenTotals;
/**
 * Per-field maximum of two totals.
 *
 * The floor of a correction: subtracting a duplicate copy may never take a
 * bucket below what the deduped replay says that day really billed.
 */
export declare function maxTotals(a: Readonly<UsageTokenTotals>, b: Readonly<UsageTokenTotals>): UsageTokenTotals;
/**
 * Add `current`'s growth since `baseline` onto `target`, per bucket.
 *
 * The write path of one process that shares its ledger file with another: the
 * file already holds what both of them counted up to their last writes, so only
 * the calls folded since our own last write may be added. Growth is floored at
 * zero, so a bucket that shrank (a repair, a prune) never subtracts from the
 * other process's numbers.
 */
export declare function mergeLedgerDelta(target: UsageLedgerDocument, current: Readonly<UsageLedgerDocument>, baseline: Readonly<UsageLedgerDocument>): void;
/** How many model rows one summarized provider keeps. */
export declare const SUMMARY_MODEL_CAP = 12;
/**
 * Aggregate whole per-day maps (each `provider -> model -> totals`) into the
 * per-provider/per-model summary the overview serves for one day or a range:
 * disjoint bucket sums per provider, per-model rows heaviest first, and the
 * grand total. Pure: reads its inputs, allocates fresh buckets.
 */
export declare function summarizeDays(days: ReadonlyArray<Record<string, Record<string, UsageTokenTotals>>>): {
    totals: UsageTokenTotals;
    providers: UsageProviderSummary[];
};
/** All local-date keys in the ledger, ascending. */
export declare function ledgerDayKeys(doc: Readonly<UsageLedgerDocument>): string[];
/**
 * How many recorded days a prune with these settings would delete.
 *
 * Split out from `pruneLedger` so a caller can refuse a suspicious prune before
 * it happens: a forward clock jump makes every recorded day look ancient, and
 * deleting them would destroy the history the plugin exists to keep.
 */
export declare function countPrunable(doc: Readonly<UsageLedgerDocument>, todayKey: string, retainDays: number): number;
/**
 * Drop every day older than `retainDays` local days before `todayKey`, in
 * place. Returns the number of pruned days.
 */
export declare function pruneLedger(doc: UsageLedgerDocument, todayKey: string, retainDays: number): number;
/**
 * Parse a ledger document the strict way: a document whose `days` is not a plain
 * object is *not* a ledger this build wrote, and reading it as "no days" would let
 * the next flush overwrite the user's history with an empty one.
 *
 * `days: []`, `days: "…"` and `days: 42` are the shapes an interrupted or
 * hand-edited write leaves behind; the caller quarantines the file instead.
 * A document with no `days` key at all stays a fresh ledger — that is the shape
 * an export or a first run has.
 */
export declare function deserializeLedgerStrict(value: unknown): UsageLedgerDocument | undefined;
/**
 * Parse a ledger document from untrusted JSON: unknown shapes resolve to an
 * empty document, malformed entries are dropped, numbers are coerced to
 * finite values. Never throws.
 */
export declare function deserializeLedger(value: unknown): UsageLedgerDocument;
