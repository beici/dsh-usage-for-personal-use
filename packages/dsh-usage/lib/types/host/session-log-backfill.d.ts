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
 * walk below is required, not defensive.
 * @module @linxin666/dsh-usage/host/session-log-backfill
 */
import type { UsageLedgerDocument } from '../core/types.ts';
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
 */
export declare function foldTranscript(text: string, doc: UsageLedgerDocument): void;
/** Every transcript path under `<dshHome>/sessions`, two directory levels deep. */
export declare function listSessionLogs(root: string): Promise<string[]>;
/**
 * Replay the session transcripts into a fresh ledger-shaped document and hand it
 * to `merge`. Returns how many transcripts actually contributed.
 */
export declare function collectSessionLogUsage(root: string, merge: (doc: UsageLedgerDocument) => void): Promise<{
    files: number;
    replayed: number;
}>;
