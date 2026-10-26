/**
 * Recover billed model calls from the session transcripts.
 *
 * `session/event` only delivers records appended while a usage-service instance
 * is mounted, so every call made before the first mount — and every call made
 * during a remount window — never reaches the live fold. The transcripts under
 * `<dshHome>/sessions/<workspace>/<session>/session.v4.jsonl.zstd` keep the
 * complete record instead: one `assistant/message` event per billed model call,
 * each carrying its own `usage` and `message.source` route. Replaying them
 * yields a day/provider/model document that is merged back into the ledger.
 *
 * A transcript is a concatenation of independent zstd frames (one per append
 * batch) and `zstdDecompressSync` decodes only the leading frame, so the frame
 * walk below is required, not defensive. A seeded subagent's transcript opens
 * with a verbatim copy of its parent's messages, so one pass dedupes the whole
 * run by message id before folding.
 * @module @linxin666/dsh-usage/host/session-log-backfill
 */
import type { UsageLedgerDocument, UsageTokenTotals } from '../core/types.ts';
/**
 * Offset just past the zstd frame that starts at `start`, or -1 when the frame
 * header or any of its blocks runs past the end of `buf`.
 */
export declare function zstdFrameEnd(buf: Buffer, start: number): number;
/**
 * Decode every zstd frame in `buf` into one UTF-8 string. A truncated tail costs
 * only the newest records, which the live fold owns anyway, so failed frames are
 * skipped rather than failing the transcript.
 */
export declare function zstdDecodeAll(buf: Buffer): string;
/**
 * Fold every billed model call in one decoded transcript into `doc`. Records
 * without a provider route are skipped: the live fold cannot attribute them
 * either, and inventing a bucket would only distort the totals.
 *
 * A seeded subagent's transcript opens with a verbatim copy of its parent's
 * assistant messages (same message id, time and usage), so a replay that folds
 * every file double-counts them. `seen` carries the message ids of the whole
 * run: the first copy folds, later ones are reported to `onDuplicate` and
 * dropped. Pass the same set for every transcript of one pass.
 */
export declare function foldTranscript(text: string, doc: UsageLedgerDocument, seen?: Set<string>, onDuplicate?: (dayKey: string, provider: string, model: string, totals: UsageTokenTotals) => void): void;
/** Every transcript path under `<dshHome>/sessions`, two directory levels deep. */
export declare function listSessionLogs(root: string): Promise<string[]>;
/**
 * Replay the session transcripts into a fresh ledger-shaped document and hand it
 * to `merge`. Returns how many transcripts actually contributed, and how many
 * records were dropped as copies of a call another transcript already carried.
 */
export declare function collectSessionLogUsage(root: string, merge: (doc: UsageLedgerDocument) => void, onDuplicate?: (dayKey: string, provider: string, model: string, totals: UsageTokenTotals) => void): Promise<{
    files: number;
    replayed: number;
    duplicates: number;
}>;
