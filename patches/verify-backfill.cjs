#!/usr/bin/env node
/**
 * Compare dsh-usage's ledger (what the Usage panel shows) against the real
 * totals re-derived from the session transcripts on disk.
 *
 * Run:  node patches/verify-backfill.cjs     (from the dsh-usage project root)
 *
 * "TRUE" is the ground truth (every assistant/message with a usage record in
 * every session transcript). "LEDGER" is what the plugin persisted. After the
 * patched plugin has started once on a restarted host, the two should agree
 * per (day, provider) because the plugin max-merges the transcript replay in.
 */
const z = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME, ".dsh");
const SESSIONS = path.join(DSH_HOME, "sessions");
const LEDGER = path.join(DSH_HOME, "dsh-usage", "usage-ledger.json");
const MAGIC = 0xfd2fb528;

function frameEnd(buf, start) {
  let p = start + 4;
  const fhd = buf[p++];
  const fcsFlag = fhd >> 6;
  const single = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  if (!single) p++;
  p += [0, 1, 2, 4][fhd & 3];
  p += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  for (;;) {
    if (p + 3 > buf.length) return -1;
    const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    p += ((bh >> 1) & 3) === 1 ? 1 : bh >>> 3;
    if (bh & 1) break;
  }
  if (checksum) p += 4;
  return p;
}

function decode(file) {
  const buf = fs.readFileSync(file);
  let pos = 0;
  let text = "";
  while (pos + 4 <= buf.length) {
    if (buf.readUInt32LE(pos) !== MAGIC) {
      const next = buf.indexOf(Buffer.from([40, 181, 47, 253]), pos + 1);
      if (next === -1) break;
      pos = next;
    }
    const end = frameEnd(buf, pos);
    if (end === -1) break;
    try {
      text += z.zstdDecompressSync(buf.subarray(pos, end)).toString("utf8");
    } catch {}
    pos = end;
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const total = (t) => t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens;
const M = (n) => (n / 1e6).toFixed(2) + "M";

const truth = {};
let files = 0;
if (fs.existsSync(SESSIONS)) {
  for (const ws of fs.readdirSync(SESSIONS)) {
    const wsDir = path.join(SESSIONS, ws);
    if (!fs.statSync(wsDir).isDirectory()) continue;
    for (const sid of fs.readdirSync(wsDir)) {
      const dir = path.join(wsDir, sid);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!/^session\..*\.jsonl\.zstd$/.test(name)) continue;
        files++;
        for (const rec of decode(path.join(dir, name))) {
          if (rec.type !== "assistant/message") continue;
          const usage = rec.data && rec.data.usage;
          const src = rec.data && rec.data.message && rec.data.message.source;
          if (!usage || !src || !src.provider) continue;
          const key = dayKey(typeof rec.time === "number" ? rec.time : Date.parse(rec.time)) + " | " + src.provider;
          const a = (truth[key] ??= { calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 });
          a.calls++;
          a.inputTokens += usage.inputTokens || 0;
          a.cacheReadTokens += usage.cacheReadTokens || 0;
          a.cacheWriteTokens += usage.cacheWriteTokens || 0;
          a.outputTokens += usage.outputTokens || 0;
          a.reasoningTokens += usage.reasoningTokens || 0;
        }
      }
    }
  }
}

const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : { days: {} };
const seen = {};
for (const [day, providers] of Object.entries(ledger.days || {})) {
  for (const [provider, models] of Object.entries(providers)) {
    const key = day + " | " + provider;
    const a = (seen[key] ??= { calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 });
    for (const t of Object.values(models)) {
      a.calls += t.calls || 0;
      a.inputTokens += t.inputTokens || 0;
      a.cacheReadTokens += t.cacheReadTokens || 0;
      a.cacheWriteTokens += t.cacheWriteTokens || 0;
      a.outputTokens += t.outputTokens || 0;
      a.reasoningTokens += t.reasoningTokens || 0;
    }
  }
}

console.log(`transcripts: ${files}   ledger: ${LEDGER}`);
console.log("");
console.log("day        | provider  |  TRUE calls/tokens | LEDGER calls/tokens | cover");
console.log("-----------|-----------|--------------------|---------------------|------");
const keys = [...new Set([...Object.keys(truth), ...Object.keys(seen)])].sort();
let tAll = 0;
let lAll = 0;
for (const key of keys) {
  const t = truth[key];
  const l = seen[key];
  const tTok = t ? total(t) : 0;
  const lTok = l ? total(l) : 0;
  tAll += tTok;
  lAll += lTok;
  const cover = tTok === 0 ? "-" : ((lTok / tTok) * 100).toFixed(0) + "%";
  console.log(
    key.padEnd(26) + "| " + String(t ? t.calls : 0).padStart(5) + " " + M(tTok).padStart(8) + " | " +
      String(l ? l.calls : 0).padStart(5) + " " + M(lTok).padStart(8) + " | " + cover.padStart(4),
  );
}
console.log("");
console.log(`TOTAL true ${M(tAll)}   ledger ${M(lAll)}   coverage ${tAll === 0 ? "-" : ((lAll / tAll) * 100).toFixed(1) + "%"}`);
