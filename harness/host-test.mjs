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
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
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

/** Write one multi-frame transcript under `<home>/sessions/<ws>/<id>/`. */
async function writeTranscript(home, lines) {
  const dir = join(home, 'sessions', 'ws1', 'sess1')
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
  check('starts with one local file', (await readdir(join(home, 'dsh-usage'))).length === 0, 'no file before a fold')

  const { createLedgerDocument, foldUsage } = await load('core/ledger.ts')
  svc.ledger = createLedgerDocument()
  foldUsage(svc.ledger, new Date('2026-10-20T12:00:00').getTime(), 'buddy', 'm1', { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 2, cost: 0 })
  await svc.flushLedger()
  check('flush writes only this device file', JSON.stringify((await readdir(join(home, 'dsh-usage'))).sort()) === JSON.stringify([`usage-ledger.${svc.device}.json`]), (await readdir(join(home, 'dsh-usage'))).join(','))

  const exported = svc.exportLedger()
  check('export carries the schema', exported.schema === 'dsh-usage-ledger' && exported.version === 1)
  check('export carries own device id', exported.deviceId === svc.device)

  const peer = {
    schema: 'dsh-usage-ledger',
    version: 1,
    deviceId: 'laptop-4f7b21',
    exportedAt: new Date().toISOString(),
    ledger: { version: 1, days: { '2026-10-20': { buddy: { m1: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 1, cost: 0 } } } } },
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
  check('local ledger untouched by peers', svc.ledger.days['2026-10-20'].buddy.m1.calls === 2, String(svc.ledger.days['2026-10-20'].buddy.m1.calls))
  // ... and flushing after an import must not write the peer's numbers into it.
  await svc.flushLedger()
  const persisted = JSON.parse(await readFile(join(home, 'dsh-usage', `usage-ledger.${svc.device}.json`), 'utf8'))
  check('flush never persists merged totals', persisted.days['2026-10-20'].buddy.m1.calls === 2, String(persisted.days['2026-10-20'].buddy.m1.calls))

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

const failed = report.filter((row) => !row.ok)
console.log('\n=== ' + (report.length - failed.length) + '/' + report.length + ' checks passed ===')
if (failed.length > 0) process.exitCode = 1
