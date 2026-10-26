#!/usr/bin/env node
/**
 * Host-side tests for the multi-device ledger layout and the transcript
 * backfill — the two behaviours a render test cannot reach.
 *
 * Runs the TypeScript sources directly (Node's type stripping), against a
 * throwaway DSH_HOME, so it exercises exactly what the plugin builds from
 * rather than a re-implementation.
 *
 * Run:  node --experimental-strip-types harness/host-test.mjs
 */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '..', 'packages', 'dsh-usage', 'src')
const load = (rel) => import(pathToFileURL(join(SRC, rel)).href)

const report = []
function check(name, ok, detail) {
  report.push({ name, ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail))
}

/** A host context that resolves no services: probes and route wiring are inert here. */
const ctxStub = {
  on: () => () => {},
  effect: () => () => {},
  get: () => undefined,
  service: () => undefined,
  emit: () => {},
  webServer: { register: () => () => {} },
}

/** Fresh DSH_HOME; returns its path with the persist dir created. */
async function freshHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-usage-test-'))
  process.env.DSH_HOME = home
  await mkdir(join(home, 'dsh-usage'), { recursive: true })
  return home
}

/** One `assistant/message` transcript record for a billed call. */
function messageRecord(provider, model, input, atMs = new Date('2026-10-18T10:00:00').getTime()) {
  return JSON.stringify({
    type: 'assistant/message',
    time: atMs,
    data: {
      usage: { inputTokens: input, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      message: { source: { provider, model } },
    },
  })
}

/** Write one multi-frame transcript under `<home>/sessions/<ws>/<session>/`. */
async function writeTranscript(home, lines, session = 'sess1') {
  const dir = join(home, 'sessions', 'ws1', session)
  await mkdir(dir, { recursive: true })
  // Two frames: a transcript is a concatenation of per-append zstd frames.
  const half = Math.ceil(lines.length / 2)
  const frames = [
    zstdCompressSync(Buffer.from(lines.slice(0, half).join('\n') + '\n')),
    zstdCompressSync(Buffer.from(lines.slice(half).join('\n') + '\n')),
  ]
  const file = join(dir, 'session.v4.jsonl.zstd')
  await writeFile(file, Buffer.concat(frames))
  return file
}

// ---- device ids ---------------------------------------------------------
{
  const { localDeviceId, ledgerFileName, deviceIdOfFile, isDeviceId, parsePeerLedger } = await load('host/device-ledger.ts')
  const id = localDeviceId()
  check('localDeviceId is a valid id', isDeviceId(id), id)
  check('file name round-trips', deviceIdOfFile(ledgerFileName(id)) === id)
  check('legacy file is not a device file', deviceIdOfFile('usage-ledger.json') === undefined)
  check('migrated marker is not a device file', deviceIdOfFile('usage-ledger.json.migrated') === undefined)
  check('unrelated json is not a device file', deviceIdOfFile('usage-ledger.json.bak') === undefined)
  check('path traversal ids rejected', !isDeviceId('../etc') && !isDeviceId('..') && !isDeviceId('a/b'))
  check('leading/trailing punctuation rejected', !isDeviceId('-lead') && !isDeviceId('trail-'))
  check('empty id rejected', !isDeviceId(''))
  check('overlong id rejected', !isDeviceId('a'.repeat(65)))

  const envelope = { deviceId: 'laptop-4f7b21', ledger: { version: 1, days: { '2026-10-20': { buddy: { m1: { inputTokens: 1, outputTokens: 1, calls: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0 } } } } } }
  const parsed = parsePeerLedger(envelope)
  check('export envelope parses', parsed?.deviceId === 'laptop-4f7b21' && Object.keys(parsed.doc.days).length === 1)
  check('bare document parses', parsePeerLedger({ version: 1, days: {} }) !== undefined)
  for (const [label, bad] of [
    ['null', null],
    ['string', 'nope'],
    ['number', 7],
    ['no days', { deviceId: 'ok-id' }],
    ['non-object ledger', { deviceId: 'ok-id', ledger: 'nope' }],
    ['bad id', { deviceId: '../etc', days: {} }],
    ['array days', { days: [] }],
  ]) {
    check('rejects ' + label, parsePeerLedger(bad) === undefined)
  }
}

// ---- service: export / import / sum -------------------------------------
{
  const home = await freshHome()
  const { UsageService, UsageImportError } = await load('host/usage-service.ts')
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  // The dedupe marker is a sidecar, not a ledger: only ledger files matter here.
  const sidecars = new Set(['usage-dedupe-marker.json', 'machine-id.json'])
  const ledgerFiles = async () => (await readdir(join(home, 'dsh-usage'))).filter((name) => !sidecars.has(name))
  check('starts with one local file', (await ledgerFiles()).length === 0, 'no file before a fold')

  // The overview's `today` follows the wall clock, so this section folds into
  // the real today key — a fixed date went stale the day after it was written.
  const { createLedgerDocument, foldUsage, localDateKey } = await load('core/ledger.ts')
  const todayKey = localDateKey(Date.now())
  svc.ledger = createLedgerDocument()
  foldUsage(svc.ledger, new Date(todayKey + 'T12:00:00').getTime(), 'buddy', 'm1', { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 2, cost: 0 })
  await svc.flushLedger()
  check('flush writes only this device file', JSON.stringify((await ledgerFiles()).sort()) === JSON.stringify([`usage-ledger.${svc.device}.json`]), (await ledgerFiles()).join(','))

  const exported = svc.exportLedger()
  check('export carries the schema', exported.schema === 'dsh-usage-ledger' && exported.version === 1)
  check('export carries own device id', exported.deviceId === svc.device)

  const peer = {
    schema: 'dsh-usage-ledger',
    version: 1,
    deviceId: 'laptop-4f7b21',
    machine: 'machine-laptop',
    exportedAt: new Date().toISOString(),
    ledger: { version: 1, days: { [todayKey]: { buddy: { m1: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 1, cost: 0 } } } } },
  }
  check('import installs the peer file', (await svc.importPeer(JSON.stringify(peer))).deviceId === 'laptop-4f7b21')
  check('peer file named by its device id', (await readdir(join(home, 'dsh-usage'))).includes('usage-ledger.laptop-4f7b21.json'))

  const summed = svc.overview().usage.today.totals
  check('overview sums peer into local', summed.calls === 3 && summed.inputTokens === 1500, `calls=${summed.calls} input=${summed.inputTokens}`)
  check('overview lists both devices', JSON.stringify(svc.overview().usage.devices) === JSON.stringify([{ deviceId: svc.device, role: 'local' }, { deviceId: 'laptop-4f7b21', role: 'peer' }]))

  // The whole point: the same file arriving twice must not double the totals.
  await svc.importPeer(JSON.stringify(peer))
  const again = svc.overview().usage.today.totals
  check('re-import is idempotent', again.calls === 3 && again.inputTokens === 1500, `calls=${again.calls} input=${again.inputTokens}`)

  // The local ledger itself must never absorb peer numbers.
  check('local ledger untouched by peers', svc.ledger.days[todayKey].buddy.m1.calls === 2, String(svc.ledger.days[todayKey].buddy.m1.calls))
  // ... and flushing after an import must not write the peer's numbers into it.
  await svc.flushLedger()
  const persisted = JSON.parse(await readFile(join(home, 'dsh-usage', `usage-ledger.${svc.device}.json`), 'utf8'))
  check('flush never persists merged totals', persisted.days[todayKey].buddy.m1.calls === 2, String(persisted.days[todayKey].buddy.m1.calls))

  // Self-import is a mistake worth naming, not a silent no-op.
  try {
    await svc.importPeer(JSON.stringify(exported))
    check('self-import refused', false)
  } catch (error) {
    check('self-import refused', error instanceof UsageImportError, error.message)
  }
  for (const [label, payload] of [
    ['empty body', ''],
    ['non-JSON', 'not json'],
    ['bare object', '{}'],
    ['traversal id', '{"deviceId":"../etc","days":{}}'],
    ['unreadable ledger', '{"deviceId":"ok-id","ledger":"nope"}'],
  ]) {
    let message = 'accepted'
    try {
      await svc.importPeer(payload)
    } catch (error) {
      message = error instanceof UsageImportError ? 'refused' : 'other error: ' + error.message
    }
    check('import refuses ' + label, message === 'refused', message)
  }
}

// ---- legacy single-file migration ---------------------------------------
{
  const home = await freshHome()
  const legacy = JSON.stringify({ version: 1, days: { '2026-10-19': { workbuddy: { m9: { inputTokens: 700, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 7, cost: 0 } } } } })
  await writeFile(join(home, 'dsh-usage', 'usage-ledger.json'), legacy)
  const { UsageService } = await load('host/usage-service.ts')
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  const names = (await readdir(join(home, 'dsh-usage'))).sort()
  check('legacy file retired', names.includes('usage-ledger.json.migrated') && !names.includes('usage-ledger.json'), names.join(','))
  check('legacy history adopted', svc.overview().usage.days.find((d) => d.date === '2026-10-19')?.totals.calls === 7)
  // The old file must be written to the device file BEFORE it is renamed away.
  const migrated = JSON.parse(await readFile(join(home, 'dsh-usage', `usage-ledger.${svc.device}.json`), 'utf8'))
  check('migration persists before renaming', migrated.days['2026-10-19'].workbuddy.m9.calls === 7)
}

// ---- corrupt legacy file stays put --------------------------------------
{
  const home = await freshHome()
  await writeFile(join(home, 'dsh-usage', 'usage-ledger.json'), '{ not json')
  const { UsageService } = await load('host/usage-service.ts')
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  check('corrupt legacy left in place', (await readdir(join(home, 'dsh-usage'))).includes('usage-ledger.json'))
}

// ---- transcript backfill ------------------------------------------------
{
  await freshHome()
  const { zstdFrameEnd, zstdDecodeAll, collectSessionLogUsage } = await load('host/session-log-backfill.ts')
  const home = await freshHome()
  const file = await writeTranscript(home, [
    messageRecord('buddy', 'm1', 100),
    messageRecord('buddy', 'm1', 100),
    messageRecord('workbuddy', 'm2', 300),
    JSON.stringify({ type: 'tool/call', time: 1, data: {} }),
    'not json at all',
    JSON.stringify({ type: 'assistant/message', time: 1, data: { message: { source: { provider: 'x', model: 'y' } } } }),
    JSON.stringify({ type: 'assistant/message', time: 1, data: { usage: { inputTokens: 9 } } }),
  ])
  const raw = await readFile(file)
  const firstEnd = zstdFrameEnd(raw, 0)
  check('frame walk finds frame 1', firstEnd > 0 && firstEnd < raw.length, String(firstEnd))
  check('frame walk finds frame 2', zstdFrameEnd(raw, firstEnd) === raw.length)
  check('all frames decode', zstdDecodeAll(raw).includes('workbuddy'))

  let doc
  const result = await collectSessionLogUsage(join(home, 'sessions'), (replayed) => { doc = replayed })
  check('backfill reports the transcript', result.files === 1 && result.replayed === 1, JSON.stringify(result))
  const day = doc.days['2026-10-18']
  check('two calls folded for buddy', day.buddy.m1.calls === 2 && day.buddy.m1.inputTokens === 200, `${day.buddy.m1.calls}/${day.buddy.m1.inputTokens}`)
  check('one call folded for workbuddy', day.workbuddy.m2.calls === 1 && day.workbuddy.m2.inputTokens === 300, `${day.workbuddy.m2.calls}/${day.workbuddy.m2.inputTokens}`)
  check('unattributed records skipped', Object.keys(day).length === 2, Object.keys(day).join(','))
}

// ---- startup picks the backfill up, once --------------------------------
{
  const home = await freshHome()
  await writeTranscript(home, [messageRecord('buddy', 'mm', 55, new Date('2026-10-17T09:00:00').getTime())])
  const { UsageService } = await load('host/usage-service.ts')
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 30 })
  await svc.loadPersisted()
  const day = svc.overview().usage.days.find((d) => d.date === '2026-10-17')
  check('startup backfills pre-mount calls', day?.totals.calls === 1 && day?.totals.inputTokens === 55, `${day?.totals.calls}/${day?.totals.inputTokens}`)

  const second = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 30 })
  await second.loadPersisted()
  const again = second.overview().usage.days.find((d) => d.date === '2026-10-17')
  check('backfill is idempotent across restarts', again?.totals.calls === 1, String(again?.totals.calls))
}

// ---- seeded subagent transcripts are deduped ----------------------------
// A seeded subagent's transcript opens with a verbatim copy of its parent's
// assistant messages: same id, same time, same usage. Folding every file twice
// inflated yesterday by 17% on the real ledger, and the max-merge rule meant the
// inflated buckets could never come back down.
{
  const home = await freshHome()
  const at = new Date('2026-10-16T09:00:00').getTime()
  const call = (id, input) => JSON.stringify({
    type: 'assistant/message',
    time: at,
    data: {
      usage: { inputTokens: input, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      message: { id, source: { provider: 'buddy', model: 'm1' } },
    },
  })
  await writeTranscript(home, [call('msg-1', 100)], 'parent')
  await writeTranscript(home, [call('msg-1', 100), call('msg-2', 300)], 'child')

  const { collectSessionLogUsage } = await load('host/session-log-backfill.ts')
  let doc
  const duplicates = []
  const result = await collectSessionLogUsage(
    join(home, 'sessions'),
    (replayed) => { doc = replayed },
    (dayKey, provider, model, totals) => duplicates.push([dayKey, provider, model, totals.inputTokens]),
  )
  const bucket = doc.days['2026-10-16']?.buddy?.m1
  check('a copied call is counted once', bucket?.calls === 2 && bucket?.inputTokens === 400, `${bucket?.calls}/${bucket?.inputTokens}`)
  check('the extra copy is reported', result.duplicates === 1 && duplicates.length === 1 && duplicates[0][3] === 100, JSON.stringify(duplicates))

  // Records without an id cannot be told apart and must still fold: the older
  // single-session transcript has no ids at all.
  const plain = await freshHome()
  await writeTranscript(plain, [messageRecord('buddy', 'm1', 100), messageRecord('buddy', 'm1', 100)])
  let plainDoc
  await collectSessionLogUsage(join(plain, 'sessions'), (replayed) => { plainDoc = replayed })
  check('id-less records still fold', plainDoc.days['2026-10-18']?.buddy?.m1?.calls === 2, JSON.stringify(plainDoc.days).slice(0, 160))

  // The id alone is not a copy: the same request replayed under another route is
  // a different call and must keep its own bucket.
  const routed = await freshHome()
  await writeTranscript(routed, [
    JSON.stringify({ type: 'assistant/message', time: at, data: { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { id: 'msg-7', source: { provider: 'buddy', model: 'm1' } } } }),
    JSON.stringify({ type: 'assistant/message', time: at, data: { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { id: 'msg-7', source: { provider: 'other', model: 'm1' } } } }),
  ], 'routed')
  let routedDoc
  await collectSessionLogUsage(join(routed, 'sessions'), (replayed) => { routedDoc = replayed })
  check('the same id under another route still folds', routedDoc.days['2026-10-16']?.buddy?.m1?.calls === 1 && routedDoc.days['2026-10-16']?.other?.m1?.calls === 1, JSON.stringify(routedDoc.days).slice(0, 200))
}

// ---- the duplicate repair subtracts once and stays idempotent -----------
{
  const home = await freshHome()
  const at = new Date('2026-10-16T09:00:00').getTime()
  const call = (id, input) => JSON.stringify({
    type: 'assistant/message',
    time: at,
    data: {
      usage: { inputTokens: input, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      message: { id, source: { provider: 'buddy', model: 'm1' } },
    },
  })
  await writeTranscript(home, [call('msg-1', 100)], 'parent')
  await writeTranscript(home, [call('msg-1', 100), call('msg-2', 300)], 'child')
  // The ledger as the old replay left it: the copy folded in a third time.
  const { localDeviceId } = await load('host/device-ledger.ts')
  const inflated = {
    version: 1,
    days: { '2026-10-16': { buddy: { m1: { inputTokens: 500, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 3, cost: 0 } } } },
  }
  await writeFile(join(home, 'dsh-usage', `usage-ledger.${localDeviceId()}.json`), JSON.stringify(inflated))

  const { UsageService } = await load('host/usage-service.ts')
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  const day = svc.overview().usage.days.find((row) => row.date === '2026-10-16')
  check('the repair subtracts the extra copy', day?.totals.calls === 2 && day?.totals.inputTokens === 400, `${day?.totals.calls}/${day?.totals.inputTokens}`)
  check('the repair leaves a marker', (await readdir(join(home, 'dsh-usage'))).includes('usage-dedupe-marker.json'))
  await svc.stop()

  const second = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await second.loadPersisted()
  const again = second.overview().usage.days.find((row) => row.date === '2026-10-16')
  check('a second start does not subtract again', again?.totals.calls === 2 && again?.totals.inputTokens === 400, `${again?.totals.calls}/${again?.totals.inputTokens}`)
  await second.stop()

  // A ledger restored from a backup is inflated again while the marker is still
  // there. The marker is a record, not a gate: the next start judges the buckets
  // again and corrects them, instead of trusting a claim about a file that has
  // since been replaced.
  await writeFile(join(home, 'dsh-usage', `usage-ledger.${localDeviceId()}.json`), JSON.stringify(inflated))
  const third = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await third.loadPersisted()
  const restored = third.overview().usage.days.find((row) => row.date === '2026-10-16')
  check('a ledger restored from a backup is corrected again',
    restored?.totals.calls === 2 && restored?.totals.inputTokens === 400,
    `${restored?.totals.calls}/${restored?.totals.inputTokens}`)
  await third.stop()
}

// ---- the repair never takes real calls away -----------------------------
// The copies were only ever written into buckets the old replay inflated: a
// bucket at or below what the deduped replay bills cannot hold one, and taking
// its calls away is the one mistake no later merge can undo.
{
  const home = await freshHome()
  const at = new Date('2026-10-16T09:00:00').getTime()
  const call = (id, input) => JSON.stringify({
    type: 'assistant/message',
    time: at,
    data: {
      usage: { inputTokens: input, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      message: { id, source: { provider: 'buddy', model: 'm1' } },
    },
  })
  await writeTranscript(home, [call('msg-1', 100)], 'parent')
  await writeTranscript(home, [call('msg-1', 100), call('msg-2', 300)], 'child')
  // The file holds only the two real calls: the copy never reached this bucket.
  const { localDeviceId } = await load('host/device-ledger.ts')
  const honest = {
    version: 1,
    days: { '2026-10-16': { buddy: { m1: { inputTokens: 400, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 2, cost: 0 } } } },
  }
  await writeFile(join(home, 'dsh-usage', `usage-ledger.${localDeviceId()}.json`), JSON.stringify(honest))
  const { UsageService } = await load('host/usage-service.ts')
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  const day = svc.overview().usage.days.find((row) => row.date === '2026-10-16')
  check('a bucket the copy never reached keeps its calls', day?.totals.calls === 2 && day?.totals.inputTokens === 400, `${day?.totals.calls}/${day?.totals.inputTokens}`)
  // Nothing was taken away, so nothing is claimed: the marker records what the
  // repair did, and an empty record would only mislead a later reader.
  check('the repair claims nothing when it takes nothing away', !(await readdir(join(home, 'dsh-usage'))).includes('usage-dedupe-marker.json'))
  await svc.stop()
}

// ---- a bucket the repair cannot explain is left alone -------------------
// The day holds the copy AND two real calls the replay cannot see (a transcript
// rotated away), so the bucket sits three calls above the deduped replay when
// only one of them is a copy. Nothing distinguishes the copy from those calls,
// and taking real usage away is the one mistake no later merge can undo: the
// bucket stays exactly as it is, on every start, and no floor is claimed.
{
  const home = await freshHome()
  const at = new Date('2026-10-16T09:00:00').getTime()
  const call = (id, input) => JSON.stringify({
    type: 'assistant/message',
    time: at,
    data: {
      usage: { inputTokens: input, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      message: { id, source: { provider: 'buddy', model: 'm1' } },
    },
  })
  await writeTranscript(home, [call('msg-1', 100)], 'parent')
  await writeTranscript(home, [call('msg-1', 100), call('msg-2', 300)], 'child')
  const { localDeviceId } = await load('host/device-ledger.ts')
  const ledgerPath = join(home, 'dsh-usage', `usage-ledger.${localDeviceId()}.json`)
  const bucket = (input, output, calls) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  // clean 400/20 over 2 calls + copy 100/10 + two real calls 200/20.
  await writeFile(ledgerPath, JSON.stringify({ version: 1, days: { '2026-10-16': { buddy: { m1: bucket(700, 50, 5) } } } }))

  const { UsageService } = await load('host/usage-service.ts')
  const first = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await first.loadPersisted()
  check('an ambiguous bucket is left alone', first.ledger.days['2026-10-16']?.buddy?.m1?.inputTokens === 700, String(first.ledger.days['2026-10-16']?.buddy?.m1?.inputTokens))
  check('an ambiguous bucket claims no floor', !(await readdir(join(home, 'dsh-usage'))).includes('usage-dedupe-marker.json'))
  await first.stop()
  const second = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await second.loadPersisted()
  check('a second start leaves the ambiguous bucket alone too', second.ledger.days['2026-10-16']?.buddy?.m1?.inputTokens === 700 && second.ledger.days['2026-10-16']?.buddy?.m1?.calls === 5,
    `${second.ledger.days['2026-10-16']?.buddy?.m1?.calls}/${second.ledger.days['2026-10-16']?.buddy?.m1?.inputTokens}`)
  await second.stop()
}

// ---- floors from an earlier start survive a later repair ----------------
// Start 1 corrects day A and records its floor. Start 2 corrects day C — if the
// marker were replaced wholesale, A's floor would be gone and start 3 would take
// another copy out of A, eating the calls the replay cannot see.
{
  const home = await freshHome()
  const atA = new Date('2026-10-16T09:00:00').getTime()
  const atC = new Date('2026-10-17T09:00:00').getTime()
  const call = (at, id, input) => JSON.stringify({
    type: 'assistant/message',
    time: at,
    data: {
      usage: { inputTokens: input, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      message: { id, source: { provider: 'buddy', model: 'm1' } },
    },
  })
  await writeTranscript(home, [call(atA, 'msg-a', 100)], 'parent-a')
  await writeTranscript(home, [call(atA, 'msg-a', 100), call(atC, 'msg-c', 100)], 'child-a')
  await writeTranscript(home, [call(atC, 'msg-c', 100)], 'parent-c')
  const { localDeviceId } = await load('host/device-ledger.ts')
  const ledgerPath = join(home, 'dsh-usage', `usage-ledger.${localDeviceId()}.json`)
  const bucket = (input, output, calls) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  // Day A: clean 100/10 + copy 100/10. Day C is not inflated yet.
  await writeFile(ledgerPath, JSON.stringify({ version: 1, days: { '2026-10-16': { buddy: { m1: bucket(200, 20, 2) } } } }))
  const { UsageService } = await load('host/usage-service.ts')
  const first = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await first.loadPersisted()
  check('the first start corrects day A', first.ledger.days['2026-10-16']?.buddy?.m1?.inputTokens === 100, String(first.ledger.days['2026-10-16']?.buddy?.m1?.inputTokens))
  await first.stop()

  // Day C is inflated now, and day A also grew by real calls while the marker holds A's floor.
  const marker = JSON.parse(await readFile(join(home, 'dsh-usage', 'usage-dedupe-marker.json'), 'utf8'))
  check('the marker records the floor it left behind', typeof marker.after?.['2026-10-16\u0000buddy\u0000m1'] === 'object', JSON.stringify(marker.after ?? null))
  const doc = JSON.parse(await readFile(ledgerPath, 'utf8'))
  doc.days['2026-10-16'].buddy.m1 = bucket(300, 30, 3) // +100/10 real calls
  doc.days['2026-10-17'] = { buddy: { m1: bucket(200, 20, 2) } } // clean 100/10 + copy 100/10
  await writeFile(ledgerPath, JSON.stringify(doc))

  const second = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await second.loadPersisted()
  check('the later start corrects the new day', second.ledger.days['2026-10-17']?.buddy?.m1?.inputTokens === 100, String(second.ledger.days['2026-10-17']?.buddy?.m1?.inputTokens))
  check('the later start leaves the earlier floor alone', second.ledger.days['2026-10-16']?.buddy?.m1?.inputTokens === 300, String(second.ledger.days['2026-10-16']?.buddy?.m1?.inputTokens))
  await second.stop()
  const merged = JSON.parse(await readFile(join(home, 'dsh-usage', 'usage-dedupe-marker.json'), 'utf8'))
  check('the marker keeps both floors', merged.after?.['2026-10-16\u0000buddy\u0000m1'] !== undefined && merged.after?.['2026-10-17\u0000buddy\u0000m1'] !== undefined,
    JSON.stringify(Object.keys(merged.after ?? {})))
}

// ---- a bucket that grew after the repair is not subtracted again ---------
// Another process (or a restored backup) can add calls to a bucket the repair
// already corrected. Those calls are indistinguishable from a fresh copy, so the
// guard must not subtract on sight.
{
  const home = await freshHome()
  const at = new Date('2026-10-16T09:00:00').getTime()
  const call = (id, input) => JSON.stringify({
    type: 'assistant/message',
    time: at,
    data: {
      usage: { inputTokens: input, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      message: { id, source: { provider: 'buddy', model: 'm1' } },
    },
  })
  await writeTranscript(home, [call('msg-1', 100)], 'parent')
  await writeTranscript(home, [call('msg-1', 100), call('msg-2', 300)], 'child')
  const { localDeviceId } = await load('host/device-ledger.ts')
  const ledgerPath = join(home, 'dsh-usage', `usage-ledger.${localDeviceId()}.json`)
  const bucket = (input, output, calls) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  await writeFile(ledgerPath, JSON.stringify({ version: 1, days: { '2026-10-16': { buddy: { m1: bucket(500, 30, 3) } } } }))
  const { UsageService } = await load('host/usage-service.ts')
  const first = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await first.loadPersisted()
  check('the copy is taken on the first start', first.ledger.days['2026-10-16']?.buddy?.m1?.inputTokens === 400, String(first.ledger.days['2026-10-16']?.buddy?.m1?.inputTokens))
  await first.stop()

  const doc = JSON.parse(await readFile(ledgerPath, 'utf8'))
  doc.days['2026-10-16'].buddy.m1 = bucket(600, 40, 4) // +100/10 real calls
  await writeFile(ledgerPath, JSON.stringify(doc))
  const second = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await second.loadPersisted()
  check('growth after the repair is not mistaken for a copy', second.ledger.days['2026-10-16']?.buddy?.m1?.inputTokens === 600 && second.ledger.days['2026-10-16']?.buddy?.m1?.calls === 4,
    `${second.ledger.days['2026-10-16']?.buddy?.m1?.calls}/${second.ledger.days['2026-10-16']?.buddy?.m1?.inputTokens}`)
  await second.stop()
}

// ---- copies without a message id are caught by their content -------------
// Upstream does not have to write a message id. A seeded subagent's opening
// records are still byte-identical, so the whole content identifies the copy —
// but only across files: two look-alike calls inside one session are real.
{
  const home = await freshHome()
  const at = new Date('2026-10-16T09:00:00').getTime()
  const noId = (input) => JSON.stringify({
    type: 'assistant/message',
    time: at,
    data: {
      usage: { inputTokens: input, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      message: { source: { provider: 'buddy', model: 'm1' } },
    },
  })
  await writeTranscript(home, [noId(100)], 'parent')
  await writeTranscript(home, [noId(100), noId(300)], 'child')
  const { UsageService } = await load('host/usage-service.ts')
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  const day = svc.overview().usage.days.find((row) => row.date === '2026-10-16')
  check('a copy without an id is deduped across files', day?.totals.calls === 2 && day?.totals.inputTokens === 400, `${day?.totals.calls}/${day?.totals.inputTokens}`)
  await svc.stop()
}

// ---- a successful load restores the retry budget ------------------------
// The retry budget is for transient locks at startup. If it is never reset, one
// bad episode spends it and a later lock leaves the process unable to persist.
{
  const home = await freshHome()
  const { localDeviceId } = await load('host/device-ledger.ts')
  const ledgerPath = join(home, 'dsh-usage', `usage-ledger.${localDeviceId()}.json`)
  await writeFile(ledgerPath, JSON.stringify({ version: 1, days: {} }))
  const { UsageService } = await load('host/usage-service.ts')
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  svc.loadRetries = 4
  await svc.loadPersisted()
  check('a successful load resets the retry budget', svc.loadRetries === 0, String(svc.loadRetries))
  await svc.stop()
}

// ---- calls another process folds while the repair runs survive it --------
// The repair reads the file, replays ~18 s of transcripts, then writes. Anything
// another process folded into the same bucket in between is real usage, so a
// bucket the repair cannot fully explain is left alone — it is never rewritten
// down to the replay's own total.
{
  const home = await freshHome()
  const at = new Date('2026-10-16T09:00:00').getTime()
  const call = (id, input) => JSON.stringify({
    type: 'assistant/message',
    time: at,
    data: {
      usage: { inputTokens: input, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      message: { id, source: { provider: 'buddy', model: 'm1' } },
    },
  })
  await writeTranscript(home, [call('msg-1', 100)], 'parent')
  await writeTranscript(home, [call('msg-1', 100), call('msg-2', 300)], 'child')
  const { localDeviceId } = await load('host/device-ledger.ts')
  const ledgerPath = join(home, 'dsh-usage', `usage-ledger.${localDeviceId()}.json`)
  const bucket = (input, output, calls) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  await writeFile(ledgerPath, JSON.stringify({ version: 1, days: { '2026-10-16': { buddy: { m1: bucket(700, 50, 5) } } } }))
  const { UsageService } = await load('host/usage-service.ts')
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  await svc.stop()
  // Another process folded two more real calls into the same bucket afterwards.
  const grown = JSON.parse(await readFile(ledgerPath, 'utf8'))
  grown.days['2026-10-16'].buddy.m1 = bucket(900, 70, 7)
  await writeFile(ledgerPath, JSON.stringify(grown))
  const next = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await next.loadPersisted()
  check('a bucket it cannot explain keeps everything, before and after growing',
    next.ledger.days['2026-10-16']?.buddy?.m1?.inputTokens === 900 && next.ledger.days['2026-10-16']?.buddy?.m1?.calls === 7,
    `${next.ledger.days['2026-10-16']?.buddy?.m1?.calls}/${next.ledger.days['2026-10-16']?.buddy?.m1?.inputTokens}`)
  await next.stop()
}

// ---- a ledger restored from an export keeps its history ------------------
// `/export` wraps the document as `{schema, version, deviceId, exportedAt,
// ledger}`. Reading only the top-level `days` made a restored backup look like a
// valid empty ledger, and the first flush then wrote that emptiness over it.
{
  const home = await freshHome()
  const { localDeviceId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const ledgerPath = join(home, 'dsh-usage', `usage-ledger.${localDeviceId()}.json`)
  const day = { buddy: { m1: { inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 5, cost: 0 } } }
  await writeFile(ledgerPath, JSON.stringify({
    schema: 'dsh-usage-ledger', version: 1, deviceId: localDeviceId(), exportedAt: '2026-10-16T00:00:00.000Z',
    ledger: { version: 1, days: { '2026-10-16': day } },
  }))
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  check('an exported ledger is read as a ledger', svc.ledger.days['2026-10-16']?.buddy?.m1?.calls === 5, JSON.stringify(Object.keys(svc.ledger.days)))
  await svc.flushLedger()
  const persisted = JSON.parse(await readFile(ledgerPath, 'utf8'))
  check('the flush keeps the restored history', persisted.days?.['2026-10-16']?.buddy?.m1?.calls === 5, JSON.stringify(Object.keys(persisted.days ?? {})))
  await svc.stop()
}

// ---- another device's export is adopted as that device ------------------
// A restore that drops another machine's export on the local ledger path used to
// be quarantined as corrupt — the history survived on disk but vanished from the
// panel. It is that device's ledger, so it is renamed to its own file and read as
// a peer: the totals come back, and this machine's ledger stays empty rather than
// pretending the export is its own history.
{
  const home = await freshHome()
  const { localDeviceId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const ledgerPath = join(home, 'dsh-usage', `usage-ledger.${localDeviceId()}.json`)
  await writeFile(ledgerPath, JSON.stringify({
    schema: 'dsh-usage-ledger', version: 1, deviceId: 'laptop-4f7b21', machine: 'machine-laptop', exportedAt: '2026-10-16T00:00:00.000Z',
    ledger: { version: 1, days: { '2026-10-16': { buddy: { m1: { inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 5, cost: 0 } } } } },
  }))
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  const names = await readdir(join(home, 'dsh-usage'))
  check('another device\'s export is adopted under its own name',
    names.includes('usage-ledger.laptop-4f7b21.json'), names.join(','))
  check('the adopted export is not read as this machine\'s history',
    svc.ledger.days['2026-10-16'] === undefined, JSON.stringify(Object.keys(svc.ledger.days)))
  const all = svc.overview().usage.all.totals
  check('the adopted export still counts, as its own device',
    all.calls === 5 && all.inputTokens === 500, `${all.calls}/${all.inputTokens}`)
  check('the panel says where the file went',
    String(svc.overview().usage.ledgerNote ?? '').includes('laptop-4f7b21'), String(svc.overview().usage.ledgerNote))
  await svc.stop()
}

// ---- a backup copy of our own ledger is not a second device -------------
// `usage-ledger.<id>.bak.json` keeps the device prefix, so it used to be read as
// a peer and every one of this machine's calls was counted twice.
{
  const home = await freshHome()
  const { localDeviceId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const dir = join(home, 'dsh-usage')
  const todayKey = (await load('core/ledger.ts')).localDateKey(Date.now())
  const day = { buddy: { m1: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 10, cost: 0 } } }
  await writeFile(join(dir, `usage-ledger.${localDeviceId()}.json`), JSON.stringify({ version: 1, days: { [todayKey]: day } }))
  await writeFile(join(dir, `usage-ledger.${localDeviceId()}.bak.json`), JSON.stringify({ version: 1, days: { [todayKey]: day } }))
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  const totals = svc.overview().usage.all.totals
  check('a backup copy is not summed in', totals.calls === 10 && totals.inputTokens === 1000, `${totals.calls}/${totals.inputTokens}`)
  check('a backup copy is not a device', svc.overview().usage.devices.length === 1, JSON.stringify(svc.overview().usage.devices))
  await svc.stop()
}

// ---- a quarantined file is not a peer ----------------------------------
{
  const home = await freshHome()
  const { localDeviceId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const dir = join(home, 'dsh-usage')
  const todayKey = (await load('core/ledger.ts')).localDateKey(Date.now())
  const day = { buddy: { m1: { inputTokens: 700, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 7, cost: 0 } } }
  await writeFile(join(dir, `usage-ledger.${localDeviceId()}.json`), JSON.stringify({ version: 1, days: { [todayKey]: day } }))
  await writeFile(join(dir, 'usage-ledger.izuf6gqghj119maddgtu7yz-2c08fa.json.corrupt-1.json'), JSON.stringify({ version: 1, days: { [todayKey]: day } }))
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  check('a quarantined file is not a peer', svc.overview().usage.devices.length === 1 && svc.overview().usage.devicesError === undefined,
    JSON.stringify(svc.overview().usage.devices) + '/' + String(svc.overview().usage.devicesError))
  await svc.stop()
}

// ---- a peer's backup copy is not a second device -----------------------
// A peer ledger copied aside keeps the `usage-ledger.<id>.bak.json` shape. The
// dot in the name is now refused outright (a real device id never has one), and
// a document only counts as a device when it names the device it arrived as — so
// a copy is neither summed nor listed.
{
  const home = await freshHome()
  const { localDeviceId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const dir = join(home, 'dsh-usage')
  const todayKey = (await load('core/ledger.ts')).localDateKey(Date.now())
  const bucket = (input, calls) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  const day = (input, calls) => JSON.stringify({ version: 1, days: { [todayKey]: { buddy: { m1: bucket(input, calls) } } } })
  const peerDay = (input, calls) => JSON.stringify({ version: 1, deviceId: 'peerone', machine: 'another-machine', days: { [todayKey]: { buddy: { m1: bucket(input, calls) } } } })
  await writeFile(join(dir, `usage-ledger.${localDeviceId()}.json`), day(100, 1))
  await writeFile(join(dir, 'usage-ledger.peerone.json'), peerDay(700, 7))
  await writeFile(join(dir, 'usage-ledger.peerone.bak.json'), peerDay(700, 7))
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  const totals = svc.overview().usage.all.totals
  check('a peer backup copy is not summed in', totals.calls === 8 && totals.inputTokens === 800, `${totals.calls}/${totals.inputTokens}`)
  check('a peer backup copy is not a device', svc.overview().usage.devices.length === 2, JSON.stringify(svc.overview().usage.devices))
  await svc.stop()
}

// ---- a bare peer document is not trusted -------------------------------
// Without a deviceId inside it, a file proves nothing: it could be a renamed copy
// of this machine's own ledger. It is refused, and the refusal is stated.
{
  const home = await freshHome()
  const { localDeviceId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const dir = join(home, 'dsh-usage')
  const todayKey = (await load('core/ledger.ts')).localDateKey(Date.now())
  const bucket = (input, calls) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  const day = (input, calls) => JSON.stringify({ version: 1, days: { [todayKey]: { buddy: { m1: bucket(input, calls) } } } })
  await writeFile(join(dir, `usage-ledger.${localDeviceId()}.json`), day(100, 1))
  await writeFile(join(dir, 'usage-ledger.peerone.json'), day(700, 7))
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  const totals = svc.overview().usage.all.totals
  check('a bare document is not summed as a peer', totals.calls === 1 && totals.inputTokens === 100, `${totals.calls}/${totals.inputTokens}`)
  check('the refused peer is reported', String(svc.overview().usage.devicesError ?? '').includes('peerone'), String(svc.overview().usage.devicesError))
  await svc.stop()
}

// ---- a bucket the ledger spells differently is still repaired -----------
// Provider and model spellings come from two different sources. When they drift
// (`WorkBuddy` in the ledger, `workbuddy` in the transcript) the repair used to
// skip the bucket while the replay added a second one beside it: one day, two
// rows, and the copies still counted.
{
  const home = await freshHome()
  const at = new Date('2026-10-16T09:00:00').getTime()
  const call = (id, input) => JSON.stringify({
    type: 'assistant/message',
    time: at,
    data: {
      usage: { inputTokens: input, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      message: { id, source: { provider: 'workbuddy', model: 'm1' } },
    },
  })
  await writeTranscript(home, [call('msg-1', 100)], 'parent')
  await writeTranscript(home, [call('msg-1', 100), call('msg-2', 300)], 'child')
  const { localDeviceId } = await load('host/device-ledger.ts')
  const ledgerPath = join(home, 'dsh-usage', `usage-ledger.${localDeviceId()}.json`)
  const bucket = (input, output, calls) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  await writeFile(ledgerPath, JSON.stringify({ version: 1, days: { '2026-10-16': { WorkBuddy: { M1: bucket(500, 30, 3) } } } }))
  const { UsageService } = await load('host/usage-service.ts')
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  const day = svc.overview().usage.days.find((row) => row.date === '2026-10-16')
  check('a drifted spelling is repaired in place', day?.totals.calls === 2 && day?.totals.inputTokens === 400, `${day?.totals.calls}/${day?.totals.inputTokens}`)
  check('a drifted spelling does not become a second bucket', Object.keys(svc.ledger.days['2026-10-16'] ?? {}).length === 1,
    JSON.stringify(Object.keys(svc.ledger.days['2026-10-16'] ?? {})))
  await svc.stop()
}

// ---- a replay recovery and the retention prune survive the next flush ---
// The first flush used to merge the file's own document back in: the bucket the
// replay had just recovered was replaced by the file's older number, and the day
// the prune had dropped came back from the file.
{
  const home = await freshHome()
  const { localDateKey } = await load('core/ledger.ts')
  const { localDeviceId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const ledgerPath = join(home, 'dsh-usage', `usage-ledger.${localDeviceId()}.json`)
  const bucket = (input, calls) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  const recoveredDay = localDateKey(Date.now() - 2 * 86_400_000)
  const staleDay = localDateKey(Date.now() - 60 * 86_400_000)
  await writeTranscript(home, [JSON.stringify({
    type: 'assistant/message',
    time: Date.now() - 2 * 86_400_000,
    data: { usage: { inputTokens: 120, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, message: { id: 'msg-9', source: { provider: 'buddy', model: 'm1' } } },
  })])
  await writeFile(ledgerPath, JSON.stringify({ version: 1, days: { [staleDay]: { buddy: { m1: bucket(900, 9) } } } }))
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 7 })
  await svc.loadPersisted()
  check('the replay recovers the missing call', svc.ledger.days[recoveredDay]?.buddy?.m1?.calls === 1, JSON.stringify(Object.keys(svc.ledger.days)))
  check('the prune drops the stale day', svc.ledger.days[staleDay] === undefined, JSON.stringify(Object.keys(svc.ledger.days)))
  await svc.flushLedger()
  const persisted = JSON.parse(await readFile(ledgerPath, 'utf8'))
  check('the flush keeps the recovered call', persisted.days[recoveredDay]?.buddy?.m1?.calls === 1, JSON.stringify(Object.keys(persisted.days)))
  check('the flush keeps the stale day dropped', persisted.days[staleDay] === undefined, JSON.stringify(Object.keys(persisted.days)))
  await svc.stop()
}

// ---- a flush never writes over a ledger it could not parse --------------
{
  const home = await freshHome()
  const { localDeviceId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const ledgerPath = join(home, 'dsh-usage', `usage-ledger.${localDeviceId()}.json`)
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  // Corrupted between the load and the flush: the bytes may be the only copy.
  await writeFile(ledgerPath, '{ broken')
  await svc.flushLedger()
  check('a flush leaves an unparseable file alone', (await readFile(ledgerPath, 'utf8')) === '{ broken')
  check('a skipped flush is reported', String(svc.overview().usage.ledgerError ?? '').includes('write skipped'), String(svc.overview().usage.ledgerError))
  await svc.stop()
}


{
  const home = await freshHome()
  const { localDeviceId } = await load('host/device-ledger.ts')
  const ledgerPath = join(home, 'dsh-usage', `usage-ledger.${localDeviceId()}.json`)
  await writeFile(ledgerPath, '{ this is not a ledger')
  const { UsageService } = await load('host/usage-service.ts')
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  const names = await readdir(join(home, 'dsh-usage'))
  check('a corrupt ledger is kept aside', names.some((name) => name.includes('.corrupt-')), names.join(','))
  check('a corrupt ledger is reported', String(svc.overview().usage.ledgerError ?? '').includes('corrupt'), String(svc.overview().usage.ledgerError))

  // The fresh document keeps counting and is written again.
  const { createLedgerDocument, foldUsage } = await load('core/ledger.ts')
  svc.ledger = createLedgerDocument()
  foldUsage(svc.ledger, new Date('2026-10-15T12:00:00').getTime(), 'buddy', 'm1', { inputTokens: 40, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 1, cost: 0 })
  await svc.flushLedger()
  const rewritten = JSON.parse(await readFile(ledgerPath, 'utf8'))
  check('a fresh ledger is written after the quarantine', rewritten.days['2026-10-15']?.buddy?.m1?.calls === 1, JSON.stringify(rewritten).slice(0, 160))
  await svc.stop()
}

// ---- an unreadable ledger is never overwritten --------------------------
{
  const home = await freshHome()
  const { localDeviceId } = await load('host/device-ledger.ts')
  const ledgerPath = join(home, 'dsh-usage', `usage-ledger.${localDeviceId()}.json`)
  // A directory at the ledger path makes readFile fail with EISDIR — a stand-in
  // for the locked / permission-denied cases a Windows profile produces.
  await mkdir(ledgerPath, { recursive: true })
  const { UsageService } = await load('host/usage-service.ts')
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  check('an unreadable ledger keeps the write guard armed', svc.loaded === false)
  check('an unreadable ledger is reported', String(svc.overview().usage.ledgerError ?? '').includes('unreadable'), String(svc.overview().usage.ledgerError))
  await svc.flushLedger()
  check('an unreadable ledger is left untouched', (await stat(ledgerPath)).isDirectory())
  await svc.stop()
}

// ---- two processes on one machine keep each other's calls ---------------
// Both write the whole document, so the last flush used to own the history: a
// second window's calls vanished on the next flush of the first.
{
  const home = await freshHome()
  const { createLedgerDocument, foldUsage } = await load('core/ledger.ts')
  const { localDeviceId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const ledgerPath = join(home, 'dsh-usage', `usage-ledger.${localDeviceId()}.json`)
  const at = new Date('2026-10-14T10:00:00').getTime()
  const bucket = (input, calls) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  const calls = async () => JSON.parse(await readFile(ledgerPath, 'utf8')).days['2026-10-14']?.buddy?.m1?.calls

  const first = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  const second = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await first.loadPersisted()
  await second.loadPersisted()
  foldUsage(first.ledger, at, 'buddy', 'm1', bucket(600, 6))
  await first.flushLedger()
  foldUsage(second.ledger, at, 'buddy', 'm1', bucket(700, 7))
  await second.flushLedger()
  check('both processes are counted', (await calls()) === 13, String(await calls()))
  foldUsage(first.ledger, at, 'buddy', 'm1', bucket(100, 1))
  await first.flushLedger()
  check('a flush adds only its own growth', (await calls()) === 14, String(await calls()))
  check('the first process adopted the merged document', first.ledger.days['2026-10-14']?.buddy?.m1?.calls === 14, String(first.ledger.days['2026-10-14']?.buddy?.m1?.calls))
  await first.stop()
  await second.stop()
}

// ---- a peer file must not impersonate another device --------------------
{
  const home = await freshHome()
  const { localDeviceId } = await load('host/device-ledger.ts')
  const own = localDeviceId()
  const bucket = { inputTokens: 900, outputTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 9, cost: 0 }
  // A copy of THIS machine's ledger under a peer name would double every call.
  await writeFile(join(home, 'dsh-usage', 'usage-ledger.laptop-abc123.json'), JSON.stringify({ deviceId: own, ledger: { version: 1, days: { '2026-10-13': { buddy: { m1: bucket } } } } }))
  const { UsageService } = await load('host/usage-service.ts')
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  const day = svc.overview().usage.days.find((row) => row.date === '2026-10-13')
  check('a renamed copy of this device is refused', day === undefined, JSON.stringify(day ?? null))
  check('the refusal is reported', String(svc.overview().usage.devicesError ?? '').includes('names device'), String(svc.overview().usage.devicesError))
  await svc.stop()

  // A peer whose document agrees with its file name is still summed in.
  await writeFile(join(home, 'dsh-usage', 'usage-ledger.laptop-abc123.json'), JSON.stringify({ deviceId: 'laptop-abc123', machine: 'machine-laptop', ledger: { version: 1, days: { '2026-10-13': { buddy: { m1: bucket } } } } }))
  const third = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await third.loadPersisted()
  check('a matching peer is summed in', third.overview().usage.days.find((row) => row.date === '2026-10-13')?.totals.calls === 9, JSON.stringify(third.overview().usage.days).slice(0, 160))
  await third.stop()
}

// ---- range aggregate (the multi-month windows' one-request path) --------
{
  const home = await freshHome()
  const { UsageService } = await load('host/usage-service.ts')
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  const { createLedgerDocument, foldUsage } = await load('core/ledger.ts')
  svc.ledger = createLedgerDocument()
  const bucket = (input, output, calls) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  const at = (day) => new Date(day + 'T12:00:00').getTime()
  foldUsage(svc.ledger, at('2026-10-18'), 'workbuddy', 'm2', bucket(700, 10, 1))
  foldUsage(svc.ledger, at('2026-10-19'), 'buddy', 'm1', bucket(1000, 100, 2))
  foldUsage(svc.ledger, at('2026-10-20'), 'buddy', 'm1', bucket(500, 50, 3))

  const window = svc.range('2026-10-19', '2026-10-20')
  check('range aggregates the window totals', window.totals.calls === 5 && window.totals.inputTokens === 1500 && window.totals.outputTokens === 150, JSON.stringify(window.totals))
  check('range series lists the recorded days', JSON.stringify(window.series.map((row) => row.date)) === JSON.stringify(['2026-10-19', '2026-10-20']), JSON.stringify(window.series.map((r) => r.date)))
  check('range series rows carry per-day totals', window.series[0].totals.calls === 2 && window.series[1].totals.calls === 3)
  check('range series rows carry the per-model split', window.series[0].models?.m1?.calls === 2 && window.series[1].models?.m1?.calls === 3, JSON.stringify(window.series.map((r) => r.models)))
  check('range providers break down per channel', window.providers.length === 1 && window.providers[0].provider === 'buddy', JSON.stringify(window.providers.map((p) => p.provider)))
  const whole = svc.range('2026-10-01', '2026-10-31')
  check('wider range adds the 10-18 day', whole.totals.calls === 6 && whole.providers.length === 2, `calls=${whole.totals.calls} providers=${whole.providers.length}`)
  const outside = svc.range('2026-11-01', '2026-11-30')
  check('range outside the ledger reads empty', outside.totals.calls === 0 && outside.series.length === 0 && outside.providers.length === 0)

  // The route wraps the same aggregate: shape-checked bounds, the same
  // loopback fence as the overview.
  const { makeUsageRangeRoute } = await load('host/routes.ts')
  const route = makeUsageRangeRoute(ctxStub, svc)
  const call = async (url, headers = {}) => {
    const req = { url, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:9367', ...headers } }
    const captured = { status: 0, body: '' }
    await route.handler(req, { writeHead: (status) => { captured.status = status }, end: (payload) => { captured.body = String(payload) } })
    return { status: captured.status, body: JSON.parse(captured.body) }
  }
  const ok = await call('/api/dsh-usage/range?from=2026-10-19&to=2026-10-20')
  check('route answers the window aggregate', ok.status === 200 && ok.body.ok === true && ok.body.totals.calls === 5 && ok.body.series.length === 2, JSON.stringify(ok.body).slice(0, 200))
  check('route refuses an inverted range', (await call('/api/dsh-usage/range?from=2026-10-20&to=2026-10-19')).status === 400)
  check('route refuses a malformed date', (await call('/api/dsh-usage/range?from=not-a-date&to=2026-10-20')).status === 400)
  check('route refuses a missing bound', (await call('/api/dsh-usage/range?to=2026-10-20')).status === 400)
  check('route keeps the loopback fence', (await call('/api/dsh-usage/range?from=2026-10-19&to=2026-10-20', { 'x-forwarded-for': '203.0.113.7' })).status === 403)
}

// ---- the loopback fence (upstream 0.4.8 security fix) -------------------
{
  const { isProxiedRequest, isLoopbackRequest, isLoopbackAddress, isLoopbackHostname } = await load('host/loopback.ts')

  /** Minimal IncomingMessage: only the fields the fence reads. */
  const req = ({ address = '127.0.0.1', headers = {} } = {}) => ({ socket: { remoteAddress: address }, headers })

  check('loopback address ::1 accepted', isLoopbackAddress('::1') === true)
  check('loopback address 127.0.0.5 accepted', isLoopbackAddress('127.0.0.5') === true)
  check('loopback address ::ffff:127.0.0.1 accepted', isLoopbackAddress('::ffff:127.0.0.1') === true)
  check('public address rejected', isLoopbackAddress('203.0.113.7') === false)
  check('absent address rejected', isLoopbackAddress(undefined) === false)
  check('localhost hostname accepted', isLoopbackHostname('localhost') === true)
  check('public hostname rejected', isLoopbackHostname('example.com') === false)

  check('plain loopback request trusted', isLoopbackRequest(req({ headers: { host: '127.0.0.1:9367' } })) === true)
  check('no x-forwarded-for means not proxied', isProxiedRequest(req()) === false)

  // The fix: a forwarding header is proof that a hop stood in between, so the
  // request is never local even though socket and Host both say loopback.
  check('x-forwarded-for marks proxied', isProxiedRequest(req({ headers: { 'x-forwarded-for': '1.2.3.4' } })) === true)
  check('cf-connecting-ip marks proxied', isProxiedRequest(req({ headers: { 'cf-connecting-ip': '1.2.3.4' } })) === true)
  check('proxied request refused despite loopback socket',
    isLoopbackRequest(req({ headers: { host: '127.0.0.1:9367', 'x-forwarded-for': '1.2.3.4' } })) === false)
  check('proxied request refused via cf-connecting-ip',
    isLoopbackRequest(req({ headers: { host: 'localhost:9367', 'cf-connecting-ip': '1.2.3.4' } })) === false)

  check('non-loopback socket refused', isLoopbackRequest(req({ address: '203.0.113.7', headers: { host: '127.0.0.1:9367' } })) === false)
  check('public host header refused', isLoopbackRequest(req({ headers: { host: 'example.com' } })) === false)
  check('missing host header refused', isLoopbackRequest(req()) === false)
  check('cross-site fetch refused',
    isLoopbackRequest(req({ headers: { host: '127.0.0.1:9367', 'sec-fetch-site': 'cross-site' } })) === false)
  check('same-origin marker accepted',
    isLoopbackRequest(req({ headers: { host: '127.0.0.1:9367', origin: 'http://127.0.0.1:9367' } })) === true)
  check('foreign origin refused',
    isLoopbackRequest(req({ headers: { host: '127.0.0.1:9367', origin: 'http://evil.example' } })) === false)
}

// ---- DeepSeek peak/off-peak periods (upstream 0.4.8 UI feed) ------------
{
  const { deepseekPeriodAt } = await load('core/pricing.ts')
  const BEIJING = (iso) => Date.parse(iso + '+08:00')
  // 2026-10-20 is a Tuesday; 2026-10-24 a Saturday.
  const insideMorning = deepseekPeriodAt(BEIJING('2026-10-20T10:00:00'))
  check('10:00 Beijing on a weekday is peak', insideMorning.peak === true)
  check('peak boundary is the window close (12:00)',
    new Date(insideMorning.boundaryMs + 8 * 3_600_000).toISOString().slice(11, 16) === '12:00',
    new Date(insideMorning.boundaryMs + 8 * 3_600_000).toISOString())
  const beforeWindow = deepseekPeriodAt(BEIJING('2026-10-20T08:00:00'))
  check('08:00 Beijing is off-peak', beforeWindow.peak === false)
  check('off-peak boundary is the window open (09:00)',
    new Date(beforeWindow.boundaryMs + 8 * 3_600_000).toISOString().slice(11, 16) === '09:00',
    new Date(beforeWindow.boundaryMs + 8 * 3_600_000).toISOString())
  const lunch = deepseekPeriodAt(BEIJING('2026-10-20T13:00:00'))
  check('13:00 Beijing (lunch gap) is off-peak', lunch.peak === false)
  const afternoon = deepseekPeriodAt(BEIJING('2026-10-20T15:00:00'))
  check('15:00 Beijing is peak', afternoon.peak === true)
  const saturday = deepseekPeriodAt(BEIJING('2026-10-24T10:00:00'))
  check('Saturday midday is never peak', saturday.peak === false)
}

// ---- live fold: every call carries its own route ------------------------
// `request/header` fires once per epoch, so a session whose single header was
// published before the listener attached used to lose every later call — the
// long-lived subagent sessions, whose header lands at spawn time, dropped whole
// runs that way. The record itself always names its provider/model pair, and
// that is what the fold has to trust.
{
  await freshHome()
  const { createLedgerDocument, localDateKey } = await load('core/ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const listeners = new Map()
  const capturing = { ...ctxStub, on: (name, listener) => { listeners.set(name, listener); return () => {} } }
  const svc = new UsageService(capturing, { pollIntervalSec: 60, retainDays: 180 })
  svc.start()
  await new Promise((done) => setTimeout(done, 25))
  svc.ledger = createLedgerDocument()
  const emit = listeners.get('session/event')
  check('start subscribes to session/event', typeof emit === 'function')

  const at = (iso) => Date.parse(iso + '+08:00')
  const session = { id: 'sess-a' }
  const call = (atMs, provider, model, input) => emit(session, {
    type: 'assistant/message',
    seq: 1,
    time: atMs,
    data: {
      usage: { inputTokens: input, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      message: { source: { kind: 'model', provider, model } },
    },
  })
  const bucket = (atMs, provider, model) => svc.ledger.days[localDateKey(atMs)]?.[provider]?.[model]

  const morning = at('2026-10-20T10:00:00')
  call(morning, 'mcgrox', 'deepseek-v4.1-flash', 1000)
  check('a call with no header event still folds', bucket(morning, 'mcgrox', 'deepseek-v4.1-flash')?.calls === 1, JSON.stringify(svc.ledger.days).slice(0, 200))

  call(at('2026-10-20T10:01:00'), 'magpie-anthropic', 'glm-5.3', 2000)
  check('a mid-session route switch follows the record',
    bucket(morning, 'magpie-anthropic', 'glm-5.3')?.calls === 1 && bucket(morning, 'mcgrox', 'deepseek-v4.1-flash')?.calls === 1,
    JSON.stringify(svc.ledger.days[localDateKey(morning)] ?? {}).slice(0, 200))

  const lateMs = at('2026-10-19T23:59:00')
  call(lateMs, 'mcgrox', 'deepseek-v4.1-flash', 500)
  check('the record timestamp decides the day', bucket(lateMs, 'mcgrox', 'deepseek-v4.1-flash')?.calls === 1, Object.keys(svc.ledger.days).join(','))
  await svc.stop()
}

// ---- a correction outlives a process that loaded before it --------------
// Two processes share one ledger file. The one that loaded the inflated bucket
// must not write it back over the corrected one: a document stamped with a newer
// `repairedAt` is adopted whole instead of merged bucket by bucket.
{
  const home = await freshHome()
  const { localDeviceId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const dir = join(home, 'dsh-usage')
  const todayKey = (await load('core/ledger.ts')).localDateKey(Date.now())
  const bucket = (input, calls) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  const ledgerPath = join(dir, `usage-ledger.${localDeviceId()}.json`)
  await writeFile(ledgerPath, JSON.stringify({ version: 1, days: { [todayKey]: { buddy: { m1: bucket(500, 5) } } } }))
  const stale = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await stale.loadPersisted()
  check('the stale process loaded the inflated bucket', stale.ledger.days[todayKey].buddy.m1.inputTokens === 500, JSON.stringify(stale.ledger.days))
  // Another process corrects the file and stamps it.
  await writeFile(ledgerPath, JSON.stringify({
    version: 1, deviceId: localDeviceId(), machine: 'x', repairedAt: Date.now(),
    days: { [todayKey]: { buddy: { m1: bucket(400, 4) } } },
  }))
  await stale.flushLedger()
  const written = JSON.parse(await readFile(ledgerPath, 'utf8'))
  check('a stale flush adopts the corrected document', written.days[todayKey].buddy.m1.inputTokens === 400, JSON.stringify(written.days))
  await stale.stop()
}

// ---- merging two writers keeps fields the token total ignores -----------
// `totalTokens` counts input/cache/output only. Replacing a whole bucket with the
// larger-by-total one therefore dropped `reasoningTokens` and `cost` on the floor.
{
  const { mergeLedgerMax, totalTokens } = await load('core/ledger.ts')
  const left = { version: 1, days: { '2026-10-20': { buddy: { m1: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000, cacheWriteTokens: 0, reasoningTokens: 500, calls: 1, cost: 7 } } } } }
  const right = { version: 1, days: { '2026-10-20': { buddy: { m1: { inputTokens: 2000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 2, cost: 0 } } } } }
  mergeLedgerMax(left, right)
  const merged = left.days['2026-10-20'].buddy.m1
  check('a field-wise merge keeps reasoning tokens', merged.reasoningTokens === 500, JSON.stringify(merged))
  check('a field-wise merge keeps the larger call count', merged.calls === 2, JSON.stringify(merged))
  check('a field-wise merge keeps the larger value of every field', totalTokens(merged) === 3000, String(totalTokens(merged)))
}

// ---- an unverifiable peer is summed, but flagged ------------------------
// A peer file exported before this build stamped machine ids names a device that
// is not us and is not a bare document, so it is real history — but nothing in it
// proves which machine wrote it. Refusing it would shrink the user's totals by
// whatever that device contributed (on the real profile: 6.9 % of all calls), so
// it is summed and reported as unverified instead.
{
  const home = await freshHome()
  const dir = join(home, 'dsh-usage')
  const { localDeviceId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const { localDateKey } = await load('core/ledger.ts')
  const todayKey = localDateKey(Date.now())
  const bucket = (input, calls) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  await writeFile(join(dir, 'usage-ledger.' + localDeviceId() + '.json'), JSON.stringify({ version: 1, days: { [todayKey]: { buddy: { m1: bucket(1000, 10) } } } }))
  await writeFile(join(dir, 'usage-ledger.peerone.json'), JSON.stringify({ version: 1, deviceId: 'peerone', days: { [todayKey]: { peer: { p1: bucket(700, 7) } } } }))
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  check('an unverifiable peer is still counted', svc.overview().usage.all.totals.calls === 17, String(svc.overview().usage.all.totals.calls))
  check('the unverified peer is reported', String(svc.overview().usage.ledgerNote ?? '').includes('unverified'), String(svc.overview().usage.ledgerNote))
  check('the unverified peer is listed as a device', svc.overview().usage.devices.length === 2, JSON.stringify(svc.overview().usage.devices))
  await svc.stop()
}

// ---- this machine under another name is the same machine ----------------
// The machine id is minted once and kept in machine-id.json precisely so that a
// rename, or a file copied under a different device name, is recognised as this
// machine instead of being added on top of it.
{
  const home = await freshHome()
  const dir = join(home, 'dsh-usage')
  const { localDeviceId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const { localDateKey } = await load('core/ledger.ts')
  const todayKey = localDateKey(Date.now())
  const bucket = (input, calls) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  await writeFile(join(dir, 'usage-ledger.' + localDeviceId() + '.json'), JSON.stringify({ version: 1, days: { [todayKey]: { buddy: { m1: bucket(1000, 10) } } } }))
  const first = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await first.loadPersisted()
  await first.stop()
  const pinned = JSON.parse(await readFile(join(dir, 'machine-id.json'), 'utf8')).machineId
  // The ordinary flush has to stamp that pinned id: the wrapper's fallback is a
  // digest of host, platform and user, which changes exactly when the host is
  // renamed — the event the pinned id exists for.
  const ownFile = JSON.parse(await readFile(join(dir, 'usage-ledger.' + localDeviceId() + '.json'), 'utf8'))
  check('the flushed file carries the pinned machine id', ownFile.machine === pinned, String(ownFile.machine))
  check('the flushed file names its device', ownFile.deviceId === localDeviceId(), String(ownFile.deviceId))
  // The same history, copied out under the old host name, and slightly larger.
  await writeFile(join(dir, 'usage-ledger.oldhost-abc123.json'), JSON.stringify({
    version: 1, deviceId: 'oldhost-abc123', machine: pinned,
    days: { [todayKey]: { buddy: { m1: bucket(1200, 12) } } },
  }))
  const second = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await second.loadPersisted()
  const totals = second.overview().usage.all.totals
  check('a renamed copy of this machine is not a second device', second.overview().usage.devices.length === 1, JSON.stringify(second.overview().usage.devices))
  check('a renamed copy merges instead of summing', totals.calls === 12 && totals.inputTokens === 1200, JSON.stringify(totals))
  check('the merge is reported', String(second.overview().usage.ledgerNote ?? '').includes('oldhost-abc123'), String(second.overview().usage.ledgerNote))
  await second.stop()
}

// ---- a flush that never reached the disk does not put the correction back --
// A write can fail (a locked file, a read-only profile, a full disk). The file on
// disk then still holds the inflated buckets while memory holds the corrected
// ones. Reading that file back and adopting it — which a plain max merge does —
// would resurrect the very numbers the repair removed, and with the marker not yet
// written nothing would ever take them out again.
{
  const home = await freshHome()
  const dir = join(home, 'dsh-usage')
  const { localDeviceId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const { localDateKey } = await load('core/ledger.ts')
  const todayKey = localDateKey(Date.now())
  const bucket = (input, calls) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  const ledgerPath = join(dir, 'usage-ledger.' + localDeviceId() + '.json')
  const stamp = Date.now()
  await writeFile(ledgerPath, JSON.stringify({ version: 1, deviceId: localDeviceId(), machine: 'pin', repairedAt: stamp, days: { [todayKey]: { buddy: { m1: bucket(400, 4) } } } }))
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  // The correction never reached the disk: the old, inflated file is still there,
  // and it carries no stamp at all.
  await writeFile(ledgerPath, JSON.stringify({ version: 1, days: { [todayKey]: { buddy: { m1: bucket(500, 5) } } } }))
  await svc.flushLedger()
  const written = JSON.parse(await readFile(ledgerPath, 'utf8'))
  check('a failed write does not resurrect the inflated bucket', written.days[todayKey].buddy.m1.inputTokens === 400, JSON.stringify(written.days))
  check('the rewrite is reported as a stale writer', String(svc.overview().usage.ledgerNote ?? '').includes('predates'), String(svc.overview().usage.ledgerNote))
  check('the rewritten file is stamped again', written.repairedAt === stamp, String(written.repairedAt))
  await svc.stop()
}

// ---- a file stamped with the derived digest is this machine -------------
// Before the pinned id existed, a flush stamped the digest of host, platform and
// user. A copy of this machine's own ledger that still carries that stamp is not
// a second device; summing it would double this machine's history.
{
  const home = await freshHome()
  const dir = join(home, 'dsh-usage')
  const { localDeviceId, localMachineId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const { localDateKey } = await load('core/ledger.ts')
  const todayKey = localDateKey(Date.now())
  const bucket = (input, calls) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  await writeFile(join(dir, 'usage-ledger.' + localDeviceId() + '.json'), JSON.stringify({ version: 1, days: { [todayKey]: { buddy: { m1: bucket(1000, 10) } } } }))
  await writeFile(join(dir, 'usage-ledger.backup-1.json'), JSON.stringify({
    version: 1, deviceId: 'backup-1', machine: localMachineId(),
    days: { [todayKey]: { buddy: { m1: bucket(700, 7) } } },
  }))
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  const totals = svc.overview().usage.all.totals
  check('a digest-stamped copy is not a second device', svc.overview().usage.devices.length === 1, JSON.stringify(svc.overview().usage.devices))
  check('a digest-stamped copy merges instead of summing', totals.calls === 10 && totals.inputTokens === 1000, JSON.stringify(totals))
  await svc.stop()
}

// ---- a pin lost to a read-only profile still recognises the old files ---
// A profile that could not write machine-id.json falls back to the digest, then
// mints a fresh id once it can write. The files written under the old pin are
// still this machine's, so they must be folded in rather than summed.
{
  const home = await freshHome()
  const dir = join(home, 'dsh-usage')
  const { localDeviceId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const { localDateKey } = await load('core/ledger.ts')
  const todayKey = localDateKey(Date.now())
  const bucket = (input, calls) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  const oldPin = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  await writeFile(join(dir, 'machine-id.json'), JSON.stringify({ machineId: oldPin }))
  await writeFile(join(dir, 'usage-ledger.' + localDeviceId() + '.json'), JSON.stringify({
    version: 1, deviceId: localDeviceId(), machine: oldPin,
    days: { [todayKey]: { buddy: { m1: bucket(1000, 10) } } },
  }))
  const first = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await first.loadPersisted()
  await first.stop()
  await rm(join(dir, 'machine-id.json'), { force: true })
  await writeFile(join(dir, 'usage-ledger.other-2.json'), JSON.stringify({
    version: 1, deviceId: 'other-2', machine: oldPin,
    days: { [todayKey]: { buddy: { m1: bucket(1200, 12) } } },
  }))
  const second = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await second.loadPersisted()
  const totals = second.overview().usage.all.totals
  check('a file under a lost pin is not a second device', second.overview().usage.devices.length === 1, JSON.stringify(second.overview().usage.devices))
  check('a file under a lost pin is folded in', totals.calls === 12 && totals.inputTokens === 1200, JSON.stringify(totals))
  await second.stop()
}

// ---- a lowered retention prunes after a restart -------------------------
// The file records the window it was written under. Lowering the setting is the
// user's own doing, so the first flush after the change has to prune — otherwise
// the shorter window silently keeps the days it was meant to drop.
{
  const home = await freshHome()
  const dir = join(home, 'dsh-usage')
  const { localDeviceId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const { localDateKey } = await load('core/ledger.ts')
  const bucket = (input, calls) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  const dayKey = (daysAgo) => {
    const at = new Date()
    at.setDate(at.getDate() - daysAgo)
    return localDateKey(at.getTime())
  }
  const days = {}
  for (const ago of [20, 10, 0]) days[dayKey(ago)] = { buddy: { m1: bucket(100, 1) } }
  const ledgerPath = join(dir, 'usage-ledger.' + localDeviceId() + '.json')
  await writeFile(ledgerPath, JSON.stringify({ version: 1, deviceId: localDeviceId(), machine: 'pin', retentionDays: 180, days }))
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 7 })
  await svc.loadPersisted()
  await svc.flushLedger()
  const written = JSON.parse(await readFile(ledgerPath, 'utf8'))
  check('a lowered retention prunes on the next flush', Object.keys(written.days).length === 1, Object.keys(written.days).join(','))
  check('the file records the new window', written.retentionDays === 7, String(written.retentionDays))
  await svc.stop()
}

// ---- retention: a shrink is honoured, a clock jump is refused -----------
// The guard exists for a jumped clock, which makes every recorded day fall
// outside the window at once. A user who lowers the setting keeps the recent
// days, so the same guard must not veto the shrink.
{
  const home = await freshHome()
  const dir = join(home, 'dsh-usage')
  const { localDeviceId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const { localDateKey } = await load('core/ledger.ts')
  const bucket = (input, calls) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  const days = {}
  for (let back = 0; back < 30; back += 1) {
    const at = Date.now() - back * 86_400_000
    days[localDateKey(at)] = { buddy: { m1: bucket(100, 1) } }
  }
  await writeFile(join(dir, 'usage-ledger.' + localDeviceId() + '.json'), JSON.stringify({ version: 1, days }))
  const shrunk = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 7 })
  await shrunk.loadPersisted()
  const kept = Object.keys(shrunk.ledger.days).length
  check('a lower retention drops the older days', kept === 7, String(kept))
  await shrunk.stop()

  // Every recorded day outside the window: the clock moved, not the setting.
  const jumpedHome = await freshHome()
  const jumpedDir = join(jumpedHome, 'dsh-usage')
  const old = {}
  for (let back = 400; back < 430; back += 1) {
    const at = Date.now() - back * 86_400_000
    old[localDateKey(at)] = { buddy: { m1: bucket(100, 1) } }
  }
  await writeFile(join(jumpedDir, 'usage-ledger.' + localDeviceId() + '.json'), JSON.stringify({ version: 1, days: old }))
  const jumped = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await jumped.loadPersisted()
  check('a jumped clock keeps the history', Object.keys(jumped.ledger.days).length === 30, String(Object.keys(jumped.ledger.days).length))
  check('the refused prune is reported', String(jumped.overview().usage.ledgerNote ?? '').includes('retention skipped'), String(jumped.overview().usage.ledgerNote))
  await jumped.stop()
}

// ---- a quarantined ledger is rebuilt from the pre-migration file --------
// The oldest days predate the transcripts this build can replay, so the ledger
// file is their only copy. Quarantining a corrupt one must not take them with it.
{
  const home = await freshHome()
  const dir = join(home, 'dsh-usage')
  const { localDeviceId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const bucket = (input, calls) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  await writeFile(join(dir, 'usage-ledger.json.migrated'), JSON.stringify({ version: 1, days: { '2026-09-21': { buddy: { m1: bucket(4000, 3) } } } }))
  await writeFile(join(dir, 'usage-ledger.' + localDeviceId() + '.json'), '{"version":1,"days":{"2026-10-20":')
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  const restored = svc.overview().usage.days.find((row) => row.date === '2026-09-21')
  check('the pre-migration history survives a corrupt ledger', restored?.totals.calls === 3, JSON.stringify(svc.overview().usage.days.map((row) => row.date)))
  check('the rebuild is reported', String(svc.overview().usage.ledgerNote ?? '').includes('pre-migration'), String(svc.overview().usage.ledgerNote))
  check('the corrupt file is still quarantined', String(svc.overview().usage.ledgerError ?? '').includes('corrupt'), String(svc.overview().usage.ledgerError))
  await svc.stop()
}

// ---- the machine id is minted once, even under a race ------------------
// Two processes starting together both find no file; whichever writes second must
// adopt the winner's id instead of spending the session stamping documents with
// an id the other one does not know.
{
  const home = await freshHome()
  const dir = join(home, 'dsh-usage')
  const { ensureMachineId } = await load('host/device-ledger.ts')
  const [a, b] = await Promise.all([ensureMachineId(dir), ensureMachineId(dir)])
  const disk = JSON.parse(await readFile(join(dir, 'machine-id.json'), 'utf8')).machineId
  check('a machine id race settles on one id', a === b && a === disk, a + ' / ' + b + ' / ' + disk)
}

// ---- a short history is guarded too ------------------------------------
// The guard exists for a jumped clock, and a fresh install with two days on file
// is exactly where a jump wipes everything.
{
  const home = await freshHome()
  const dir = join(home, 'dsh-usage')
  const { localDeviceId } = await load('host/device-ledger.ts')
  const { UsageService } = await load('host/usage-service.ts')
  const { localDateKey } = await load('core/ledger.ts')
  const todayKey = localDateKey(Date.now())
  const bucket = (input, calls) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  const daysAgo = (n) => localDateKey(Date.now() - n * 86_400_000)
  const old = daysAgo(400)
  const older = daysAgo(401)
  await writeFile(join(dir, 'usage-ledger.' + localDeviceId() + '.json'), JSON.stringify({
    version: 1,
    days: { [old]: { buddy: { m1: bucket(100, 1) } }, [older]: { buddy: { m1: bucket(200, 2) } } },
  }))
  const svc = new UsageService(ctxStub, { pollIntervalSec: 60, retainDays: 180 })
  await svc.loadPersisted()
  await svc.flushLedger()
  const kept = JSON.parse(await readFile(join(dir, 'usage-ledger.' + localDeviceId() + '.json'), 'utf8'))
  check('a two-day history survives a jumped clock', Object.keys(kept.days).length === 2, Object.keys(kept.days).join(','))
  check('the refused prune is reported', String(svc.overview().usage.ledgerNote ?? '').includes('retention skipped'), String(svc.overview().usage.ledgerNote))
  await svc.stop()
}

const failed = report.filter((row) => !row.ok)
console.log('\n=== ' + (report.length - failed.length) + '/' + report.length + ' checks passed ===')
if (failed.length > 0) process.exitCode = 1
