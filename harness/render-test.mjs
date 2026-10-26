/**
 * Headless render test for the redesigned usage section. Mounts the built
 * client bundle (client.test.cjs, which barely differs from the shipped
 * client.js: one extra export line) inside jsdom, feeds it the saved live
 * overview + day fixtures, and asserts the window tiles / breakdown / chart
 * render the numbers we expect for 今日 / 昨日 / 近7天 / 近30天 / 自定义.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)

// Paths are resolved from this file, not from the caller's cwd, so the harness
// runs identically whether it is invoked from the repo root or from a script.
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const FIXT = join(ROOT, 'fixtures')
const overview = JSON.parse(readFileSync(`${FIXT}/overview.json`, 'utf8'))
const days = Object.fromEntries(['2026-09-21', '2026-09-22', '2026-10-19', '2026-10-20'].map((d) => [d, JSON.parse(readFileSync(`${FIXT}/day-${d}.json`, 'utf8')).day]))

// ---- jsdom global environment -------------------------------------------
// React reads `globalThis.window`/`document` lazily, so a minimal global shim
// before the imports is enough; Node 22 exposes some of these as getter-only,
// hence defineProperty instead of plain assignment.
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:1067/',
  pretendToBeVisual: true,
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.Element = window.Element
globalThis.Node = window.Node
globalThis.Event = window.Event
globalThis.MouseEvent = window.MouseEvent
globalThis.getComputedStyle = window.getComputedStyle
globalThis.requestAnimationFrame = (fn) => window.setTimeout(() => fn(Date.now()), 0)
globalThis.cancelAnimationFrame = (id) => window.clearTimeout(id)
globalThis.IS_REACT_ACT_ENVIRONMENT = true
window.IS_REACT_ACT_ENVIRONMENT = true

const React = require('react')
const ReactDOMClient = require('react-dom/client')

// ---- module loader shim --------------------------------------------------
// The bundle only touches defineStore inside apply(), which this test never
// calls (we hand the component a fake store face directly), so a stub keeps
// the harness from pulling in the real zustand-backed store implementation.
const storeStub = { defineStore: () => ({ create: () => ({ getSnapshot: () => ({}), subscribe: () => () => {} }) }) }
const moduleTable = {
  react: React,
  'react/jsx-runtime': require('react/jsx-runtime'),
  'react-dom/client': ReactDOMClient,
  '@deepseek-ai/dsh-client-store': storeStub,
}

let captured
window.__ModuleLoader__ = {
  load({ id, factory }) {
    const module = { exports: {} }
    const localRequire = (name) => {
      if (name in moduleTable) return moduleTable[name]
      throw new Error('unexpected external require: ' + name)
    }
    const result = factory(localRequire)
    captured = result
    console.log('[loader] loaded', id)
  },
}
window.__DSH === undefined

const bundleSource = readFileSync(`${ROOT}/harness/client.test.cjs`, 'utf8')
// The bundle is a CJS script wrapped in the loader call; evaluate it with a
// function scope so its top-level vars do not leak.
new Function('window', 'document', 'navigator', 'globalThis', bundleSource)(window, window.document, window.navigator, globalThis)
if (captured === undefined) throw new Error('bundle did not register with the loader')

const { UsageSectionCard } = captured
if (typeof UsageSectionCard !== 'function') throw new Error('UsageSectionCard export missing')

// ---- fake face the slot would inject ------------------------------------
const listeners = new Set()
let snapshot = overview
// useSyncExternalStore requires getSnapshot() to return a cached, referentially
// stable value until the store actually changes — mirror the real store's
// behavior instead of allocating a fresh object per call.
const storeState = { snapshot, status: 'ready', error: null }
const store = {
  getSnapshot: () => storeState,
  subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
}
const settingsState = { status: 'ready', writable: true, value: { enabled: true, pollIntervalSec: 60 } }
const settingsListeners = new Set()
const settings = {
  getSnapshot: () => settingsState,
  subscribe: (fn) => { settingsListeners.add(fn); return () => settingsListeners.delete(fn) },
  set: async () => true,
}
// Device sync is fully stubbed: the card's job is the export/import wiring and
// the device list it renders, not the host's file I/O (which the host bundle
// covers on its own).
const syncCalls = []
let importAnswer = 'laptop-4f7b21'
const deviceSync = {
  exportLedger: async () => { syncCalls.push('export') },
  importLedger: async (text) => {
    syncCalls.push('import:' + text.trim())
    if (importAnswer === 'same') throw new Error('this file was exported by THIS device; nothing to import')
    return { deviceId: importAnswer }
  },
  rescan: async () => { syncCalls.push('rescan'); return [] },
}
const fetched = []
const loadDay = async (date) => {
  fetched.push(date)
  const day = days[date]
  if (day === undefined) throw new Error('no fixture for ' + date)
  return day
}
// The range stub mirrors the contract the panel relies on: the aggregate covers
// the recorded days inside the requested span, summed the way the host's own
// summarizeDays does. The panel never asks for today (it rides the live
// overview), so a window ending today arrives with yesterday as its last row and
// the panel folds today in itself — the regression this pins (a stale today in
// the cached aggregate made 近 6 个月 read BELOW 近 30 天).
const rangeCalls = []
const dayRows = Object.entries(days).map(([date, day]) => ({ date, ...day }))
const zeroTotals = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0, cost: 0 })
const addInto = (target, source) => { for (const key of Object.keys(target)) target[key] += source[key] ?? 0 }
const loadRange = async (from, to) => {
  rangeCalls.push(from + ':' + to)
  const rows = dayRows.filter((row) => row.date >= from && row.date <= to)
  const totals = zeroTotals()
  const providers = new Map()
  for (const row of rows) {
    addInto(totals, row.totals)
    for (const channel of row.providers) {
      let entry = providers.get(channel.provider)
      if (entry === undefined) { entry = { provider: channel.provider, totals: zeroTotals(), models: new Map() }; providers.set(channel.provider, entry) }
      addInto(entry.totals, channel.totals)
      for (const model of channel.models) {
        const bucket = entry.models.get(model.model) ?? zeroTotals()
        addInto(bucket, model.totals)
        entry.models.set(model.model, bucket)
      }
    }
  }
  return {
    ok: true,
    from,
    to,
    totals,
    providers: [...providers.values()].map((entry) => ({ provider: entry.provider, totals: entry.totals, models: [...entry.models].map(([model, modelTotals]) => ({ model, totals: modelTotals })) })),
    series: rows.map((row) => ({ date: row.date, totals: row.totals })),
  }
}

const { act } = require('react-dom/test-utils')
const container = window.document.getElementById('root')
const root = ReactDOMClient.createRoot(container)

await act(async () => {
  root.render(React.createElement(UsageSectionCard, {
    store,
    poll: () => {},
    refresh: () => {},
    loadDay,
    loadRange,
    settings,
    deviceSync,
    close: () => {},
  }))
})
// Let the day fetches settle.
await act(async () => { await new Promise((r) => setTimeout(r, 60)) })

function text(el) { return (el?.textContent ?? '').replace(/\s+/g, ' ').trim() }
function q(sel) { return container.querySelector(sel) }
function qa(sel) { return [...container.querySelectorAll(sel)] }

const report = []
function check(name, ok, detail) {
  report.push({ name, ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail))
}

// ---- assertions ---------------------------------------------------------
const tiles = qa('[data-dsh-part="range-tiles"] button')
check('eight range tiles', tiles.length === 8, 'got ' + tiles.length)
if (tiles.length === 8) {
  const labels = tiles.map((b) => text(b.querySelector('span')))
  check('tile order + labels', JSON.stringify(labels) === JSON.stringify(['今日', '昨日', '近 3 天', '近 7 天', '近 30 天', '近 6 个月', '全部', '自定义']), JSON.stringify(labels))
  check('today tile active', tiles[0].getAttribute('aria-pressed') === 'true')
  for (const b of tiles) console.log('   tile:', text(b))
  // 近 3 天 = today + 2026-10-19 (10-18 未记录): 85.8M + 45.0M ≈ 131M, 1188 次调用.
  check('last3 tile sums today + 10-19', text(tiles[2]).includes('131M') && text(tiles[2]).includes('1188'), text(tiles[2]))
  // 近 6 个月 / 全部 fold the live today into the range aggregate: the stub
  // answers up to yesterday only (49.2M, 584 次调用 — the whole ledger minus
  // today), so reading 135M / 1251 proves the panel added today itself. That is
  // the regression pinned here: a cached aggregate that already carried today
  // froze it at fetch time, and 近 6 个月 read BELOW 近 30 天.
  check('last180 tile folds the live today into the aggregate', text(tiles[5]).includes('135M') && text(tiles[5]).includes('1251'), text(tiles[5]))
  check('all tile folds the live today into the aggregate', text(tiles[6]).includes('135M') && text(tiles[6]).includes('1251'), text(tiles[6]))
  check('range aggregate alone stops at yesterday', !text(tiles[5]).includes('49.2M'), text(tiles[5]))
  check('range fetches stop at yesterday',
    rangeCalls.includes('2026-04-24:2026-10-19') && rangeCalls.includes('2026-09-21:2026-10-19')
      && !rangeCalls.some((call) => call.endsWith(':2026-10-20')),
    JSON.stringify(rangeCalls))
}

const windowCard = q('[data-dsh-part="window-card"]')
check('window card rendered', windowCard !== null)
console.log('   window card text:', text(windowCard))

const stats = qa('[data-dsh-part="window-card"] [class*="statValue"]').map(text)
check('six stat cells', stats.length === 6, JSON.stringify(stats))
// 今日: cacheRead 81839616 / billed input (2914311 + 81839616) = 96.6%.
check('cache-hit cell computed', stats[4] === '96.6%', stats[4])

const chart = q('[data-dsh-part="trend-chart"]')
check('no trend chart for a single-day window', chart === null)

const breakdown = q('[data-dsh-part="channel-breakdown"]')
check('channel breakdown rendered', breakdown !== null)
const modelRows = qa('[data-dsh-part="model-rows"] [class*="chartModel"]')
console.log('   breakdown text:', text(breakdown).slice(0, 400))
check('model rows visible', modelRows.length >= 1, 'rows=' + modelRows.length)
// Provider bars stack their models' hues; every model keeps its panel-wide color.
const providerSegments = qa('[data-dsh-part="channel-breakdown"] [class*="chartSeg"]')
check('provider bars stack model colors', providerSegments.length >= 1 && providerSegments.every((seg) => (seg.getAttribute('style') ?? '').includes('background')), 'segments=' + providerSegments.length)

// ---- switch to 近 30 天 --------------------------------------------------
const last30 = tiles[4]
await act(async () => { last30.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await new Promise((r) => setTimeout(r, 120)) })
const card30 = q('[data-dsh-part="window-card"]')
console.log('   last30 card:', text(card30).slice(0, 500))
const stats30 = qa('[data-dsh-part="window-card"] [class*="statValue"]').map(text)
check('last30 six stat cells', stats30.length === 6, JSON.stringify(stats30))
const bars30 = qa('[data-dsh-part="trend-chart"] [data-dsh-part="trend-bar"]')
check('last30 trend bars = 30 calendar days', bars30.length === 30, 'bars=' + bars30.length)
const gridlines = qa('[data-dsh-part="trend-chart"] [class*="trendGridline"]')
check('trend gridlines = 4', gridlines.length === 4, 'lines=' + gridlines.length)
const legend = qa('[data-dsh-part="trend-chart"] [class*="trendLegendItem"]')
// The 逐日 windows carry per-model rows, so the bars stack BY MODEL and the
// legend names the models instead of the token kinds.
check('trend legend lists the window models', legend.length >= 1 && legend.length <= 8, 'items=' + legend.length)
check('trend legend names the models', legend.some((item) => text(item).includes('deepseek-v4.1-flash')), legend.map(text).join(' | '))
const todaySegments = [...bars30[29].querySelectorAll('span')]
check('today bar stacks by model', todaySegments.length === 1 && (todaySegments[0].getAttribute('style') ?? '').includes('background'), 'segments=' + todaySegments.length)
const spans = q('[data-dsh-part="window-card"] [class*="spanLine"]')
check('last30 span line', text(spans) === '2026-09-21 ~ 2026-10-20', text(spans))
console.log('   last30 fetched days:', JSON.stringify([...new Set(fetched)]))

// Hover a recorded day (today, bar 30): the tooltip states the date, the
// totals, the calls, and the cache-hit share.
await act(async () => { bars30[29].dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })) })
const tip = q('[data-dsh-part="trend-tooltip"]')
check('trend tooltip on hover', tip !== null)
if (tip !== null) {
  console.log('   tooltip:', text(tip))
  check('tooltip shows date + totals + calls + hit',
    text(tip).includes('2026-10-20') && text(tip).includes('85.8M') && text(tip).includes('667') && text(tip).includes('96.6%'),
    text(tip))
}
// Hover an empty slot: the tooltip says so instead of pretending zero usage.
await act(async () => { bars30[2].dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })) })
const tipEmpty = q('[data-dsh-part="trend-tooltip"]')
check('empty bucket tooltip reports no record', tipEmpty !== null && text(tipEmpty).includes('无记录'), text(tipEmpty))
await act(async () => { bars30[2].dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true })) })
check('tooltip leaves with the hover', q('[data-dsh-part="trend-tooltip"]') === null)

// ---- yesterday -----------------------------------------------------------
const yesterday = tiles[1]
await act(async () => { yesterday.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
const cardY = q('[data-dsh-part="window-card"]')
console.log('   yesterday card:', text(cardY).slice(0, 400))
const spanY = q('[data-dsh-part="window-card"] [class*="spanLine"]')
check('yesterday span', text(spanY) === '2026-10-19 ~ 2026-10-19', text(spanY))
const statsY = qa('[data-dsh-part="window-card"] [class*="statValue"]').map(text)
// Derive expectations from the fixture: total counts all four token fields,
// "input" is the billed input (raw input + cache read + cache write).
const yDay = days['2026-10-19'].totals
const yTotal = yDay.inputTokens + yDay.cacheReadTokens + yDay.cacheWriteTokens + yDay.outputTokens
const yInput = yDay.inputTokens + yDay.cacheReadTokens + yDay.cacheWriteTokens
const yHit = ((yDay.cacheReadTokens / yInput) * 100).toFixed(1) + '%'
check('yesterday totals match fixture', statsY[0] === '45M' && statsY[1] === '44.6M' && statsY[2] === '386k' && statsY[5] === '521', JSON.stringify(statsY) + ' expected total=' + yTotal + ' billedInput=' + yInput)
check('yesterday cache-hit matches fixture', statsY[4] === yHit, statsY[4] + ' expected ' + yHit)

// ---- custom --------------------------------------------------------------
const custom = tiles[7]
await act(async () => { custom.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
// Until a date is picked the tile prompts and the card explains, instead of
// silently showing the seven-day default's numbers.
check('untouched custom tile prompts', text(tiles[7]).includes('选择日期'), text(tiles[7]))
check('untouched custom card explains', q('[data-dsh-part="custom-prompt"]') !== null, text(q('[data-dsh-part="custom-prompt"]')))
const controls = q('[data-dsh-part="custom-range"]')
check('custom date inputs appear', controls !== null)
const dateInputs = controls === null ? [] : [...controls.querySelectorAll('input[type="date"]')]
check('two date inputs', dateInputs.length === 2, 'n=' + dateInputs.length)
if (dateInputs.length === 2) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(dateInputs[0], '2026-09-01')
    dateInputs[0].dispatchEvent(new window.Event('input', { bubbles: true }))
    dateInputs[0].dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(dateInputs[1], '2026-09-30')
    dateInputs[1].dispatchEvent(new window.Event('input', { bubbles: true }))
    dateInputs[1].dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
  const spanC = q('[data-dsh-part="window-card"] [class*="spanLine"]')
  console.log('   custom span:', text(spanC))
  check('custom span follows the picked pair', text(spanC) === '2026-09-01 ~ 2026-09-30', text(spanC))
  const barsC = qa('[data-dsh-part="trend-chart"] [data-dsh-part="trend-bar"]')
  check('custom trend bars = 30', barsC.length === 30, 'bars=' + barsC.length)
  console.log('   custom card:', text(q('[data-dsh-part="window-card"]')).slice(0, 400))

  // Widen the pair past the per-day path's width: the window switches to the
  // range aggregate (one fetch for the whole span) and the chart buckets by
  // month — 2026-01 .. 2026-09 = 9 bars.
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(dateInputs[0], '2026-01-01')
    dateInputs[0].dispatchEvent(new window.Event('input', { bubbles: true }))
    dateInputs[0].dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 120)) })
  const spanLong = q('[data-dsh-part="window-card"] [class*="spanLine"]')
  check('long custom span renders', text(spanLong) === '2026-01-01 ~ 2026-09-30', text(spanLong))
  check('long custom fetches one range aggregate', rangeCalls.includes('2026-01-01:2026-09-30'), JSON.stringify(rangeCalls))
  const barsLong = qa('[data-dsh-part="trend-chart"] [data-dsh-part="trend-bar"]')
  check('long custom buckets by month', barsLong.length === 9, 'bars=' + barsLong.length)
  // 2026-01-01 ~ 2026-09-30 ends before today, so the panel overlays nothing:
  // the tile reads exactly the span's own days (09-21 + 09-22 = 4.2M, 63 calls).
  check('long custom tile reads its span aggregate', text(tiles[7]).includes('4.2M') && text(tiles[7]).includes('63'), text(tiles[7]))
}

// ---- multi-device card ---------------------------------------------------
// The card is the user-facing half of the per-device ledger file layout: it
// must list which files back the totals, and its two buttons must reach the
// host API with the right calls (an export download, an import body).
const deviceCard = q('[data-dsh-part="device-card"]')
check('device card rendered', deviceCard !== null)
if (deviceCard !== null) {
  const deviceRows = [...deviceCard.querySelectorAll('[data-dsh-part="device-row"]')].map(text)
  check('device rows list local + peer', deviceRows.length === 2, JSON.stringify(deviceRows))
  console.log('   device rows:', deviceRows.join(' | '))
  const buttons = [...deviceCard.querySelectorAll('button')]
  const labels = buttons.map(text)
  check('device controls present', ['导出本机用量', '导入其他设备', '重新扫描', '复制标识'].every((label) => labels.includes(label)), JSON.stringify(labels))
  const byLabel = (label) => buttons.find((button) => text(button) === label)
  const exportBtn = byLabel('导出本机用量')
  await act(async () => { exportBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
  check('export reaches the host API', syncCalls.includes('export'), JSON.stringify(syncCalls))
  // Import goes through a real <input type=file>: drive it the way a browser
  // does, by defining `files` on the element before dispatching change.
  const fileInput = deviceCard.querySelector('input[type="file"]')
  check('file input present for import', fileInput !== null)
  if (fileInput !== null) {
    const payload = JSON.stringify({ schema: 'dsh-usage-ledger', deviceId: 'laptop-4f7b21', ledger: { version: 1, days: {} } })
    const file = new window.File([payload], 'ledger.json', { type: 'application/json' })
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
    await act(async () => { fileInput.dispatchEvent(new window.Event('change', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
    check('import posts the file body', syncCalls.some((call) => call.startsWith('import:') && call.includes('laptop-4f7b21')), JSON.stringify(syncCalls))
    const notice = q('[data-dsh-part="device-notice"]')
    check('import success is reported', text(notice).includes('laptop-4f7b21'), text(notice))
  }
  // A file this device exported must be refused with the host's own message,
  // not silently double-counted.
  importAnswer = 'same'
  const fileInput2 = deviceCard.querySelector('input[type="file"]')
  if (fileInput2 !== null) {
    const file2 = new window.File(['{"deviceId":"desktop-9c1f2a"}'], 'self.json', { type: 'application/json' })
    Object.defineProperty(fileInput2, 'files', { value: [file2], configurable: true })
    await act(async () => { fileInput2.dispatchEvent(new window.Event('change', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
    const notice2 = q('[data-dsh-part="device-notice"]')
    check('self-import surfaces a failed message', text(notice2).startsWith('导入失败'), text(notice2))
  }
}

// ---- tabs ----------------------------------------------------------------
const tabs = qa('[data-dsh-part="tabs"] button')
check('three tabs', tabs.length === 3, String(tabs.length))
await act(async () => { tabs[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
check('bank tab renders voucher card', q('[data-dsh-part="bank-card"]') !== null)
await act(async () => { tabs[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
console.log('   plans tab text:', text(container).slice(0, 200))

// ---- DeepSeek peak badge (merged from upstream 0.4.8) --------------------
// The saved fixture records buddy/workbuddy routes, so the badge is correctly
// absent from every assertion above. Mount again with the current route
// switched to deepseek-official to reach it. The expected peak/off-peak state
// depends on the wall clock, so the assertions compare the badge against
// itself (attribute vs copy) instead of pinning "peak" or "off-peak".
{
  const deepseekSnapshot = {
    ...overview,
    current: { ...overview.current, provider: 'deepseek-official' },
  }
  const mountWith = async (snapshotValue) => {
    const host = window.document.createElement('div')
    window.document.body.appendChild(host)
    const state = { snapshot: snapshotValue, status: 'ready', error: null }
    const localStore = { getSnapshot: () => state, subscribe: () => () => {} }
    const localRoot = ReactDOMClient.createRoot(host)
    await act(async () => {
      localRoot.render(React.createElement(UsageSectionCard, {
        store: localStore,
        poll: () => {},
        refresh: () => {},
        loadDay,
        loadRange,
        settings,
        deviceSync,
        close: () => {},
      }))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
    return { host, localRoot }
  }

  const deepseek = await mountWith(deepseekSnapshot)
  const badge = deepseek.host.querySelector('[data-dsh-part="peak-status"]')
  check('peak badge renders for a DeepSeek route', badge !== null)
  if (badge !== null) {
    const peakState = badge.getAttribute('data-peak')
    check('peak badge states on/off', peakState === 'on' || peakState === 'off', String(peakState))
    const expected = peakState === 'on' ? '高峰' : '空闲'
    check('peak badge word matches its state', text(badge).includes(expected), text(badge))
    // The full variant carries the priced sentence (and its clock) in the title.
    check('peak badge title states the boundary clock', /\d{1,2}:\d{2}/.test(badge.getAttribute('title') ?? ''), badge.getAttribute('title'))
  }

  // The line describes the *current* window, so a past range must drop it.
  const deepseekTiles = [...deepseek.host.querySelectorAll('[data-dsh-part="range-tiles"] button')]
  await act(async () => { deepseekTiles[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
  check('peak badge dropped outside the today window',
    deepseek.host.querySelector('[data-dsh-part="peak-status"]') === null)

  // ...and a non-DeepSeek route never shows it, even for today.
  const buddy = await mountWith(overview)
  check('peak badge absent for a non-DeepSeek route',
    buddy.host.querySelector('[data-dsh-part="peak-status"]') === null)

  await act(async () => { deepseek.localRoot.unmount() })
  await act(async () => { buddy.localRoot.unmount() })
  deepseek.host.remove()
  buddy.host.remove()
}

// ---- settings opener: registry fast path + account-menu fallback ----------
// Regression: Desktop Windows/macOS route real keys through the native preload
// bridge and the DOM keydown listener returns before dispatch there, so the
// old synthetic Ctrl+, never landed and every click flashed the account menu
// before the dialog opened. The opener must invoke the shell's settings.open
// command through the shortcuts registry when that face arrives, and keep the
// visible account-menu path only as the fallback.
{
  const { openUsageSettings } = captured
  if (typeof openUsageSettings !== 'function') throw new Error('openUsageSettings export missing')

  // Fast path: the registry command fires synchronously with the exact
  // settings.open identity and a null-modal page context.
  const invoked = []
  openUsageSettings(() => '使用统计', {
    shortcuts: { registry: { invoke: (id, context) => invoked.push([id, context]) } },
  })
  check('settings opener invokes settings.open via the registry',
    invoked.length === 1 && invoked[0][0] === 'settings.open',
    JSON.stringify(invoked.map(([id]) => id)))
  check('settings opener passes a null-modal page context',
    invoked.length === 1 && invoked[0][1].region === 'page' && invoked[0][1].modal === null,
    JSON.stringify(invoked[0]?.[1] ?? null))

  // An already-open dialog must only pick the nav row: no second open gesture.
  const dialog = window.document.createElement('div')
  dialog.setAttribute('data-shortcut-modal', 'settings')
  dialog.innerHTML = '<nav><button>使用统计</button><button>插件</button></nav>'
  window.document.body.append(dialog)
  let picked = false
  dialog.querySelector('nav button').addEventListener('click', () => { picked = true })
  const reopened = []
  openUsageSettings(() => '使用统计', {
    shortcuts: { registry: { invoke: (id, context) => reopened.push([id, context]) } },
  })
  check('open dialog is picked, never re-opened', picked && reopened.length === 0)
  dialog.remove()

  // Fallback: with no registry face the visible path still works — the
  // account-menu trigger is clicked and the dialog's usage nav row picked.
  const column = window.document.createElement('div')
  column.className = 'sidebarCol'
  column.innerHTML = '<div class="settingsArea"><button aria-haspopup="dialog">menu</button></div>'
  window.document.body.append(column)
  let triggerClicked = false
  column.querySelector('button').addEventListener('click', () => {
    triggerClicked = true
    const openedDialog = window.document.createElement('div')
    openedDialog.setAttribute('data-shortcut-modal', 'settings')
    openedDialog.innerHTML = '<nav><button>使用统计</button></nav>'
    window.document.body.append(openedDialog)
  })
  openUsageSettings(() => '使用统计')
  await new Promise((r) => setTimeout(r, 500))
  const fallbackDialog = window.document.querySelector('[data-shortcut-modal="settings"] nav button')
  check('account-menu fallback opens and picks the usage row',
    triggerClicked && fallbackDialog !== null,
    'trigger=' + triggerClicked)
  fallbackDialog?.closest('[data-shortcut-modal="settings"]')?.remove()
  column.remove()
}

// ---- model sub-bars share the CHANNEL total, with percent text -------------
// Regression (sub-bar widths): the per-model rows under a channel used to
// divide by the channel's HEAVIEST model, so the top model always read 100 %;
// a later fix over-corrected to the window total, which shrank every row by
// the channel's own window share and read as "based on the grand total" in
// wide windows. Sub-bars now share the channel total — the mother bar's own
// 100 % — and state that share as text. The saved fixture has no multi-model
// channel, so this block mounts a fresh card on a snapshot variant whose
// buddy channel carries two models.
{
  const variant = JSON.parse(JSON.stringify(overview))
  const today = variant.usage.today
  // Inject into `workbuddy` — 1.6 % of the window — sized at 35 % of its first
  // model, so the channel splits 74/26. On the window scale those same models
  // are ~1.6 % / ~0.5 %, i.e. both would clamp to the 3 % floor: the two
  // denominators are unmistakable here, whereas a 98 %-of-window channel would
  // read ~74/26 either way.
  const channel = today.providers.find((p) => p.provider === 'workbuddy')
  const first = channel.models[0]
  const totalsOf = (x) => (x.inputTokens || 0) + (x.outputTokens || 0) + (x.cacheReadTokens || 0)
  const second = {
    model: 'glm-5.3-flash',
    totals: { inputTokens: Math.round(totalsOf(first.totals) * 0.35), outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 1000, calls: 15, cost: 0 },
  }
  channel.models.push(second)
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    channel.totals[field] += second.totals[field]
    today.totals[field] += second.totals[field]
  }
  channel.totals.calls += second.totals.calls
  today.totals.calls += second.totals.calls

  const channelTotal = totalsOf(channel.totals)
  const expectFirst = Math.max(3, Math.round(100 * totalsOf(first.totals) / channelTotal))
  const expectSecond = Math.max(3, Math.round(100 * totalsOf(second.totals) / channelTotal))
  const shareFirst = Math.round(100 * totalsOf(first.totals) / channelTotal) + '%'
  const shareSecond = Math.round(100 * totalsOf(second.totals) / channelTotal) + '%'

  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const state = { snapshot: variant, status: 'ready', error: null }
  const localStore = { getSnapshot: () => state, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  await act(async () => {
    localRoot.render(React.createElement(UsageSectionCard, {
      store: localStore,
      poll: () => {},
      refresh: () => {},
      loadDay,
      loadRange,
      settings,
      deviceSync,
      close: () => {},
    }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 120)) })

  const rows = [...host.querySelectorAll('[data-dsh-part="channel-breakdown"] [class*="chartProvider"]')].filter(
    (row) => text(row).includes('WorkBuddy'))
  const fills = rows.flatMap((row) => [...row.querySelectorAll('[class*="chartModelFill"]')])
  const widths = fills.map((fill) => (fill.getAttribute('style') ?? '').match(/width:\s*(\d+)%/)?.[1])
  check('sub-bars sized on the channel scale, not the window',
    rows.length === 1 && widths[0] === String(expectFirst) && widths[1] === String(expectSecond),
    'widths=' + JSON.stringify(widths) + ' expected=[' + expectFirst + ',' + expectSecond + ']')
  check('sub-bar rows state their channel share',
    rows.length === 1 && text(rows[0]).includes(shareFirst) && text(rows[0]).includes(shareSecond),
    'text has ' + shareFirst + ' and ' + shareSecond)

  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- a ledger the host could not read is stated, not hidden --------------
// The numbers stay on screen (they are the best data available), so the reason
// has to be visible: a silent zero would read as "you used nothing".
{
  const variant = JSON.parse(JSON.stringify(overview))
  variant.usage.ledgerError = 'ledger unreadable (EBUSY: resource busy)'
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const state = { snapshot: variant, status: 'ready', error: null }
  const localStore = { getSnapshot: () => state, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  await act(async () => {
    localRoot.render(React.createElement(UsageSectionCard, {
      store: localStore,
      poll: () => {},
      refresh: () => {},
      loadDay,
      loadRange,
      settings,
      deviceSync,
      close: () => {},
    }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 120)) })

  const line = host.querySelector('[data-dsh-part="ledger-error"]')
  check('a ledger read failure is surfaced', line !== null && text(line).includes('EBUSY'), line === null ? 'no line' : text(line))
  check('the tiles stay rendered under it', host.querySelectorAll('[data-dsh-part="range-tiles"] button').length === 8,
    String(host.querySelectorAll('[data-dsh-part="range-tiles"] button').length))

  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- a failed poll keeps the panel, not a blank line --------------------
// The last snapshot is still the best answer available, so one dropped request
// must not replace the whole panel with an error sentence.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const state = { snapshot, status: 'error', error: 'ECONNREFUSED' }
  const localStore = { getSnapshot: () => state, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  await act(async () => {
    localRoot.render(React.createElement(UsageSectionCard, {
      store: localStore,
      poll: () => {},
      refresh: () => {},
      loadDay,
      loadRange,
      settings,
      deviceSync,
      close: () => {},
    }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 120)) })

  const line = host.querySelector('[data-dsh-part="stale-line"]')
  // The wire's own words are diagnostics; the panel states a network failure in
  // the user's language instead of echoing "ECONNREFUSED".
  check('a failed poll is stated, not fatal',
    line !== null && text(line).includes('网络请求失败') && !text(line).includes('ECONNREFUSED'),
    line === null ? 'no line' : text(line))
  check('the panel survives the failed poll',
    host.querySelectorAll('[data-dsh-part="range-tiles"] button').length === 8,
    String(host.querySelectorAll('[data-dsh-part="range-tiles"] button').length))

  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- a window whose days did not all arrive states no total -------------
// Summing the days that loaded would print a number that is simply wrong; the
// tile says "—" instead and the card carries the reason.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const state = { snapshot, status: 'ready', error: null }
  const localStore = { getSnapshot: () => state, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  const failingDay = () => Promise.reject(new Error('day fetch failed'))
  await act(async () => {
    localRoot.render(React.createElement(UsageSectionCard, {
      store: localStore,
      poll: () => {},
      refresh: () => {},
      loadDay: failingDay,
      loadRange,
      settings,
      deviceSync,
      close: () => {},
    }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 120)) })

  const tileText = (label) => {
    const tile = [...host.querySelectorAll('[data-dsh-part="range-tiles"] button')].find((button) => text(button).includes(label))
    return tile === undefined ? 'missing' : text(tile)
  }
  check('a window with missing days states no total', tileText('近 7 天').includes('—'), tileText('近 7 天'))
  check('today still states its own total', !tileText('今日').includes('—'), tileText('今日'))
  // The card must not print the sum of the days that happened to load: it is a
  // wrong number, and the tile above already says "—" for the same window.
  const weekTile = [...host.querySelectorAll('[data-dsh-part="range-tiles"] button')].find((button) => text(button).includes('近 7 天'))
  await act(async () => {
    weekTile?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 150))
  })
  const card = host.querySelector('[data-dsh-part="window-card"]')
  check('a failed window prints no totals row',
    card !== null && text(card).includes('部分日期加载失败') && !text(card).includes('总 tokens'),
    card === null ? 'no card' : text(card).slice(0, 120))

  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- refresh drops the in-flight reads too ------------------------------
// A request that started before the refresh must not settle into the caches
// with the data the refresh was meant to replace.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const state = { snapshot, status: 'ready', error: null }
  const localStore = { getSnapshot: () => state, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  const seen = new Map()
  const countingDay = (date) => {
    seen.set(date, (seen.get(date) ?? 0) + 1)
    return loadDay(date)
  }
  await act(async () => {
    localRoot.render(React.createElement(UsageSectionCard, {
      store: localStore,
      poll: () => {},
      refresh: () => {},
      loadDay: countingDay,
      loadRange,
      settings,
      deviceSync,
      close: () => {},
    }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
  const before = new Map(seen)
  const button = host.querySelector('[data-dsh-part="header"] button')
  await act(async () => {
    button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
  })
  const refetched = [...before].filter(([date, count]) => (seen.get(date) ?? 0) > count).map(([date]) => date)
  check('refresh refetches days it had already cached', refetched.length > 0,
    'refetched=' + JSON.stringify(refetched) + ' before=' + JSON.stringify([...before]))

  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- the model rows inside one channel add up to 100 % -------------------
// Rounding each row on its own made three equal models read 33+33+33 = 99.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const bucket = (calls, input) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  const today = snapshot.usage.today
  const threeModels = {
    ...snapshot,
    usage: {
      ...snapshot.usage,
      today: {
        date: today.date,
        totals: bucket(3, 300),
        providers: [{
          provider: 'buddy',
          totals: bucket(3, 300),
          models: [
            { model: 'alpha', totals: bucket(1, 100) },
            { model: 'beta', totals: bucket(1, 100) },
            { model: 'gamma', totals: bucket(1, 100) },
          ],
        }],
      },
    },
  }
  const threeState = { snapshot: threeModels, status: 'ready', error: null }
  const localStore = { getSnapshot: () => threeState, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  await act(async () => {
    localRoot.render(React.createElement(UsageSectionCard, {
      store: localStore,
      poll: () => {},
      refresh: () => {},
      loadDay,
      loadRange,
      settings,
      deviceSync,
      close: () => {},
    }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 150)) })

  const rows = [...host.querySelectorAll('[data-dsh-part="model-rows"] [title]')]
  const pcts = rows.map((row) => {
    const match = /(\d+)%$/.exec(text(row).trim())
    return match === null ? Number.NaN : Number(match[1])
  })
  check('model rows add up to 100 %',
    pcts.length === 3 && pcts.every((value) => Number.isFinite(value)) && pcts.reduce((sum, value) => sum + value, 0) === 100,
    pcts.join('+'))

  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- a custom window cannot run into the future -------------------------
// The picker's `max` only stops its own calendar: a typed or pasted date went
// straight into the window, which then counted days that have not happened.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const clampState = { snapshot, status: 'ready', error: null }
  const localStore = { getSnapshot: () => clampState, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  await act(async () => {
    localRoot.render(React.createElement(UsageSectionCard, {
      store: localStore,
      poll: () => {},
      refresh: () => {},
      loadDay,
      loadRange,
      settings,
      deviceSync,
      close: () => {},
    }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 120)) })

  const customTile = [...host.querySelectorAll('[data-dsh-part="range-tiles"] button')]
    .find((button) => text(button).includes('自定义'))
  await act(async () => {
    customTile?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 120))
  })
  const inputs = [...host.querySelectorAll('[data-dsh-part="custom-range"] input[type="date"]')]
  const future = '2099-12-31'
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(inputs[1], future)
    inputs[1].dispatchEvent(new window.Event('input', { bubbles: true }))
    inputs[1].dispatchEvent(new window.Event('change', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 150))
  })
  const today = snapshot.usage.today.date
  check('a typed future date clamps to today', inputs[1]?.value === today && inputs[0]?.value <= today,
    `from=${inputs[0]?.value} to=${inputs[1]?.value} today=${today}`)

  await act(async () => { localRoot.unmount() })
  host.remove()
}

const failed = report.filter((row) => !row.ok)
console.log('\n=== ' + (report.length - failed.length) + '/' + report.length + ' checks passed ===')
if (failed.length > 0) process.exitCode = 1
