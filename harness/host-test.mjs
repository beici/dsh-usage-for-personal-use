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
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
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
  const ledgerFiles = async () => (await readdir(join(home, 'dsh-usage'))).filter((name) => name !== 'usage-dedupe-marker.json')
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
}

// ---- the duplicate repair runs exactly once -----------------------------
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
  check('the repair never runs twice', again?.totals.calls === 2 && again?.totals.inputTokens === 400, `${again?.totals.calls}/${again?.totals.inputTokens}`)
  await second.stop()
}

// ---- a corrupt ledger is quarantined, not wiped -------------------------
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
  await writeFile(join(home, 'dsh-usage', 'usage-ledger.laptop-abc123.json'), JSON.stringify({ deviceId: 'laptop-abc123', ledger: { version: 1, days: { '2026-10-13': { buddy: { m1: bucket } } } } }))
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

const failed = report.filter((row) => !row.ok)
console.log('\n=== ' + (report.length - failed.length) + '/' + report.length + ' checks passed ===')
if (failed.length > 0) process.exitCode = 1
