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

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { createLedgerDocument, foldUsage, localDateKey } from '../core/ledger.ts'
import type { UsageLedgerDocument, UsageTokenTotals } from '../core/types.ts'

/** zstd frame magic number, little-endian. */
const ZSTD_MAGIC_BYTES = Buffer.from([40, 181, 47, 253])
/** Frame-content-size field width in bytes, indexed by its 2-bit flag. */
const ZSTD_FCS_BYTES = [0, 2, 4, 8]
/** Dictionary-id field width in bytes, indexed by its 2-bit flag. */
const ZSTD_DICT_ID_BYTES = [0, 1, 2, 4]
/** Transcript file name; the version segment is accepted forward-compatibly. */
const SESSION_LOG_PATTERN = /^session\.[^/\\]+\.jsonl\.zstd$/
/** A transcript larger than this is skipped: a runaway log must not stall startup. */
const SESSION_LOG_MAX_BYTES = 256 * 1024 * 1024
/** The backfill replays at most this many transcripts per start. */
const SESSION_LOG_MAX_FILES = 2048

/**
 * Offset just past the zstd frame that starts at `start`, or -1 when the frame
 * header or any of its blocks runs past the end of `buf`.
 */
export function zstdFrameEnd(buf: Buffer, start: number): number {
  let pos = start + 4
  if (pos >= buf.length) return -1
  const descriptor = buf[pos]!
  pos += 1
  const fcsFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const checksum = (descriptor >> 2) & 1
  const dictIdFlag = descriptor & 3
  if (singleSegment === 0) pos += 1
  pos += ZSTD_DICT_ID_BYTES[dictIdFlag]!
  pos += fcsFlag === 0 ? (singleSegment === 1 ? 1 : 0) : ZSTD_FCS_BYTES[fcsFlag]!
  while (pos + 3 <= buf.length) {
    const header = buf[pos]! | (buf[pos + 1]! << 8) | (buf[pos + 2]! << 16)
    const last = header & 1
    const type = (header >> 1) & 3
    pos += 3
    // An RLE block stores one byte no matter how large its decoded size is.
    pos += type === 1 ? 1 : header >>> 3
    if (pos > buf.length) return -1
    if (last === 1) {
      if (checksum === 1) pos += 4
      return pos > buf.length ? -1 : pos
    }
  }
  return -1
}

/**
 * Decode every zstd frame in `buf` into one UTF-8 string. A truncated tail costs
 * only the newest records, which the live fold owns anyway, so failed frames are
 * skipped rather than failing the transcript.
 */
export function zstdDecodeAll(buf: Buffer): string {
  const chunks: Buffer[] = []
  let pos = 0
  while (pos + 4 <= buf.length) {
    if (buf.indexOf(ZSTD_MAGIC_BYTES, pos) !== pos) {
      const next = buf.indexOf(ZSTD_MAGIC_BYTES, pos + 1)
      if (next === -1) break
      pos = next
    }
    const end = zstdFrameEnd(buf, pos)
    if (end === -1) break
    try {
      chunks.push(zstdDecompressSync(buf.subarray(pos, end)))
    } catch {
      // A corrupt frame costs its own records only.
    }
    pos = end
  }
  return chunks.length === 0 ? '' : Buffer.concat(chunks).toString('utf8')
}

/** Normalize an untrusted transcript `usage` object into ledger totals for one call. */
function transcriptTotals(usage: Record<string, unknown>): UsageTokenTotals {
  const read = (key: string): number => {
    const value = usage[key]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  }
  return {
    inputTokens: read('inputTokens'),
    outputTokens: read('outputTokens'),
    cacheReadTokens: read('cacheReadTokens'),
    cacheWriteTokens: read('cacheWriteTokens'),
    reasoningTokens: read('reasoningTokens'),
    calls: 1,
    cost: 0,
  }
}

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
export function foldTranscript(
  text: string,
  doc: UsageLedgerDocument,
  seen?: Set<string>,
  onDuplicate?: (dayKey: string, provider: string, model: string, totals: UsageTokenTotals) => void,
): void {
  /** Keys already met inside this file, so a no-id record still folds once. */
  const local = new Set<string>()
  for (const line of text.split('\n')) {
    if (line === '' || line[0] !== '{') continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const rec = record as {
      type?: unknown
      time?: unknown
      data?: { usage?: unknown; message?: { id?: unknown; source?: { provider?: unknown; model?: unknown } } }
    }
    if (rec?.type !== 'assistant/message') continue
    const usage = rec.data?.usage
    if (typeof usage !== 'object' || usage === null) continue
    const source = rec.data?.message?.source
    if (typeof source?.provider !== 'string' || source.provider === '') continue
    const model = typeof source.model === 'string' && source.model !== '' ? source.model : 'unknown'
    const atMs = typeof rec.time === 'number' && Number.isFinite(rec.time) ? rec.time : Date.now()
    const totals = transcriptTotals(usage as Record<string, unknown>)
    const id = rec.data?.message?.id
    if (seen !== undefined) {
      // The route is part of the key: one id replayed under a different
      // provider is a different call, not a copy of the first one.
      const key = typeof id === 'string' && id !== ''
        ? source.provider + '\u0000' + model + '\u0000' + id
        // A copy is a verbatim record, so its whole content identifies it: the
        // same route at the same millisecond with the same four counters. Only
        // a repeat from *another* file counts — two calls inside one session can
        // legitimately look alike, while a seeded subagent's opening records are
        // byte-for-byte the parent's.
        : 'c\u0000' + [
          source.provider,
          model,
          String(atMs),
          String(totals.inputTokens),
          String(totals.outputTokens),
          String(totals.cacheReadTokens),
          String(totals.cacheWriteTokens),
        ].join('\u0000')
      const fromThisFile = local.has(key)
      if (seen.has(key) && (typeof id === 'string' && id !== '' || !fromThisFile)) {
        onDuplicate?.(localDateKey(atMs), source.provider, model, totals)
        continue
      }
      seen.add(key)
      local.add(key)
    }
    foldUsage(doc, atMs, source.provider, model, totals)
  }
}

/** Every transcript path under `<dshHome>/sessions`, two directory levels deep. */
async function discoverSessionLogs(root: string): Promise<string[]> {
  const files: string[] = []
  let workspaces
  try {
    workspaces = await readdir(root, { withFileTypes: true })
  } catch {
    return files
  }
  for (const workspace of workspaces) {
    if (workspace.isDirectory() !== true) continue
    let sessions
    try {
      sessions = await readdir(join(root, workspace.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (session.isDirectory() !== true) continue
      const dir = join(root, workspace.name, session.name)
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isFile() === true && SESSION_LOG_PATTERN.test(entry.name)) files.push(join(dir, entry.name))
      }
    }
  }
  return files
}

/**
 * Every transcript path under `<dshHome>/sessions`, newest first.
 *
 * The order matters when the per-start cap bites: the transcripts that are
 * dropped are the oldest ones, whose calls the live fold and the earlier days
 * of the ledger already hold, not the session the user is working in right now.
 */
export async function listSessionLogs(root: string): Promise<string[]> {
  const discovered = await discoverSessionLogs(root)
  const stamped = await Promise.all(
    discovered.map(async (path) => ({ path, mtime: await stat(path).then((info) => info.mtimeMs, () => 0) })),
  )
  stamped.sort((a, b) => b.mtime - a.mtime)
  return stamped.map((entry) => entry.path)
}

/**
 * Replay the session transcripts into a fresh ledger-shaped document and hand it
 * to `merge`. Returns how many transcripts were found and how many actually
 * contributed, how many records were dropped as copies of a call another
 * transcript already carried, and how many transcripts the per-start cap left
 * out (so a truncated replay is never mistaken for a complete one).
 */
export async function collectSessionLogUsage(
  root: string,
  merge: (doc: UsageLedgerDocument) => void,
  onDuplicate?: (dayKey: string, provider: string, model: string, totals: UsageTokenTotals) => void,
): Promise<{ files: number; replayed: number; duplicates: number; skipped: number }> {
  const discovered = await listSessionLogs(root)
  const files = discovered.slice(0, SESSION_LOG_MAX_FILES)
  const doc = createLedgerDocument()
  const seen = new Set<string>()
  let replayed = 0
  let duplicates = 0
  const reportDuplicate = (dayKey: string, provider: string, model: string, totals: UsageTokenTotals): void => {
    duplicates += 1
    onDuplicate?.(dayKey, provider, model, totals)
  }
  for (const file of files) {
    try {
      const info = await stat(file)
      if (!info.isFile() || info.size <= 0 || info.size > SESSION_LOG_MAX_BYTES) continue
      const text = zstdDecodeAll(await readFile(file))
      if (text === '') continue
      foldTranscript(text, doc, seen, reportDuplicate)
      replayed += 1
    } catch {
      // Unreadable transcript: its records are lost, the rest of the run is not.
    }
  }
  merge(doc)
  return { files: discovered.length, replayed, duplicates, skipped: discovered.length - files.length }
}
