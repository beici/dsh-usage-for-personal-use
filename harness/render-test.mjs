/**
 * Headless render test for the redesigned usage section. Mounts the built
 * client bundle (client.test.cjs, which barely differs from the shipped
 * client.js: one extra export line) inside jsdom, feeds it the saved live
 * overview + day fixtures, and asserts the window tiles / breakdown / chart
 * render the numbers we expect for 今日 / 昨日 / 近7天 / 近30天 / 自定义.
 *
 * The last section covers the client half of the accessibility audit: a hidden
 * bank tab must not paint, trend bars must not cost 30 tab stops, a hung device
 * action must time out, a failed copy must speak, and raw error text must reach
 * a keyboard user rather than only a mouse.
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

const { UsageSectionCard, TrendChart, UsageFootCard } = captured
if (typeof UsageSectionCard !== 'function') throw new Error('UsageSectionCard export missing')
if (typeof TrendChart !== 'function') throw new Error('TrendChart export missing')
if (typeof UsageFootCard !== 'function') throw new Error('UsageFootCard export missing')

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
// Every write the row attempts, so a test can tell "typed but not committed"
// from "committed and sent" — the whole point of the draft field.
const settingsCalls = []
const settings = {
  getSnapshot: () => settingsState,
  subscribe: (fn) => { settingsListeners.add(fn); return () => settingsListeners.delete(fn) },
  set: async (field, value) => { settingsCalls.push({ field, value }); return true },
}
// Device sync is fully stubbed: the card's job is the export/import wiring and
// the device list it renders, not the host's file I/O (which the host bundle
// covers on its own).
const syncCalls = []
let importAnswer = 'laptop-4f7b21'
// Set to make the next export throw, so the card's failure wording is testable.
let exportError = null
const deviceSync = {
  exportLedger: async () => {
    syncCalls.push('export')
    if (exportError !== null) throw new Error(exportError)
  },
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

// jsdom does not apply the stylesheet (the bundle carries class names, not
// rules), so the two checks that are about CSS read the source instead: a marker
// nobody can see and a rule nobody shipped look the same from the DOM.
const CLIENT_SRC = join(ROOT, 'packages/dsh-usage/src/client')
function readClient(name) { return readFileSync(join(CLIENT_SRC, name), 'utf8') }

// ---- assertions ---------------------------------------------------------
const tiles = qa('[data-dsh-part="range-tiles"] button')
check('eight range tiles', tiles.length === 8, 'got ' + tiles.length)
if (tiles.length === 8) {
  const labels = tiles.map((b) => text(b.querySelector('span')))
  check('tile order + labels', JSON.stringify(labels) === JSON.stringify(['今日', '昨日', '近 3 天', '近 7 天', '近 30 天', '近 6 个月', '全部', '自定义']), JSON.stringify(labels))
  // A narrow tile truncates its label; the full text has to stay reachable, and
  // the stylesheet's comment claimed an aria-label that never existed.
  check('a truncated tile label keeps its full text in the title',
    tiles.every((tile) => {
      const label = tile.querySelector('span')
      return label !== null && label.getAttribute('title') === text(label)
    }),
    JSON.stringify(tiles.map((tile) => String(tile.querySelector('span')?.getAttribute('title') ?? 'missing'))))
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
// Thirty focusable bars cost thirty Tab presses before the next control, and
// the group label already states the plot's summary. The bars keep their
// per-day aria-label for a screen reader's browse mode but leave the tab order.
check('trend bars are not tab stops',
  bars30.every((bar) => bar.getAttribute('tabindex') === '-1'),
  bars30.map((bar) => bar.getAttribute('tabindex')).join(','))
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
  // The tooltip repeats the hovered bar's label; exposing both would read every
  // number twice to a screen reader.
  check('the tooltip is hidden from assistive tech', tip.getAttribute('aria-hidden') === 'true',
    String(tip.getAttribute('aria-hidden')))
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
check('yesterday span prints its one day once', text(spanY) === '2026-10-19', text(spanY))
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
  // A notice that repeats the button label reads as a prompt, not as an answer:
  // the export must say it finished.
  check('a finished export says so', text(q('[data-dsh-part="device-notice"]')).startsWith('已导出'),
    text(q('[data-dsh-part="device-notice"]')))
  // And a broken export must not blame the import: one shared failure key told
  // the user whose export failed that a file they never imported was at fault.
  exportError = 'EACCES: permission denied, open usage-ledger.jsonl'
  await act(async () => { exportBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
  const exportFailed = q('[data-dsh-part="device-notice"]')
  check('a failed export blames the export, not the import',
    text(exportFailed).startsWith('导出失败') && !text(exportFailed).includes('导入'), text(exportFailed))
  // The notice interpolated the host's raw text (an errno, a path). The sentence
  // is translated now; the raw text is the title, where a diagnostic belongs.
  check('a device failure is stated in the reader\'s language',
    !text(exportFailed).includes('EACCES') && text(exportFailed).includes('请求失败'), text(exportFailed))
  check('the device failure keeps the raw text in the title',
    String(exportFailed.getAttribute('title') ?? '').includes('EACCES'),
    String(exportFailed.getAttribute('title')))
  exportError = null
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
  // The sentence is the user's language; the raw read error (a path, an errno)
  // belongs in the title, where it is a diagnostic rather than a headline.
  check('a ledger read failure is surfaced',
    line !== null && text(line).startsWith('账本读取异常') && !text(line).includes('EBUSY'),
    line === null ? 'no line' : text(line))
  check('the ledger read error stays available in the title',
    line !== null && String(line.getAttribute('title')).includes('EBUSY'),
    line === null ? 'no line' : String(line.getAttribute('title')))
  // A title is mouse-only, so the raw text also sits in a hidden description:
  // `aria-describedby` is what a screen reader or keyboard user can reach.
  check('the ledger read error is described for screen readers',
    (() => {
      const id = line?.getAttribute('aria-describedby')
      if (id === null || id === undefined) return false
      // React's `useId` produces ids like ":r1:", which `querySelector` cannot
      // take; `getElementById` is the only safe lookup for them.
      const detail = document.getElementById(id)
      return detail !== null && text(detail).includes('EBUSY') && !text(line).includes('EBUSY')
    })(),
    line === null ? 'no line' : String(line.getAttribute('aria-describedby')))
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
  // The trend chart must not paint a failed request as an empty day: those are
  // different facts and the tooltip has to say which one it is.
  // The plot is the group that carries the window summary; each bar inside it is
  // its own image with its own label, so the summary lives one level up.
  const figure = host.querySelector('[data-dsh-part="trend-chart"] [role="group"]')
  check('the trend chart names itself for screen readers',
    figure !== null && (figure.getAttribute('aria-label') ?? '').includes('用量趋势'),
    figure === null ? 'no figure' : String(figure.getAttribute('aria-label')))
  // Inside role="img" the legend's text is replaced by the label and lost; it
  // has to stay outside so each series keeps its name.
  const legend = host.querySelector('[data-dsh-part="trend-legend"]')
  check('the legend stays readable outside the image role',
    legend !== null && figure !== null && !figure.contains(legend) && text(legend).length > 0,
    legend === null ? 'no legend' : text(legend).slice(0, 60))
  const failedBars = [...host.querySelectorAll('[data-dsh-part="trend-bar"][data-failed="true"]')]
  check('a day that failed to load is marked failed, not empty', failedBars.length > 0, String(failedBars.length))
  // The marker has to be visible: a failed bar has no segments to paint, so the
  // stylesheet gives that state an outline and a hatch instead of a fill.
  const failedRule = /\.trendBar\[data-failed=['"]true['"]\]\s*\{([^}]*)\}/.exec(readClient('usage.module.css'))
  check('the failed-day marker is visible in the stylesheet',
    failedRule !== null && /outline:/.test(failedRule[1]) && /background-image:/.test(failedRule[1]),
    failedRule === null ? 'no rule' : failedRule[1].replace(/\s+/g, ' ').trim().slice(0, 80))
  // jsdom ships no stylesheet (the bundle carries class names, not rules), so
  // the shipped declarations are replayed against the rendered bar: a marker
  // that does not paint is the same as no marker.
  if (failedRule === null || failedBars.length === 0) {
    check('the failed-day marker paints on the bar', false, 'no rule or no failed bar')
  } else {
    const probe = window.document.createElement('style')
    probe.textContent = `.${failedBars[0].className}[data-failed='true'] {${failedRule[1]}}`
    window.document.head.appendChild(probe)
    const painted = window.getComputedStyle(failedBars[0]).backgroundImage
    probe.remove()
    check('the failed-day marker paints on the bar', painted !== '' && painted !== 'none', painted.slice(0, 60))
  }
  await act(async () => {
    failedBars[0]?.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 40))
  })
  const tooltip = host.querySelector('[data-dsh-part="trend-tooltip"]')
  check('a failed day says so on hover', tooltip !== null && text(tooltip).includes('加载失败'),
    tooltip === null ? 'no tooltip' : text(tooltip))

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

// ---- a model keeps its hue when the window changes ----------------------
// The palette slot is a function of the model name alone. It used to be "the
// next free slot", so a window that did not contain the heaviest model
// recolored everyone else — the docs promise the opposite.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const bucket = (calls, input) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  const today = snapshot.usage.today
  const windowWith = (models) => ({
    ...snapshot,
    usage: {
      ...snapshot.usage,
      today: {
        date: today.date,
        totals: bucket(models.length, models.length * 100),
        providers: [{ provider: 'buddy', totals: bucket(models.length, models.length * 100), models: models.map((model) => ({ model, totals: bucket(1, 100) })) }],
      },
    },
  })
  const state = { snapshot: windowWith(['alpha', 'beta']), status: 'ready', error: null }
  const localStore = { getSnapshot: () => state, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  const fillOf = (model) => {
    const row = [...host.querySelectorAll('[data-dsh-part="model-rows"] [title]')].find((node) => text(node).includes(model))
    const fill = row?.querySelector('[class*="chartModelFill"]')
    return fill === undefined || fill === null ? 'missing' : String(fill.getAttribute('style'))
  }
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
  const betaWithAlpha = fillOf('beta')
  state.snapshot = windowWith(['beta'])
  await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
  const betaAlone = fillOf('beta')
  check('a model keeps its hue when the window changes', betaAlone !== 'missing' && betaAlone === betaWithAlpha, `${betaWithAlpha} vs ${betaAlone}`)

  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- an unknown plan window key is spelled out, never printed raw --------
// Providers name their windows inconsistently (`5h`, `week`, `7_day`). The
// dictionary knows a few; an unknown one used to reach the panel verbatim.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const bucket = (calls, input) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  const planSnapshot = {
    ...snapshot,
    providers: [{
      provider: 'codex',
      displayName: 'Codex',
      credential: 'stored',
      planSupported: true,
      updatedAt: Date.now(),
      totals: bucket(1, 100),
      plan: { planName: 'Pro', updatedAt: Date.now(), windows: [{ key: '7_day', percent: 40 }, { key: '5h', percent: 95 }] },
    }],
  }
  const planState = { snapshot: planSnapshot, status: 'ready', error: null }
  const localStore = { getSnapshot: () => planState, subscribe: () => () => {} }
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
  const plansTab = [...host.querySelectorAll('[role="tab"]')].find((tab) => text(tab).includes('个人套餐'))
  await act(async () => {
    plansTab?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 120))
  })
  const planText = text(host)
  check('an unknown plan window key is spelled out', planText.includes('7 天') && !planText.includes('usage.plan.windows.7_day'), planText.slice(0, 120))
  // The tone classes used to REPLACE the fill class, and only the fill class
  // carried `height: 100%` — so the bar vanished exactly in the warn/low band
  // it exists to warn about. Every fill now carries the geometry class and the
  // tone class on top of it.
  const fills = [...host.querySelectorAll('[data-dsh-part="plan-card"] [class*="barFill"]')]
  const classesOf = (element) => String(element.className)
  check('a plan bar keeps the fill geometry in the warn band',
    fills.length === 2 && fills.every((fill) => classesOf(fill).includes('barFill')), String(fills.length))
  check('a plan bar below the warn band stays neutral',
    fills[0] !== undefined && !classesOf(fills[0]).includes('barWarn') && !classesOf(fills[0]).includes('barLow'),
    fills[0] === undefined ? 'no bar' : classesOf(fills[0]))
  check('a plan bar above the low band carries both classes',
    fills[1] !== undefined && classesOf(fills[1]).includes('barFill') && classesOf(fills[1]).includes('barLow'),
    fills[1] === undefined ? 'no bar' : classesOf(fills[1]))
  const barCss = readClient('usage.module.css')
  const fillRule = /\.barFill\s*\{([^}]*)\}/.exec(barCss)
  check('the fill class is the one that carries the height',
    fillRule !== null && /height:\s*100%/.test(fillRule[1]), fillRule === null ? 'no rule' : fillRule[1].trim())

  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- the plan card states a provider failure in the reader's language ----
// The card interpolated the provider's raw error, so a 503 reached the reader as
// a wire string. The sentence is translated now and the raw text is the title,
// the same split the balance card uses.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const raw = 'usage api/dsh-usage/plan failed: 503'
  const errorSnapshot = {
    ...snapshot,
    providers: [{
      provider: 'codex',
      displayName: 'Codex',
      credential: 'stored',
      planSupported: true,
      updatedAt: Date.now(),
      totals: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 1, cost: 0 },
      error: raw,
    }],
  }
  const errorState = { snapshot: errorSnapshot, status: 'ready', error: null }
  const localStore = { getSnapshot: () => errorState, subscribe: () => () => {} }
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
  const plansTab = [...host.querySelectorAll('[role="tab"]')].find((tab) => text(tab).includes('个人套餐'))
  await act(async () => {
    plansTab?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 120))
  })
  const errorLine = host.querySelector('[data-dsh-part="plan-card"] [class*="errorLine"]')
  check('a plan failure is translated',
    errorLine !== null && text(errorLine).includes('请求失败（HTTP 503）') && !text(errorLine).includes('usage api'),
    errorLine === null ? 'no error line' : text(errorLine))
  check('the plan failure keeps the wire text in the title',
    errorLine !== null && String(errorLine.getAttribute('title') ?? '').includes('failed: 503'),
    errorLine === null ? 'no error line' : String(errorLine.getAttribute('title')))
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

// ---- a window with nothing to fetch is loaded, not loading --------------
// A ledger that only holds today gives the 全部 window a span ending before it
// starts: there is nothing to ask the host for. That window is empty, not
// pending — a pending tile shows "…" forever, which is what it used to do.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const todayOnly = {
    ...snapshot,
    usage: { ...snapshot.usage, availableDays: [snapshot.usage.today.date] },
  }
  const state = { snapshot: todayOnly, status: 'ready', error: null }
  const localStore = { getSnapshot: () => state, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  const asked = []
  await act(async () => {
    localRoot.render(React.createElement(UsageSectionCard, {
      store: localStore,
      poll: () => {},
      refresh: () => {},
      loadDay,
      loadRange: (from, to) => { asked.push(from + ':' + to); return loadRange(from, to) },
      settings,
      deviceSync,
      close: () => {},
    }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
  const tileOf = (label) => {
    const tile = [...host.querySelectorAll('[data-dsh-part="range-tiles"] button')].find((button) => text(button).includes(label))
    return tile === undefined ? 'missing' : text(tile)
  }
  const allTile = tileOf('全部')
  check('a window with nothing to fetch states a total, not a spinner',
    !allTile.includes('…') && /\d/.test(allTile), allTile)
  // The span ends before it starts, so there is no request to make: the tile
  // reads the live day and the window is done.
  const degenerate = snapshot.usage.today.date + ':' + snapshot.usage.today.date
  check('a today-only ledger sends no range request for 全部', !asked.includes(degenerate), JSON.stringify(asked))

  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- a failed aggregate paints no empty days and states no total --------
// One failed range request used to paint a full row of "no records" bars while
// the aria label still claimed a total, and the card echoed the internal route
// (`usage api/dsh-usage/range?from=… failed: 500`) at the user.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const rawError = 'usage api/dsh-usage/range?from=2026-04-25&to=2026-10-19 failed: 500'
  const state = { snapshot, status: 'ready', error: null }
  const localStore = { getSnapshot: () => state, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  await act(async () => {
    localRoot.render(React.createElement(UsageSectionCard, {
      store: localStore,
      poll: () => {},
      refresh: () => {},
      loadDay,
      loadRange: async () => { throw new Error(rawError) },
      settings,
      deviceSync,
      close: () => {},
    }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
  const halfYear = [...host.querySelectorAll('[data-dsh-part="range-tiles"] button')]
    .find((button) => text(button).includes('近 6 个月'))
  await act(async () => {
    halfYear?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 150))
  })

  // A window that failed wholesale has nothing to plot. It used to draw one
  // full-height hatched bar per bucket — 27 of them here — a wall of stripes that
  // reads as data, so the plot states the failure once instead of drawing it.
  const bars = [...host.querySelectorAll('[data-dsh-part="trend-bar"]')]
  const failedNotice = host.querySelector('[data-dsh-part="trend-failed"]')
  check('a failed aggregate draws no confident empty day', bars.length === 0,
    'bars=' + bars.length)
  check('a failed aggregate states the failure in the plot instead of drawing bars',
    failedNotice !== null && text(failedNotice).includes('加载失败') && bars.length === 0,
    failedNotice === null ? 'no notice' : text(failedNotice))
  const figure = host.querySelector('[data-dsh-part="trend-chart"] [role="group"]')
  const label = String(figure?.getAttribute('aria-label') ?? '')
  check('a failed aggregate states no total in the aria label',
    figure !== null && label.includes('部分日期加载失败') && !label.includes('合计'), label)
  const card = host.querySelector('[data-dsh-part="window-card"]')
  const notice = card === null ? null : card.querySelector('[role="status"]')
  check('a transport error is stated in the user\'s language',
    notice !== null && text(notice).includes('请求失败（HTTP 500）') && !text(notice).includes('usage api'),
    notice === null ? 'no notice' : text(notice))
  // The route and the code still have to be reachable for a bug report — they
  // live in the title, not in the sentence.
  check('the raw transport text stays in the title',
    notice !== null && String(notice.getAttribute('title') ?? '').includes('failed: 500'),
    notice === null ? 'no notice' : String(notice.getAttribute('title')))
  // A title is mouse-only. The same text has to sit in a described-by sibling,
  // which is what a screen reader reads after the sentence.
  const describedBy = notice === null ? null : window.document.getElementById(String(notice.getAttribute('aria-describedby') ?? ''))
  check('the range failure exposes its wire text to assistive tech',
    describedBy !== null && text(describedBy) === rawError && String(describedBy.className).includes('srOnly'),
    describedBy === null ? 'no described-by target' : text(describedBy))

  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- a poll re-reads the history it cached -------------------------------
// The day cache and the range cache were keyed by date and span alone, so a host
// rescan that moved a past day never reached a window already fetched: after one
// poll the wide windows grew (their spans start at the ledger's oldest day) while
// 近 6 个月 kept its old total. Both caches carry the history stamp they were read
// from now, and a stamp that moved drops them.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const backfill = { inputTokens: 10000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 1, cost: 0 }
  const withBackfill = (totals) => {
    const next = { ...totals }
    for (const key of Object.keys(next)) next[key] += backfill[key] ?? 0
    return next
  }
  // One past day and the all-time total move together, the way a rescan reports it.
  const rescan = {
    ...snapshot,
    updatedAt: snapshot.updatedAt + 60000,
    usage: {
      ...snapshot.usage,
      days: snapshot.usage.days.map((row) => (row.date === '2026-10-19' ? { ...row, totals: withBackfill(row.totals) } : row)),
      all: snapshot.usage.all === undefined ? undefined : { ...snapshot.usage.all, totals: withBackfill(snapshot.usage.all.totals) },
    },
  }
  let current = snapshot
  let state = { snapshot: current, status: 'ready', error: null }
  const storeListeners = new Set()
  const localStore = {
    // A fresh object per publish: useSyncExternalStore skips a notification whose
    // snapshot is referentially unchanged.
    getSnapshot: () => state,
    subscribe: (fn) => { storeListeners.add(fn); return () => storeListeners.delete(fn) },
  }
  const publish = (next) => {
    current = next
    state = { snapshot: next, status: 'ready', error: null }
    for (const listener of storeListeners) listener()
  }
  // The backfilled day answers with the new totals once the host has rescanned.
  const bumpedDay = async (date) => {
    const day = await loadDay(date)
    return current === rescan && date === '2026-10-19' ? { ...day, totals: withBackfill(day.totals) } : day
  }
  const start = rangeCalls.length
  const localRoot = ReactDOMClient.createRoot(host)
  await act(async () => {
    localRoot.render(React.createElement(UsageSectionCard, {
      store: localStore,
      poll: () => { publish(current) },
      refresh: () => {},
      loadDay: bumpedDay,
      loadRange,
      settings,
      deviceSync,
      close: () => {},
    }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
  const tileOf = (label) => [...host.querySelectorAll('[data-dsh-part="range-tiles"] button')]
    .find((button) => text(button).includes(label))
  // Warm the day cache for yesterday before the ledger moves.
  await act(async () => {
    tileOf('昨日')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
  })
  const yesterdayBefore = text(tileOf('昨日') ?? host)
  const warm = [...new Set(rangeCalls.slice(start))]
  const warmCounts = warm.map((key) => rangeCalls.slice(start).filter((entry) => entry === key).length)

  await act(async () => {
    publish(rescan)
    await new Promise((r) => setTimeout(r, 300))
  })
  const after = rangeCalls.slice(start)
  const reread = warm.filter((key, index) => after.filter((entry) => entry === key).length > warmCounts[index])
  check('a poll re-reads the cached aggregates the ledger moved',
    warm.length > 0 && reread.length === warm.length,
    'warm=' + warm.join(' ') + ' reread=' + reread.join(' '))
  const yesterdayAfter = text(tileOf('昨日') ?? host)
  check('a poll re-reads a cached past day the ledger moved',
    yesterdayAfter !== yesterdayBefore && !yesterdayAfter.includes('…'),
    'before=' + yesterdayBefore + ' after=' + yesterdayAfter)

  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- the retry budget recovers when the ledger moves ---------------------
// A failed window retried five times with a capped backoff and then stopped for
// good: the counter only reset when a load succeeded, so a panel left open
// through a host restart sat at "—" after the host was healthy again. The budget
// refills on a real recovery signal now — a successful load, or a ledger history
// that moved — and never on `updatedAt`, which the host stamps on every answer.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  let state = { snapshot, status: 'ready', error: null }
  const storeListeners = new Set()
  const localStore = {
    getSnapshot: () => state,
    subscribe: (fn) => { storeListeners.add(fn); return () => storeListeners.delete(fn) },
  }
  const realSetTimeout = window.setTimeout
  const realClearTimeout = window.clearTimeout
  // The card waits on window.setTimeout for its backoff (10s, 20s, 40s, 80s,
  // 120s). Capturing the callbacks lets the test walk the ladder rung by rung;
  // firing them at once ran the whole ladder inside one render pass, so the
  // re-render between rungs never happened and only the first rung landed.
  const pending = new Map()
  let nextId = 0
  window.setTimeout = (callback) => {
    if (typeof callback !== 'function') return 0
    nextId += 1
    pending.set(nextId, callback)
    return nextId
  }
  window.clearTimeout = (id) => { pending.delete(id) }
  const drain = async () => {
    let guard = 0
    while (pending.size > 0 && guard < 40) {
      const due = [...pending.values()]
      pending.clear()
      for (const callback of due) {
        await act(async () => {
          callback()
          await new Promise((r) => setTimeout(r, 60))
        })
      }
      guard += 1
    }
  }
  // The dead endpoint counts its own attempts: the harness's loadRange records
  // into rangeCalls, and this block replaces it.
  const attempts = []
  const deadRange = async (from, to) => {
    attempts.push(from + ':' + to)
    throw new Error('usage api/dsh-usage/range failed: 500')
  }
  const localRoot = ReactDOMClient.createRoot(host)
  try {
    await act(async () => {
      localRoot.render(React.createElement(UsageSectionCard, {
        store: localStore,
        poll: () => {},
        refresh: () => {},
        loadDay,
        loadRange: deadRange,
        settings,
        deviceSync,
        close: () => {},
      }))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
    await drain()
    const capped = attempts.length
    // Another poll must not reopen a spent budget.
    await act(async () => {
      document.dispatchEvent(new window.Event('visibilitychange'))
      await new Promise((r) => setTimeout(r, 200))
    })
    await drain()
    const stillCapped = attempts.length
    check('a failing window stops retrying at its budget',
      capped > 2 && stillCapped === capped, 'capped=' + capped + ' later=' + stillCapped)
    // A newer overview is NOT recovery: the host stamps `updatedAt` with the
    // current time on every answer, so a poll that changed nothing used to look
    // like recovery, reopen a spent budget and restart the ladder forever.
    state = { snapshot: { ...state.snapshot, updatedAt: state.snapshot.updatedAt + 60000 }, status: 'ready', error: null }
    await act(async () => {
      for (const listener of storeListeners) listener()
      await new Promise((r) => setTimeout(r, 200))
    })
    await drain()
    check('a newer overview stamp does not reopen a spent budget',
      attempts.length === stillCapped, 'capped=' + stillCapped + ' after=' + attempts.length)
    // The history moving IS recovery: a peer import or a backfill changed the
    // answer, so the window deserves one more chain. (The stamp change alone
    // re-reads the two range windows once; a refill walks the whole ladder.)
    const moved = JSON.parse(JSON.stringify(state.snapshot))
    moved.usage.availableDays = [...moved.usage.availableDays, '2026-01-05']
    state = { snapshot: moved, status: 'ready', error: null }
    await act(async () => {
      for (const listener of storeListeners) listener()
      await new Promise((r) => setTimeout(r, 200))
    })
    await drain()
    check('a moved ledger history refills the retry budget',
      attempts.length > stillCapped + 2, 'capped=' + stillCapped + ' after=' + attempts.length)
  } finally {
    window.setTimeout = realSetTimeout
    window.clearTimeout = realClearTimeout
    await act(async () => { localRoot.unmount() })
    host.remove()
  }
}

// ---- a retry keeps the numbers it already has ---------------------------
// Refreshing a window whose refetch fails used to blank every tile back to "…"
// for the duration, though the numbers on screen were still the best answer.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const state = { snapshot, status: 'ready', error: null }
  const localStore = { getSnapshot: () => state, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  let gated = false
  const pending = []
  const gatedDay = (date) => {
    if (!gated) return loadDay(date)
    return new Promise((resolve, reject) => { pending.push(reject) })
  }
  await act(async () => {
    localRoot.render(React.createElement(UsageSectionCard, {
      store: localStore,
      poll: () => {},
      refresh: () => {},
      loadDay: gatedDay,
      loadRange,
      settings,
      deviceSync,
      close: () => {},
    }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
  const tileOf = (label) => {
    const tile = [...host.querySelectorAll('[data-dsh-part="range-tiles"] button')].find((button) => text(button).includes(label))
    return tile === undefined ? 'missing' : text(tile)
  }
  const before = tileOf('近 7 天')
  check('the tile states a total before the refresh', !before.includes('…') && /\d/.test(before), before)

  gated = true
  const button = host.querySelector('[data-dsh-part="header"] button')
  await act(async () => {
    button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 80))
  })
  const during = tileOf('近 7 天')
  check('a retry keeps the previous total instead of resetting to "…"',
    !during.includes('…') && during === before, `${before} -> ${during}`)

  await act(async () => {
    for (const reject of pending) reject(new Error('day fetch failed'))
    await new Promise((r) => setTimeout(r, 150))
  })
  const after = tileOf('近 7 天')
  check('a failed retry ends at "—" and says why', after.includes('—'), after)
  // A dead endpoint must not be hammered forever: the delay doubles between
  // tries and the attempt count is capped. The timer is minutes long, so this
  // is a source guard rather than a wall-clock one.
  const cardSource = readClient('UsageSectionCard.tsx')
  check('the retry loop backs off and gives up',
    /RETRY_MAX_ATTEMPTS = 5\b/.test(cardSource) && /2 \*\* retryAttempts\.current/.test(cardSource) && /RETRY_BACKOFF_MAX_MS/.test(cardSource),
    'cap=' + (/RETRY_MAX_ATTEMPTS = (\d+)/.exec(cardSource)?.[1] ?? 'missing'))

  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- a failed range refetch keeps the answer it already has --------------
// The failure branch replaced the load with `{ status: 'error' }`, dropping the
// summary and series on screen, so a refresh that failed blanked 全部 even though
// the previous aggregate was still the best answer on hand. The day path kept
// its numbers; the range path keeps them now.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  let failRange = false
  const flakyRange = async (from, to) => {
    if (failRange) throw new Error('usage api/dsh-usage/range?from=' + from + '&to=' + to + ' failed: 500')
    return loadRange(from, to)
  }
  const state = { snapshot, status: 'ready', error: null }
  const localStore = { getSnapshot: () => state, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  await act(async () => {
    localRoot.render(React.createElement(UsageSectionCard, {
      store: localStore,
      poll: () => {},
      refresh: () => {},
      loadDay,
      loadRange: flakyRange,
      settings,
      deviceSync,
      close: () => {},
    }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
  const tileOf = (label) => [...host.querySelectorAll('[data-dsh-part="range-tiles"] button')]
    .find((button) => text(button).includes(label))
  await act(async () => {
    tileOf('全部')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 250))
  })
  const totalsRow = () => host.querySelector('[data-dsh-part="window-totals"]')
  const statValues = () => [...host.querySelectorAll('[data-dsh-part="window-totals"] [class*="statValue"]')]
  const beforeCells = statValues().length
  const beforeText = text(totalsRow())
  check('the range window states its total before the refetch',
    beforeCells === 6, 'cells=' + beforeCells + ' row=' + beforeText)
  failRange = true
  await act(async () => {
    host.querySelector('[data-dsh-part="header"] button')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))
  })
  check('a failed range refetch keeps the numbers on screen',
    statValues().length === beforeCells && text(totalsRow()) === beforeText,
    'cells=' + statValues().length + ' row=' + text(totalsRow()))
  check('a failed range refetch keeps the series on screen',
    host.querySelector('[data-dsh-part="trend-failed"]') === null,
    String(host.querySelectorAll('[data-dsh-part="trend-bar"]').length) + ' bars')
  check('a failed range refetch still says it failed',
    text(host).includes('部分日期加载失败'), text(host).slice(0, 160))

  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- the tablist follows the pattern assistive tech expects -------------
// ids, aria-controls, one tabpanel per tab, a roving tabindex and arrow keys:
// the panel used to be three buttons with aria-selected and nothing else.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const state = { snapshot, status: 'ready', error: null }
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
  await act(async () => { await new Promise((r) => setTimeout(r, 150)) })

  const tabs = [...host.querySelectorAll('[role="tab"]')]
  const selected = () => tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')
  const panel = () => host.querySelector('[role="tabpanel"]:not([hidden])')
  check('every tab names the panel it opens',
    tabs.length === 3 && tabs.every((tab) => tab.id !== '' && (tab.getAttribute('aria-controls') ?? '') !== ''),
    tabs.map((tab) => tab.id + '->' + tab.getAttribute('aria-controls')).join(', '))
  check('the open panel is labelled by its tab',
    panel() !== null && panel().getAttribute('aria-labelledby') === selected()?.id && panel().id === selected()?.getAttribute('aria-controls'),
    panel() === null ? 'no panel' : String(panel().getAttribute('aria-labelledby')))
  check('only the selected tab is in the tab order',
    tabs.every((tab) => tab.getAttribute('tabindex') === (tab === selected() ? '0' : '-1')),
    tabs.map((tab) => tab.getAttribute('tabindex')).join(','))
  // Every tab's aria-controls has to name an element that exists: the unselected
  // panels used to be unmounted, so two of the three ids pointed at nothing and
  // the tablist described a page that was not there.
  const panels = [...host.querySelectorAll('[role="tabpanel"]')]
  check('every tab controls a panel that exists',
    panels.length === 3 && tabs.every((tab) => panels.some((node) => node.id === tab.getAttribute('aria-controls'))),
    'panels=' + panels.length + ' ids=' + panels.map((node) => node.id).join(','))
  check('only the open panel is shown',
    panels.filter((node) => !node.hasAttribute('hidden')).length === 1 && panel() !== null,
    'shown=' + panels.filter((node) => !node.hasAttribute('hidden')).length)

  await act(async () => {
    selected()?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await new Promise((r) => setTimeout(r, 80))
  })
  check('ArrowRight moves focus and selection together',
    selected() === tabs[1] && window.document.activeElement === tabs[1],
    'selected=' + text(selected()) + ' focused=' + text(window.document.activeElement))
  await act(async () => {
    selected()?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await new Promise((r) => setTimeout(r, 80))
  })
  check('End jumps to the last tab', selected() === tabs[2], text(selected()))
  await act(async () => {
    selected()?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    await new Promise((r) => setTimeout(r, 80))
  })
  check('Home jumps back to the first tab', selected() === tabs[0], text(selected()))

  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- the custom picker cannot start before the ledger does --------------
// The `max` stopped a future day, but nothing stopped a date the ledger has no
// records for, so the window counted days the host never recorded.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const state = { snapshot, status: 'ready', error: null }
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
  const customTile = [...host.querySelectorAll('[data-dsh-part="range-tiles"] button')]
    .find((button) => text(button).includes('自定义'))
  await act(async () => {
    customTile?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 120))
  })
  const inputs = [...host.querySelectorAll('[data-dsh-part="custom-range"] input[type="date"]')]
  const oldest = snapshot.usage.availableDays[0]
  check('the from-date input starts at the oldest recorded day',
    inputs[0]?.getAttribute('min') === oldest, `min=${inputs[0]?.getAttribute('min')} oldest=${oldest}`)
  // `min` binds the calendar picker, not a typed value: the handler has to clamp
  // what it is handed, or a window runs into days that have not happened yet and
  // today's usage lands in them. A start *before* the ledger is deliberately kept:
  // the picker's `min` already blocks it there, and rewriting dates the user typed
  // would answer a different question than the one asked.
  await act(async () => {
    const input = host.querySelector('[data-dsh-part="custom-range"] input[type="date"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, '2099-01-01')
    input?.dispatchEvent(new window.Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 120))
  })
  const clampedFrom = host.querySelector('[data-dsh-part="custom-range"] input[type="date"]')
  check('a from-date past today is clamped to today',
    clampedFrom?.value === snapshot.usage.today.date, `value=${clampedFrom?.value}`)
  await act(async () => {
    const input = host.querySelector('[data-dsh-part="custom-range"] input[type="date"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, '2026-09-01')
    input?.dispatchEvent(new window.Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 120))
  })
  const earlyFrom = host.querySelector('[data-dsh-part="custom-range"] input[type="date"]')
  check('a from-date before the ledger is kept as typed', earlyFrom?.value === '2026-09-01',
    `value=${earlyFrom?.value}`)
  await act(async () => { localRoot.unmount() })

  // `availableDays` lists the days THIS machine recorded; 全部 and the range
  // totals cover the merged ledger, so its start is `usage.all.from`. A peer
  // export whose history starts earlier was unreachable from the picker and
  // understated by 全部.
  const merged = JSON.parse(JSON.stringify(snapshot))
  merged.usage.availableDays = ['2026-10-19', '2026-10-20']
  merged.usage.all.from = '2026-09-01'
  const mergedState = { snapshot: merged, status: 'ready', error: null }
  const mergedStore = { getSnapshot: () => mergedState, subscribe: () => () => {} }
  const mergedRoot = ReactDOMClient.createRoot(host)
  await act(async () => {
    mergedRoot.render(React.createElement(UsageSectionCard, {
      store: mergedStore,
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
  const mergedTile = [...host.querySelectorAll('[data-dsh-part="range-tiles"] button')]
    .find((button) => text(button).includes('自定义'))
  await act(async () => {
    mergedTile?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 120))
  })
  const mergedInput = host.querySelector('[data-dsh-part="custom-range"] input[type="date"]')
  check('the from-date input reaches back to the merged ledger',
    mergedInput?.getAttribute('min') === '2026-09-01', `min=${mergedInput?.getAttribute('min')}`)
  check('全部 asks the host for the merged span',
    rangeCalls.includes('2026-09-01:2026-10-19'), rangeCalls.slice(-3).join(' '))

  await act(async () => { mergedRoot.unmount() })
  host.remove()
}

// ---- the ledger note is the host's text, once ---------------------------
// The host owns the note; the panel only prints it, so a note that arrives
// again with the next snapshot must not be concatenated into itself.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const note = '首次导入：2026-09-21；补录：2026-09-22'
  const withNote = (text) => ({ ...snapshot, usage: { ...snapshot.usage, ledgerNote: text } })
  const state = { snapshot: withNote(note), status: 'ready', error: null }
  const listeners = new Set()
  const localStore = {
    getSnapshot: () => state,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
  }
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
  const noteLine = () => host.querySelector('[data-dsh-part="ledger-note"]')
  check('the ledger note prints the host text once', text(noteLine()) === '说明：' + note, text(noteLine()))
  await act(async () => {
    state.snapshot = withNote(note)
    for (const fn of listeners) fn()
    await new Promise((r) => setTimeout(r, 80))
  })
  check('a republished note does not accumulate', text(noteLine()) === '说明：' + note, text(noteLine()))

  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- two models in one palette slot stay distinguishable ----------------
// Sixteen hues are not enough for every name: two names that hash to the same
// slot used to share a color exactly, so two sub-bars of one channel looked
// like one. The shade axis keeps them apart without moving anyone else. The
// rung is a hash of the name now, not an arrival counter, so the pair has to be
// picked with two different rungs — otherwise this would be asserting a
// collision rather than a distinction.
// The palette is a pure function, so the tests read it from the TypeScript
// source (Node's type stripping) instead of waiting for a bundle.
const palette = await import(new URL('../packages/dsh-usage/src/client/model-colors.ts', import.meta.url).href)
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  // The slot and rung functions are reimplemented here so the fixture is not a
  // magic pair: the test finds two names that really do land in one slot.
  const fnv = (name) => {
    let hash = 0x811c9dc5
    for (let at = 0; at < name.length; at += 1) {
      hash ^= name.charCodeAt(at)
      hash = Math.imul(hash, 0x01000193)
    }
    return hash >>> 0
  }
  const slotOf = (name) => fnv(name) % 16
  const rungOf = (name) => (fnv(name) >>> 5) % 5
  const bySlot = new Map()
  let pair
  for (let index = 0; index < 400 && pair === undefined; index += 1) {
    const name = 'slotprobe-' + index + '.'
    const slot = slotOf(name)
    const taken = bySlot.get(slot)
    if (taken === undefined) bySlot.set(slot, name)
    else if (rungOf(taken) !== rungOf(name)) pair = [taken, name]
  }
  // A model's shade must not depend on which other models the window happens to
  // contain: 近 7 天 and 近 30 天 are two different model sets, and the same model
  // used to change color between them because the rung was an arrival counter.
  const wide = palette.assignModelColors(['alpha.', 'beta.', 'gamma.'])
  const narrow = palette.assignModelColors(['beta.'])
  check('a model keeps its shade when the window model set changes',
    wide.get('beta.') !== undefined && wide.get('beta.') === narrow.get('beta.'),
    `${wide.get('beta.')} vs ${narrow.get('beta.')}`)
  const reversed = palette.assignModelColors(['gamma.', 'beta.', 'alpha.'])
  check('the shade does not depend on the order models arrive',
    reversed.get('alpha.') === wide.get('alpha.') && reversed.get('gamma.') === wide.get('gamma.'),
    `${wide.get('alpha.')}/${reversed.get('alpha.')} ${wide.get('gamma.')}/${reversed.get('gamma.')}`)
  const bucket = (calls, input) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  const models = pair === undefined ? [] : pair.map((model) => ({ model, totals: bucket(1, 100) }))
  const collided = {
    ...snapshot,
    usage: {
      ...snapshot.usage,
      today: {
        date: snapshot.usage.today.date,
        totals: bucket(2, 200),
        providers: [{ provider: 'buddy', totals: bucket(2, 200), models }],
      },
    },
  }
  const state = { snapshot: collided, status: 'ready', error: null }
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
  await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
  const fillOf = (model) => {
    const row = [...host.querySelectorAll('[data-dsh-part="model-rows"] [title]')].find((node) => text(node).includes(model))
    const fill = row?.querySelector('[class*="chartModelFill"]')
    return fill === undefined || fill === null ? 'missing' : String(fill.getAttribute('style'))
  }
  const first = pair === undefined ? 'missing' : fillOf(pair[0])
  const second = pair === undefined ? 'missing' : fillOf(pair[1])
  check('two names in one palette slot get different colors',
    first !== 'missing' && second !== 'missing' && first !== second,
    `${pair?.[0] ?? '?'}=${first} | ${pair?.[1] ?? '?'}=${second}`)
  // The palette is emitted as a measured color, not as one of the 17
  // --dsw-chart-* color-mix knobs the stylesheet used to carry.
  check('a model color is a measured color, not a css variable',
    first !== 'missing' && second !== 'missing' && !String(first).includes('var(') && !String(second).includes('var('),
    `${first} | ${second}`)

  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- the palette is legible on both skins --------------------------------
// The shades used to be a color-mix toward white or black: the ends of that ramp
// measured 1.40:1 on the white card and 2.29:1 on the dark one, and two rungs of
// one slot sat 1.36 apart in RGB — invisible as a difference. The ladder is cut
// from measured luminance now, so the same numbers are asserted here.
{
  const channelsOf = (hex) => {
    const value = Number.parseInt(String(hex).slice(1), 16)
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
  }
  const channel = (value) => {
    const scaled = value / 255
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  const luminanceOf = (rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
  const contrastOf = (a, b) => {
    const high = Math.max(luminanceOf(a), luminanceOf(b))
    const low = Math.min(luminanceOf(a), luminanceOf(b))
    return (high + 0.05) / (low + 0.05)
  }
  const distanceOf = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
  const hashOf = (name) => {
    let hash = 0x811c9dc5
    for (let index = 0; index < name.length; index += 1) {
      hash ^= name.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    return hash >>> 0
  }
  // Every shade of every slot, from a probe wide enough that each slot shows all
  // five. Two names may share a rung (the rung is a hash of the name, so a
  // collision is stable rather than shifting), so the colors are deduplicated:
  // the property under test is that the SHADES of one slot are told apart.
  const slots = new Map()
  for (let index = 0; index < 4000; index += 1) {
    const name = 'legible-' + index + '.'
    const slot = hashOf(name) % 16
    const group = slots.get(slot) ?? new Map()
    const color = palette.assignModelColors([name]).get(name)
    if (color !== undefined) group.set(color, name)
    slots.set(slot, group)
  }
  const light = channelsOf('#ffffff')
  const dark = channelsOf('#16171a')
  // The card paints no background, so the real surface is the host's. These are
  // the lightest dark surfaces the host themes use — the worst case for a mid
  // tone, because a lighter surface lowers the contrast of a darker bar.
  const plausibleDark = ['#1b1c20', '#202124'].map(channelsOf)
  let worstLight = Infinity
  let worstDark = Infinity
  let worstPlausible = Infinity
  let closest = Infinity
  let shades = 0
  for (const group of slots.values()) {
    const colors = [...group.keys()]
    shades += colors.length
    for (const color of colors) {
      const rgb = channelsOf(color)
      worstLight = Math.min(worstLight, contrastOf(rgb, light))
      worstDark = Math.min(worstDark, contrastOf(rgb, dark))
      for (const surface of plausibleDark) worstPlausible = Math.min(worstPlausible, contrastOf(rgb, surface))
    }
    for (let a = 0; a < colors.length; a += 1) {
      for (let b = a + 1; b < colors.length; b += 1) {
        closest = Math.min(closest, distanceOf(channelsOf(colors[a]), channelsOf(colors[b])))
      }
    }
  }
  check('every model color clears 3:1 on the light card', worstLight >= 3, worstLight.toFixed(2))
  check('every model color clears 3:1 on the dark card', worstDark >= 3, worstDark.toFixed(2))
  check('every model color clears 3:1 on the lightest plausible dark surface',
    worstPlausible >= 3, worstPlausible.toFixed(2))
  check('the rungs of one palette slot are told apart', closest >= 16, String(closest))
  check('every slot reaches all five shades', shades >= 16 * 5, String(shades))
  check('the other-models color is legible on both skins',
    contrastOf(channelsOf(palette.MODEL_COLOR_OTHER), light) >= 3 && contrastOf(channelsOf(palette.MODEL_COLOR_OTHER), dark) >= 3,
    palette.MODEL_COLOR_OTHER)
  check('the other-models color clears the lightest plausible dark surface',
    plausibleDark.every((surface) => contrastOf(channelsOf(palette.MODEL_COLOR_OTHER), surface) >= 3),
    palette.MODEL_COLOR_OTHER)
}

// ---- the poll interval takes a typed value -------------------------------
// The field was controlled straight by the settings snapshot and only wrote a
// value already inside 30..3600, so typing "120" over "60" reverted on the first
// keystroke ("1") and Delete (empty, which parses to 0) was rejected as well: the
// number could not be changed by hand at all. It keeps a draft string now and
// commits on blur or Enter.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const localRoot = ReactDOMClient.createRoot(host)
  const before = settingsCalls.length
  const setValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  await act(async () => {
    localRoot.render(React.createElement(UsageSectionCard, {
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
  await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
  const input = host.querySelector('[data-dsh-part="settings-row"] input[type="number"]')
  check('the poll-interval field renders', input !== null)
  if (input !== null) {
    await act(async () => { setValue(input, '120') })
    check('typing an interval keeps the draft and writes nothing',
      settingsCalls.length === before && input.value === '120',
      'calls=' + (settingsCalls.length - before) + ' value=' + input.value)
    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise((r) => setTimeout(r, 50))
    })
    const committed = settingsCalls.slice(before)
    check('Enter commits the typed interval',
      committed.length === 1 && committed[0].field === 'pollIntervalSec' && committed[0].value === 120,
      JSON.stringify(committed))
    await act(async () => { setValue(input, '') })
    check('an emptied interval is allowed while typing',
      input.value === '' && settingsCalls.length === before + 1,
      'value=' + input.value + ' calls=' + (settingsCalls.length - before))
    await act(async () => {
      input.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 50))
    })
    check('an emptied interval reverts to the stored value on blur',
      input.value === '60' && settingsCalls.length === before + 1,
      'value=' + input.value + ' calls=' + (settingsCalls.length - before))
  }
  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- a half-loaded window states no total --------------------------------
// A new window signature reused the previous ready load, so the tiles printed
// "—" (their day had not arrived) while the totals row summed only the days
// already in hand: a partial number presented as the window's total. The totals
// row takes the same partial signal as the tiles now. The calls cell also names
// its unit instead of repeating the count beside it.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const localRoot = ReactDOMClient.createRoot(host)
  const withToday = (date, updatedAt) => {
    const next = JSON.parse(JSON.stringify(overview))
    next.usage.today.date = date
    if (updatedAt !== undefined) next.updatedAt = updatedAt
    return next
  }
  const first = withToday('2026-10-19')
  let releasePending = null
  const gatedDay = (date) => {
    if (date !== '2026-10-20') return loadDay(date)
    // Parked: the window that needs this day never completes while the test
    // holds it, which is the partially loaded state under test.
    return new Promise((resolve, reject) => {
      releasePending = () => { loadDay(date).then(resolve, reject) }
    })
  }
  let state = { snapshot: first, status: 'ready', error: null }
  const storeListeners = new Set()
  const localStore = {
    getSnapshot: () => state,
    subscribe: (fn) => { storeListeners.add(fn); return () => storeListeners.delete(fn) },
  }
  const publish = (next) => {
    state = { snapshot: next, status: 'ready', error: null }
    for (const listener of storeListeners) listener()
  }
  const totalsRow = () => host.querySelector('[data-dsh-part="window-totals"]')
  const statValues = () => [...host.querySelectorAll('[data-dsh-part="window-totals"] [class*="statValue"]')]
  const tileOf = (label) => [...host.querySelectorAll('[data-dsh-part="range-tiles"] button')]
    .find((button) => text(button).includes(label))
  await act(async () => {
    localRoot.render(React.createElement(UsageSectionCard, {
      store: localStore,
      poll: () => {},
      refresh: () => {},
      loadDay: gatedDay,
      loadRange,
      settings,
      deviceSync,
      close: () => {},
    }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 250)) })
  // The card opens on today's window, which is complete by definition; the wide
  // window is the one that can be caught half-loaded.
  await act(async () => {
    tileOf('近 30 天')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
  })
  check('a complete window states its totals',
    statValues().length === 6 && totalsRow()?.getAttribute('data-partial') !== 'true',
    'cells=' + statValues().length)
  // The window grows by a day the card has not fetched yet.
  await act(async () => {
    publish(withToday('2026-10-21', overview.updatedAt + 60000))
    await new Promise((r) => setTimeout(r, 250))
  })
  const partialTile = text(tileOf('近 30 天') ?? host)
  check('a window still missing a day says so on its tile', partialTile.includes('—'), partialTile)
  check('a window still missing a day states no total',
    totalsRow() !== null && statValues().length === 0 && text(totalsRow()) === '—'
      && totalsRow()?.getAttribute('data-partial') === 'true',
    'cells=' + statValues().length + ' row=' + text(totalsRow()))
  // Per-channel shares of a partial sum are the same over-claim as a partial
  // total: the breakdown is hidden until the window is whole.
  check('a partly loaded window does not claim channel shares',
    host.querySelector('[data-dsh-part="channel-breakdown"]') === null,
    String(host.querySelector('[data-dsh-part="channel-breakdown"]')?.textContent ?? 'hidden'))
  await act(async () => {
    if (releasePending !== null) releasePending()
    await new Promise((r) => setTimeout(r, 300))
  })
  check('the total comes back once the missing day lands', statValues().length === 6, 'cells=' + statValues().length)
  check('the channel breakdown returns once the window is whole',
    host.querySelector('[data-dsh-part="channel-breakdown"]') !== null,
    String(host.querySelector('[data-dsh-part="channel-breakdown"]')?.textContent ?? 'missing').slice(0, 60))
  const cells = [...host.querySelectorAll('[data-dsh-part="window-totals"] > div')]
  const callsCell = cells[cells.length - 1]
  const callsLabel = callsCell === undefined ? '' : text(callsCell.querySelector('[class*="statLabel"]'))
  check('the calls cell names its unit instead of repeating the count',
    callsLabel === '次调用' && !/[0-9]/.test(callsLabel), callsLabel)
  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- the sidebar card states failures in the reader's language ------------
// The card interpolated the raw wire text ("usage api/dsh-usage/overview failed:
// 500") into the sentence, so the reader got the transport's words instead of a
// sentence they can act on; the translated sentence is the visible text now and
// the raw text is the title. The card body is also a button whose aria-label used
// to replace the figures it shows: without the label the visible text names it.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const localRoot = ReactDOMClient.createRoot(host)
  const mountFoot = async (footState) => {
    const localStore = { getSnapshot: () => footState, subscribe: () => () => {} }
    await act(async () => {
      localRoot.render(React.createElement(UsageFootCard, {
        store: localStore,
        poll: () => {},
        onOpen: () => {},
        settings,
      }))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 120)) })
  }
  const raw = 'usage api/dsh-usage/overview failed: 500'
  await mountFoot({ snapshot: null, status: 'error', error: raw })
  const footCard = host.querySelector('[data-dsh-part="foot-card"]')
  check('the sidebar card translates a transport failure',
    footCard !== null && text(footCard).includes('请求失败（HTTP 500）') && !text(footCard).includes('usage api'),
    text(footCard))
  const footLine = host.querySelector('[class*="footLine"]')
  check('the sidebar card keeps the wire text in the title',
    footLine !== null && String(footLine.getAttribute('title') ?? '').includes('failed: 500'),
    footLine === null ? 'no line' : String(footLine.getAttribute('title')))
  await mountFoot({ snapshot: overview, status: 'ready', error: null })
  const footMain = host.querySelector('[data-dsh-part="foot-card-main"]')
  check('the sidebar card body does not hide its figures behind a label',
    footMain !== null && footMain.getAttribute('aria-label') === null,
    footMain === null ? 'no card' : String(footMain.getAttribute('aria-label')))
  check('the sidebar card body names itself with its figures',
    footMain !== null && text(footMain).includes('tokens') && text(footMain).includes('次调用'),
    footMain === null ? 'no card' : text(footMain))
  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- the collapse toggle is a target, not a ghost ------------------------
// jsdom does not resolve CSS-module class names to rules, so the rule text is the
// only honest place to measure this: the audit read 20x20 at 0.55 opacity, under
// the 24x24 WCAG 2.2 minimum and unreadable until hovered.
{
  const css = readClient('usage.module.css')
  const rule = /\.footToggle\s*\{([^}]*)\}/.exec(css)
  const body = rule === null ? '' : rule[1]
  const width = /width:\s*(\d+)px/.exec(body)
  const height = /height:\s*(\d+)px/.exec(body)
  const opacity = /opacity:\s*([\d.]+)/.exec(body)
  check('the collapse toggle is a 24px target',
    width !== null && height !== null && Number(width[1]) >= 24 && Number(height[1]) >= 24,
    'w=' + (width?.[1] ?? '?') + ' h=' + (height?.[1] ?? '?'))
  check('the collapse toggle is findable at rest',
    opacity !== null && Number(opacity[1]) >= 0.7, opacity?.[1] ?? '?')
}

// ---- the range strip folds on its own width, not the viewport's ---------
// The fold was a media query, so a 320 px panel inside a wide window kept four
// columns and truncated every label. The card is an inline-size container now
// and the query measures the card, not the window.
{
  const css = readClient('usage.module.css')
  const card = /\.rangeCard\s*\{([^}]*)\}/.exec(css)
  check('the range card is an inline-size container',
    card !== null && /container-type:\s*inline-size/.test(card[1]),
    card === null ? 'missing' : card[1].trim())
  const containerRule = /@container\s*\(max-width:\s*420px\)\s*\{([\s\S]*?)\n\}/.exec(css)
  check('the range strip folds when the card is narrow',
    containerRule !== null && /\.rangeGrid\s*\{[^}]*repeat\(\s*2,/.test(containerRule[1]),
    containerRule === null ? 'missing' : containerRule[1].trim().slice(0, 80))
  check('no viewport query decides the range strip columns',
    !/@media\s*\(max-width:\s*420px\)/.test(css), 'found a 420px media query')
}

// ---- the dictionaries carry only live sentences -------------------------
// Five keys were left behind by earlier layouts; a dead entry is a sentence a
// translator keeps paying for. The two new sentences have to exist in BOTH
// tables, or one language falls back to the key.
{
  const locales = readClient('locales.ts')
  const dead = ['usage.today.cost', 'usage.day.title', 'usage.day.cost', 'usage.day.empty', 'usage.device.id']
  check('the dead dictionary entries are gone',
    dead.every((key) => !locales.includes("'" + key + "'")),
    dead.filter((key) => locales.includes("'" + key + "'")).join(','))
  check('the new sentences are in both tables',
    ['usage.trend.tooFewDays', 'usage.bank.saveError'].every((key) => (locales.match(new RegExp("'" + key + "'", 'g')) ?? []).length === 2),
    ['usage.trend.tooFewDays', 'usage.bank.saveError']
      .map((key) => key + '=' + String((locales.match(new RegExp("'" + key + "'", 'g')) ?? []).length))
      .join(' '))
}

// ---- the copy notice does not outlive the card --------------------------
// `copyId` armed a 1.5 s revert with nothing holding the handle, so unmounting
// the card left a timer that wrote to a component that no longer exists.
{
  const device = readClient('DeviceSyncCard.tsx')
  check('the copy revert timer is tracked and cleared',
    /copiedTimer/.test(device) && /clearTimeout\(copiedTimer\.current\)/.test(device),
    'copiedTimer=' + String(/copiedTimer/.test(device)))
}

// ---- a failed voucher draw is not pinned for the session ----------------
// The art load is cached and the draw error was only ever set, so one transient
// failure kept "票券生成失败" on screen for every later, successful draw.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const mint = JSON.parse(JSON.stringify(overview))
  const mintTotals = { inputTokens: 900000, outputTokens: 300000, cacheReadTokens: 600000, cacheWriteTokens: 0, reasoningTokens: 0, calls: 9, cost: 1.2 }
  const mintRow = { provider: 'deepseek', totals: mintTotals, models: [{ model: 'deepseek-v4.1-flash', totals: mintTotals }] }
  // The bank window is the host's whole-ledger aggregate, so the minting row has
  // to live there for the note to have a face value at all.
  mint.usage.all.providers = [...mint.usage.all.providers, mintRow]
  let state = { snapshot: mint, status: 'ready', error: null }
  const storeListeners = new Set()
  const localStore = {
    getSnapshot: () => state,
    subscribe: (fn) => { storeListeners.add(fn); return () => storeListeners.delete(fn) },
  }
  const realImage = globalThis.Image
  const realGetContext = window.HTMLCanvasElement.prototype.getContext
  const realToBlob = window.HTMLCanvasElement.prototype.toBlob
  class FakeImage {
    constructor() {
      this.naturalWidth = 512
      this.naturalHeight = 512
      this.onload = null
      this.onerror = null
    }
    set src(value) {
      this._src = value
      setTimeout(() => { if (typeof this.onload === 'function') this.onload() }, 0)
    }
    get src() { return this._src }
  }
  globalThis.Image = FakeImage
  window.Image = FakeImage
  const workingCtx = {
    drawImage: () => {},
    measureText: (value) => ({ width: String(value).length * 10 }),
    fillText: () => {},
  }
  window.HTMLCanvasElement.prototype.getContext = () => null
  const localRoot = ReactDOMClient.createRoot(host)
  try {
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
    await act(async () => { await new Promise((r) => setTimeout(r, 250)) })
    // The bank panel starts hidden, and a hidden canvas has no layout: the draw
    // waits for the reveal. `drawVoucher` sets width/height to the art's 512, so
    // the jsdom default (300x150) proves the draw did not run while hidden.
    const bankCanvas = host.querySelector('[data-dsh-part="bank-card"] canvas')
    check('a hidden bank tab does not paint its canvas',
      bankCanvas !== null && bankCanvas.width === 300 && bankCanvas.height === 150,
      bankCanvas === null ? 'no canvas' : bankCanvas.width + 'x' + bankCanvas.height)
    const tabButtons = [...host.querySelectorAll('[data-dsh-part="tabs"] button')]
    await act(async () => {
      tabButtons[2]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    // The draw is deferred to the reveal (a hidden panel has no layout), and
    // the art decode resolves after the effect: give both their own flush.
    await act(async () => { await new Promise((r) => setTimeout(r, 250)) })
    check('revealing the bank tab paints the canvas',
      bankCanvas !== null && bankCanvas.width === 512,
      bankCanvas === null ? 'no canvas' : String(bankCanvas.width))
    const drawError = () => host.querySelector('[data-dsh-part="bank-card"] [class*="errorLine"]')
    check('a canvas that cannot draw reports the voucher failure',
      drawError() !== null && text(drawError()).includes('票券生成失败'),
      drawError() === null ? 'no error line' : text(drawError()))
    // The next draw works: the art is cached and the canvas has a context now.
    window.HTMLCanvasElement.prototype.getContext = () => workingCtx
    const bumped = JSON.parse(JSON.stringify(mint))
    bumped.updatedAt = mint.updatedAt + 60000
    const lastRow = bumped.usage.all.providers[bumped.usage.all.providers.length - 1]
    lastRow.totals = { ...mintTotals, calls: 12, inputTokens: 950000 }
    await act(async () => {
      state = { snapshot: bumped, status: 'ready', error: null }
      for (const listener of storeListeners) listener()
      await new Promise((r) => setTimeout(r, 300))
    })
    check('a successful redraw clears the voucher failure', drawError() === null,
      drawError() === null ? '' : text(drawError()))
    // A save that throws used to leave `saving` true for the rest of the session:
    // the button stayed disabled on "正在生成…" and no later click could try again.
    window.HTMLCanvasElement.prototype.toBlob = () => { throw new Error('toBlob exploded') }
    const saveButton = () => [...host.querySelectorAll('[data-dsh-part="bank-card"] button')]
      .find((button) => text(button).includes('保存图片') || text(button).includes('正在生成'))
    await act(async () => {
      saveButton()?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 150))
    })
    check('a throwing save does not wedge the button',
      saveButton() !== undefined && saveButton().disabled === false,
      saveButton() === undefined ? 'no button' : text(saveButton()) + ' disabled=' + String(saveButton().disabled))
    check('a failed save states the failure instead of dying silently',
      text(host).includes('票券保存失败'), text(host).slice(-80))
  } finally {
    window.HTMLCanvasElement.prototype.getContext = realGetContext
    window.HTMLCanvasElement.prototype.toBlob = realToBlob
    globalThis.Image = realImage
    window.Image = realImage
    await act(async () => { localRoot.unmount() })
    host.remove()
  }
}

// ---- a one-day failure still says so ------------------------------------
// The chart returned null before the failure notice whenever it had fewer than
// two rows, so a wholesale failure on a one-day window rendered nothing at all.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const localRoot = ReactDOMClient.createRoot(host)
  const rows = [{ date: '2026-10-20', totals: zeroTotals() }]
  await act(async () => { localRoot.render(React.createElement(TrendChart, { rows, allFailed: true })) })
  const notice = host.querySelector('[data-dsh-part="trend-failed"]')
  check('a one-day window still states a wholesale failure', notice !== null, text(host))
  const plot = host.querySelector('[role="img"]')
  check('a one-day failure keeps the plot labelled',
    plot !== null && String(plot.getAttribute('aria-label') ?? '').includes('2026-10-20'),
    plot === null ? 'no plot' : String(plot.getAttribute('aria-label')))
  await act(async () => { localRoot.render(React.createElement(TrendChart, { rows })) })
  // A one-day window draws no chart, and used to say nothing at all: the empty
  // space read as a broken panel. The plot is still absent, and a line says why.
  check('a one-day window says it has too few days for a trend',
    host.querySelector('[data-dsh-part="trend-chart"]') === null
      && host.querySelector('[data-dsh-part="trend-short"]') !== null
      && text(host).includes('还不足两天'), text(host))
  await act(async () => { localRoot.render(React.createElement(TrendChart, { rows: [], allFailed: true })) })
  check('an empty failed window still states the failure',
    host.querySelector('[data-dsh-part="trend-failed"]') !== null, text(host))
  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- a retry chain is not rewound by every poll -------------------------
// The budget refilled whenever snapshot.updatedAt moved, so a host that kept
// answering polls (and the user's own Refresh) rewound the backoff while the
// windows kept failing: the ladder never reached its cap. Only a spent budget
// refills now, so a chain in flight keeps its place. The timers are captured
// instead of fired so the test can move the stamp between two rungs.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  let state = { snapshot, status: 'ready', error: null }
  const storeListeners = new Set()
  const localStore = {
    getSnapshot: () => state,
    subscribe: (fn) => { storeListeners.add(fn); return () => storeListeners.delete(fn) },
  }
  let loads = 0
  const deadRange = async (from, to) => {
    loads += 1
    throw new Error('usage api/dsh-usage/range?from=' + from + '&to=' + to + ' failed: 500')
  }
  const pending = new Map()
  let nextId = 0
  const realSetTimeout = window.setTimeout
  const realClearTimeout = window.clearTimeout
  window.setTimeout = (callback, delay) => {
    if (typeof callback !== 'function') return 0
    nextId += 1
    pending.set(nextId, { callback, delay })
    return nextId
  }
  window.clearTimeout = (id) => { pending.delete(id) }
  const localRoot = ReactDOMClient.createRoot(host)
  let fired = 0
  const rungDelays = []
  const runPending = async () => {
    const due = [...pending.values()]
    pending.clear()
    fired += due.length
    for (const entry of due) {
      if (typeof entry.delay === 'number') rungDelays.push(entry.delay)
      await act(async () => {
        entry.callback()
        await new Promise((r) => setTimeout(r, 150))
      })
    }
    return due.length
  }
  try {
    await act(async () => {
      localRoot.render(React.createElement(UsageSectionCard, {
        store: localStore,
        poll: () => {},
        refresh: () => {},
        loadDay,
        loadRange: deadRange,
        settings,
        deviceSync,
        close: () => {},
      }))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
    // One rung of the ladder: the chain is in flight now.
    await runPending()
    const afterOneRung = fired
    // The host answers a poll with a newer stamp, the case the audit found.
    await act(async () => {
      state = { snapshot: { ...state.snapshot, updatedAt: state.snapshot.updatedAt + 1000 }, status: 'ready', error: null }
      for (const listener of storeListeners) listener()
      await new Promise((r) => setTimeout(r, 200))
    })
    let guard = 0
    while (pending.size > 0 && guard < 20) {
      await runPending()
      guard += 1
    }
    check('a retry chain is not rewound by a newer snapshot',
      afterOneRung >= 1 && fired <= 5 && loads > 2,
      'rungs=' + afterOneRung + ' fired=' + fired + ' loads=' + loads + ' guard=' + guard)
    // The rung delays have to grow: `pollIntervalMs * 2 ** k` capped at 60 s made
    // every rung 60 s, so the ladder never actually backed off.
    check('the retry ladder walks growing rungs',
      rungDelays.length === 5 && rungDelays.every((delay, at) => at === 0 || delay > rungDelays[at - 1]),
      rungDelays.join(','))
    check('a failing window stops at its retry cap',
      fired === 5 && pending.size === 0, 'fired=' + fired + ' pending=' + pending.size)
    // A poll that only moves `updatedAt` must not reopen the spent budget: the
    // host stamps it on every answer, so it is not a recovery signal.
    await act(async () => {
      state = { snapshot: { ...state.snapshot, updatedAt: state.snapshot.updatedAt + 60000 }, status: 'ready', error: null }
      for (const listener of storeListeners) listener()
      await new Promise((r) => setTimeout(r, 200))
    })
    check('a spent budget stays spent when only the timestamp moves',
      pending.size === 0, 'pending=' + pending.size)
    // The ledger moving is the real recovery signal: a new chain is armed.
    const moved = JSON.parse(JSON.stringify(state.snapshot))
    moved.usage.availableDays = [...moved.usage.availableDays, '2026-01-05']
    await act(async () => {
      state = { snapshot: moved, status: 'ready', error: null }
      for (const listener of storeListeners) listener()
      await new Promise((r) => setTimeout(r, 200))
    })
    check('a moved ledger history arms the ladder again', pending.size > 0, 'pending=' + pending.size)
  } finally {
    window.setTimeout = realSetTimeout
    window.clearTimeout = realClearTimeout
    await act(async () => { localRoot.unmount() })
    host.remove()
  }
}

// ---- the device card states a read failure in the reader's language ------
// The devicesError line interpolated the host's raw read error (a path, an errno)
// exactly as the ledger line did. The sentence is translated now and the raw text
// is the title, so the two halves are asserted separately.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const variant = JSON.parse(JSON.stringify(overview))
  variant.usage.devicesError = 'EACCES: permission denied, scandir /home/u/.dsh/dsh-usage'
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
  await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
  const deviceError = host.querySelector('[data-dsh-part="device-error"]')
  check('a device read failure is translated',
    deviceError !== null && text(deviceError).includes('部分文件无法读取') && !text(deviceError).includes('EACCES'),
    deviceError === null ? 'no line' : text(deviceError))
  check('the device read error stays available in the title',
    deviceError !== null && String(deviceError.getAttribute('title') ?? '').includes('EACCES'),
    deviceError === null ? 'no line' : String(deviceError.getAttribute('title')))
  check('the device read error is described for screen readers',
    (() => {
      const id = deviceError?.getAttribute('aria-describedby')
      if (id === null || id === undefined) return false
      const detail = document.getElementById(id)
      return detail !== null && text(detail).includes('EACCES') && !text(deviceError).includes('EACCES')
    })(),
    deviceError === null ? 'no line' : String(deviceError.getAttribute('aria-describedby')))
  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- the plan bar's warning tones are measured too -----------------------
// The tone classes only change the colour now, so the base class keeps the
// height; the colour itself used to be a stock amber/red picked against the dark
// card alone. On the light card's track the amber fell to 2.64:1 and on the dark
// one the red to 2.78:1 — a 6px bar nobody can see is not a warning. Both tones
// are measured here against every surface the fill can sit on.
{
  const channelsOf = (hex) => {
    const value = Number.parseInt(String(hex).slice(1), 16)
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
  }
  const channel = (value) => {
    const scaled = value / 255
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  const luminanceOf = (rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
  const contrastOf = (a, b) => {
    const high = Math.max(luminanceOf(a), luminanceOf(b))
    const low = Math.min(luminanceOf(a), luminanceOf(b))
    return (high + 0.05) / (low + 0.05)
  }
  const css = readClient('usage.module.css')
  const toneOf = (name) => {
    const match = new RegExp('\\.' + name + '\\s*\\{[^}]*?background:\\s*(#[0-9a-fA-F]{6})').exec(css)
    return match?.[1]
  }
  const warn = toneOf('barWarn')
  const low = toneOf('barLow')
  // The card paints no background, so the fill sits on the host's surface; it
  // also sits inside the 10%-currentColor track, which is the lighter surface on
  // the dark skin and the darker one on the light skin.
  const surfaces = {
    white: '#ffffff',
    darkDialog: '#171a1f',
    lightestDark: '#202124',
    lightTrack: '#e9eaeb',
    darkTrack: '#2c2f33',
  }
  check('the plan bar has a measured warn tone', warn !== undefined, String(warn))
  check('the plan bar has a measured low tone', low !== undefined, String(low))
  for (const [name, hex] of Object.entries({ warn, low })) {
    if (hex === undefined) continue
    let worst = Infinity
    let worstSurface = ''
    for (const [surface, surfaceHex] of Object.entries(surfaces)) {
      const ratio = contrastOf(channelsOf(hex), channelsOf(surfaceHex))
      if (ratio < worst) { worst = ratio; worstSurface = surface }
    }
    check(`the plan bar's ${name} tone clears 3:1 on every card surface`,
      worst >= 3, `${hex} ${worst.toFixed(2)}:1 on ${worstSurface}`)
  }
}

// ---- a rescan is one round trip -----------------------------------------
// The button answered with the device list and then asked the section to
// refetch the overview, so one click scanned the peer directory twice: the
// second read could start before the scan's own snapshot settled and put the
// older answer on screen. The rescan's answer is the refreshed overview now and
// the card leaves the refetch alone.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const state = { snapshot, status: 'ready', error: null }
  const localStore = { getSnapshot: () => state, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  const refreshes = []
  let rescans = 0
  const rescanApi = {
    exportLedger: async () => {},
    importLedger: async () => ({ deviceId: 'peer-0001' }),
    rescan: async () => { rescans += 1; return [] },
  }
  await act(async () => {
    localRoot.render(React.createElement(UsageSectionCard, {
      store: localStore,
      poll: () => {},
      refresh: () => { refreshes.push('refresh') },
      loadDay,
      loadRange,
      settings,
      deviceSync: rescanApi,
      close: () => {},
    }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
  const card = host.querySelector('[data-dsh-part="device-card"]')
  const rescanButton = card === null ? undefined : [...card.querySelectorAll('button')][2]
  await act(async () => {
    rescanButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 80))
  })
  check('the rescan button reaches the host once', rescans === 1, String(rescans))
  check('a rescan does not refetch the overview', refreshes.length === 0, JSON.stringify(refreshes))
  check('a rescan says it finished',
    text(host.querySelector('[data-dsh-part="device-notice"]')).includes('已重新扫描'),
    text(host.querySelector('[data-dsh-part="device-notice"]')))
  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- the day picker's label points at its own select ---------------------
// The ids used to be the constants 'dsh-usage-day-usage'/'…-all': two cards on
// one page (the sidebar panel and an expanded one) handed the same id to two
// selects, and one card's label pointed at the other card's control.
{
  const mount = async () => {
    const host = window.document.createElement('div')
    window.document.body.appendChild(host)
    const state = { snapshot: overview, status: 'ready', error: null }
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
  const first = await mount()
  const second = await mount()
  const pickers = (host) => [...host.querySelectorAll('[data-dsh-part^="day-"]')]
  const idsOf = (host) => pickers(host).flatMap((wrapper) => [...wrapper.querySelectorAll('select')].map((select) => select.id))
  const firstIds = idsOf(first.host)
  const secondIds = idsOf(second.host)
  check('every day select is labelled by its own control',
    pickers(first.host).every((wrapper) => {
      const select = wrapper.querySelector('select')
      const label = wrapper.querySelector('label')
      return select !== null && label !== null && label.getAttribute('for') === select.id && select.id !== ''
    }),
    JSON.stringify(pickers(first.host).map((wrapper) => [wrapper.querySelector('label')?.getAttribute('for'), wrapper.querySelector('select')?.id])))
  check('two cards do not share a day select id',
    firstIds.length > 0 && firstIds.every((id) => !secondIds.includes(id)),
    JSON.stringify({ firstIds, secondIds }))
  for (const mounted of [first, second]) {
    await act(async () => { mounted.localRoot.unmount() })
    mounted.host.remove()
  }
}

// ---- the audit's client defects -----------------------------------------
// F3: a device action whose promise never settles used to disable the other
// buttons with no label change, no busy signal and no way out. The card reports
// the action as pending and a 20s watchdog turns the silence into a retryable
// failure.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const hung = { ...deviceSync, exportLedger: () => new Promise(() => {}) }
  const realSetTimeout = window.setTimeout
  const watchdogs = []
  window.setTimeout = (fn, ms, ...args) => {
    // `withTimeout` arms the only 20s timer the card owns; every other timer
    // stays real so React and the harness still flush.
    if (ms === 20000) { watchdogs.push(fn); return 0 }
    return realSetTimeout(fn, ms, ...args)
  }
  const localRoot = ReactDOMClient.createRoot(host)
  try {
    await act(async () => {
      localRoot.render(React.createElement(UsageSectionCard, {
        store,
        poll: () => {},
        refresh: () => {},
        loadDay,
        loadRange,
        settings,
        deviceSync: hung,
        close: () => {},
      }))
    })
    await act(async () => { await new Promise((r) => realSetTimeout(r, 150)) })
    const card = host.querySelector('[data-dsh-part="device-card"]')
    check('the device card renders for the pending-action test', card !== null)
    if (card !== null) {
      const buttonOf = (label) => [...card.querySelectorAll('button')].find((button) => text(button).includes(label))
      const exportBtn = buttonOf('导出本机用量')
      if (exportBtn !== undefined) {
        await act(async () => { exportBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
        check('a pending device action announces itself as busy',
          card.getAttribute('aria-busy') === 'true', String(card.getAttribute('aria-busy')))
        check('a pending device action says what it is doing', text(exportBtn) === '导出中…', text(exportBtn))
        check('the other device actions wait for the pending one',
          buttonOf('导入其他设备').disabled === true && buttonOf('重新扫描').disabled === true)
        check('the watchdog is armed once', watchdogs.length === 1, String(watchdogs.length))
        await act(async () => { watchdogs[0]?.(); await new Promise((r) => realSetTimeout(r, 50)) })
        check('a timed-out action hands the buttons back',
          card.getAttribute('aria-busy') !== 'true' && exportBtn.disabled === false && text(exportBtn) === '导出本机用量',
          text(exportBtn) + ' disabled=' + String(exportBtn.disabled))
        const timeoutNotice = host.querySelector('[data-dsh-part="device-notice"]')
        check('a timed-out action says so',
          timeoutNotice !== null && text(timeoutNotice).includes('操作超时'),
          timeoutNotice === null ? 'no notice' : text(timeoutNotice))
      }
    }
  } finally {
    window.setTimeout = realSetTimeout
    await act(async () => { localRoot.unmount() })
    host.remove()
  }
}

// F4: the copy button was named by its visible text only while the card shows
// two ids, and a missing or denied clipboard failed silently.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const localRoot = ReactDOMClient.createRoot(host)
  const realClipboard = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')
  const setClipboard = (value) => Object.defineProperty(window.navigator, 'clipboard', { value, configurable: true })
  try {
    await act(async () => {
      localRoot.render(React.createElement(UsageSectionCard, {
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
    await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
    const card = host.querySelector('[data-dsh-part="device-card"]')
    const copyBtn = card === null ? undefined : [...card.querySelectorAll('button')].find((button) => text(button).includes('复制标识'))
    check('the copy button names the id it copies',
      copyBtn !== undefined && String(copyBtn.getAttribute('aria-label') ?? '').includes('scrip-desktop-9c1f2a'),
      copyBtn === undefined ? 'no button' : String(copyBtn.getAttribute('aria-label')))
    check('the copy label is a live region',
      copyBtn !== undefined && copyBtn.querySelector('[role="status"]') !== null)
    if (copyBtn !== undefined) {
      setClipboard(undefined)
      await act(async () => { copyBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
      const missing = host.querySelector('[data-dsh-part="device-notice"]')
      check('a missing clipboard reports the copy failure',
        missing !== null && text(missing).includes('复制失败'),
        missing === null ? 'no notice' : text(missing))
      // Replace the notice through a working export, so the rejection below has
      // to produce a fresh message instead of leaving the previous one in place.
      const exportBtn = [...card.querySelectorAll('button')].find((button) => text(button) === '导出本机用量')
      await act(async () => {
        exportBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 30))
      })
      check('a working action replaces the copy failure',
        host.querySelector('[data-dsh-part="device-notice"]') !== null &&
        text(host.querySelector('[data-dsh-part="device-notice"]')).includes('已导出'),
        text(host.querySelector('[data-dsh-part="device-notice"]')))
      setClipboard({ writeText: () => new Promise((resolve, reject) => setTimeout(() => reject(new Error('clipboard denied')), 20)) })
      await act(async () => { copyBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
      check('a pending copy says so', text(copyBtn) === '复制中…' && copyBtn.disabled === true, text(copyBtn))
      await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
      const denied = host.querySelector('[data-dsh-part="device-notice"]')
      check('a rejected clipboard write reports the copy failure',
        denied !== null && text(denied).includes('复制失败') && copyBtn.disabled === false,
        denied === null ? 'no notice' : text(denied) + ' disabled=' + String(copyBtn.disabled))
    }
  } finally {
    if (realClipboard === undefined) delete window.navigator.clipboard
    else Object.defineProperty(window.navigator, 'clipboard', realClipboard)
    await act(async () => { localRoot.unmount() })
    host.remove()
  }
}

// F5: the bank day error kept the raw wire text in the title, where only a mouse
// can reach it; the described-by sibling is the keyboard/screen-reader path.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const rawDay = 'usage api/dsh-usage/day?date=2026-10-20 failed: 502'
  const state = { snapshot, status: 'ready', error: null }
  const localStore = { getSnapshot: () => state, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  try {
    await act(async () => {
      localRoot.render(React.createElement(UsageSectionCard, {
        store: localStore,
        poll: () => {},
        refresh: () => {},
        loadDay: async () => { throw new Error(rawDay) },
        loadRange,
        settings,
        deviceSync,
        close: () => {},
      }))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 120)) })
    const bankTab = [...host.querySelectorAll('[role="tab"]')].find((tab) => text(tab).includes('Token 银行'))
    await act(async () => { bankTab?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 120)) })
    // The day picker is the bank card's sibling (it sits above the voucher),
    // not one of the voucher's own children.
    const select = host.querySelector('[data-dsh-part="day-bank"] select')
    // Today is answered from the snapshot, so the picker must name an older day
    // to make the host call that can fail.
    const option = select === null ? null : [...select.querySelectorAll('option')].find((entry) => entry.value === '2026-10-19')
    check('the bank day picker offers a day to fail', option !== null)
    if (select !== null && option !== null) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      await act(async () => {
        setter.call(select, '2026-10-19')
        select.dispatchEvent(new window.Event('change', { bubbles: true }))
      })
      await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
      const errLine = host.querySelector('[data-dsh-part="bank-card"] [class*="errorLine"]')
      check('a failed bank day is stated in the user\'s language',
        errLine !== null && text(errLine).includes('该日用量加载失败') && !text(errLine).includes('usage api'),
        errLine === null ? 'no error line' : text(errLine))
      const detail = errLine === null ? null : window.document.getElementById(String(errLine.getAttribute('aria-describedby') ?? ''))
      check('the bank day failure exposes its wire text to assistive tech',
        detail !== null && text(detail) === rawDay && String(detail.className).includes('srOnly'),
        detail === null ? 'no described-by target' : text(detail))
    }
  } finally {
    await act(async () => { localRoot.unmount() })
    host.remove()
  }
}

// F6: `toLocale*` follows the runtime locale, so a zh panel could print
// "2:45:45 AM" or "10/20/2026"; the ISO order reads the same everywhere.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const state = { snapshot, status: 'ready', error: null }
  const localStore = { getSnapshot: () => state, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  try {
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
    const panelText = text(host)
    check('a timestamp prints as YYYY-MM-DD HH:mm, not the runtime locale',
      /更新于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(panelText) && !/\b(AM|PM)\b/.test(panelText) && !/\d{1,2}\/\d{1,2}\/\d{4}/.test(panelText),
      panelText.slice(0, 160))
  } finally {
    await act(async () => { localRoot.unmount() })
    host.remove()
  }
}

// F8: a rejected interval write left the un-applied value in the field (120 in
// the input, 60 in the Host). The draft that asked for the write is dropped.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const realSet = settings.set
  const localRoot = ReactDOMClient.createRoot(host)
  try {
    settings.set = async (field, value) => {
      settingsCalls.push({ field, value })
      return field === 'pollIntervalSec' ? false : true
    }
    await act(async () => {
      localRoot.render(React.createElement(UsageSectionCard, {
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
    await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
    const input = host.querySelector('[data-dsh-part="settings-row"] input[type="number"]')
    check('the poll-interval field renders for the rejected-write test', input !== null)
    if (input !== null) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      await act(async () => {
        setter.call(input, '120')
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
      await act(async () => {
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        await new Promise((r) => setTimeout(r, 80))
      })
      check('a rejected interval write restores the stored value',
        input.value === '60', 'value=' + input.value)
      check('a rejected interval write says it failed',
        text(host).includes('保存失败'), text(host).slice(-120))
    }
  } finally {
    settings.set = realSet
    await act(async () => { localRoot.unmount() })
    host.remove()
  }
}

// F10: the printed share and the bar width now read one clamped number, with a
// single format: one decimal below 10, integers at and above.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const bucket = (calls, input) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls, cost: 0 })
  const shareSnapshot = {
    ...snapshot,
    providers: [{
      provider: 'codex',
      displayName: 'Codex',
      credential: 'stored',
      planSupported: true,
      updatedAt: Date.now(),
      totals: bucket(1, 100),
      plan: {
        planName: 'Pro',
        updatedAt: Date.now(),
        windows: [{ key: '7_day', percent: 5.56 }, { key: '5h', percent: 120 }],
      },
    }],
  }
  const shareState = { snapshot: shareSnapshot, status: 'ready', error: null }
  const localStore = { getSnapshot: () => shareState, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  try {
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
    const plansTab = [...host.querySelectorAll('[role="tab"]')].find((tab) => text(tab).includes('个人套餐'))
    await act(async () => {
      plansTab?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 120))
    })
    const planText = text(host.querySelector('[data-dsh-part="plan-card"]') ?? host)
    const widths = [...host.querySelectorAll('[data-dsh-part="plan-card"] [class*="barFill"]')].map((fill) => fill.style.width)
    check('a share below ten prints one decimal', planText.includes('5.6%'), planText)
    check('a share above one hundred prints the width the bar can show',
      planText.includes('100%') && widths[1] === '100%', planText + ' widths=' + JSON.stringify(widths))
    check('the printed share and the bar width read the same clamp',
      widths[0] === '5.56%', JSON.stringify(widths))
  } finally {
    await act(async () => { localRoot.unmount() })
    host.remove()
  }
}

// F9: one panel used two words for the same thing ("Token 银行" / "总 tokens",
// "提供方" / "provider"). The dictionary now says Token and 提供方 throughout.
{
  const localeSource = readClient('locales.ts')
  check('the panel says Token with one casing',
    localeSource.includes("'usage.tokens.total': '总 Token'") &&
    localeSource.includes("'usage.tab.bank': 'Token 银行'") &&
    !localeSource.includes('总 tokens'),
    'tokens.total casing')
  check('the panel says 提供方 for every configured-provider sentence',
    localeSource.includes('没有已配置的提供方') &&
    localeSource.includes('套餐类提供方') &&
    !localeSource.includes('套餐类 provider'),
    'provider wording')
}

// ---- a superseded ledger history does not keep the old total on screen ----
// The day cache was keyed by date alone, so a snapshot whose ledger had moved on
// (a peer import, a late backfill) kept serving the days read before the move:
// the 近 30 天 tile went on stating the old total as if it were current. A window
// now remembers the stamp its visible days were read from and drops them when the
// stamp moves, so the tile says "…" until the refetch lands.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  let state = { snapshot: JSON.parse(JSON.stringify(overview)), status: 'ready', error: null }
  const storeListeners = new Set()
  const localStore = {
    getSnapshot: () => state,
    subscribe: (fn) => { storeListeners.add(fn); return () => storeListeners.delete(fn) },
  }
  // The re-read sees the tokens the moved stamp announced, so the total the tile
  // ends on is not the one it started from.
  const grownDay = (date) => {
    const view = JSON.parse(JSON.stringify(days[date]))
    view.totals.inputTokens += 1_000_000
    return view
  }
  let hang = false
  const parked = []
  const gatedDay = (date) => {
    if (!hang) return loadDay(date)
    // Parked: the refetch never settles while the test holds it, which is the
    // in-flight state under test.
    return new Promise((resolve) => { parked.push(() => resolve(grownDay(date))) })
  }
  const localRoot = ReactDOMClient.createRoot(host)
  const tileOf = (label) => [...host.querySelectorAll('[data-dsh-part="range-tiles"] button')]
    .find((button) => text(button).includes(label))
  const tileValue = () => text(tileOf('近 30 天')?.querySelector('[class*="rangeTileValue"]'))
  await act(async () => {
    localRoot.render(React.createElement(UsageSectionCard, {
      store: localStore,
      poll: () => {},
      refresh: () => {},
      loadDay: gatedDay,
      loadRange,
      settings,
      deviceSync,
      close: () => {},
    }))
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
  await act(async () => {
    tileOf('近 30 天')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
  })
  check('the 近 30 天 tile states the settled total before the ledger moves',
    tileValue() === '135M', tileValue())
  // The ledger grows behind the card while every day the tile is showing was read
  // before the move: the stamp moves, the days do not match it any more. Today is
  // counted from the overview rather than from a fetch, so its share of the growth
  // lands in the snapshot as well — the total the tile ends on then holds whichever
  // half of the window it reads.
  hang = true
  await act(async () => {
    const next = JSON.parse(JSON.stringify(overview))
    next.updatedAt = overview.updatedAt + 60000
    next.usage.all.totals.inputTokens += 4_000_000
    next.usage.today.totals.inputTokens += 1_000_000
    state = { snapshot: next, status: 'ready', error: null }
    for (const listener of storeListeners) listener()
    await new Promise((r) => setTimeout(r, 150))
  })
  check('a moved ledger stamp drops the 近 30 天 figure while the refetch is in flight',
    tileValue() === '…', tileValue() + ' parked=' + parked.length)
  await act(async () => {
    for (const release of parked.splice(0)) release()
    await new Promise((r) => setTimeout(r, 250))
  })
  check('the re-read days put the grown total on the tile',
    tileValue() === '139M', tileValue())
  await act(async () => { localRoot.unmount() })
  host.remove()
}

// ---- a single-day voucher states its date once ---------------------------
// The bank line printed the span form for a one-day window too
// ("2026-10-20 ~ 2026-10-20"), so a reader who picked one day saw the date twice
// around a tilde that meant nothing.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const single = JSON.parse(JSON.stringify(overview))
  // The fixture's routes mint no whale yuan, and a note without a face value
  // renders no window line at all: one mint-family row puts the line on screen.
  const mintTotals = { inputTokens: 900000, outputTokens: 300000, cacheReadTokens: 600000, cacheWriteTokens: 0, reasoningTokens: 0, calls: 9, cost: 1.2 }
  single.usage.today.providers = [...single.usage.today.providers, { provider: 'deepseek', totals: mintTotals, models: [] }]
  const state = { snapshot: single, status: 'ready', error: null }
  const localStore = { getSnapshot: () => state, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  const realGetContext = window.HTMLCanvasElement.prototype.getContext
  try {
    // jsdom ships no 2D context, so the artwork draw fails and says so; that is a
    // different sentence from the one under test here.
    window.HTMLCanvasElement.prototype.getContext = () => null
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
    await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
    const bankTab = [...host.querySelectorAll('[role="tab"]')].find((tab) => text(tab).includes('Token 银行'))
    await act(async () => {
      bankTab?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 150))
    })
    // Today is answered from the snapshot, so the single-day window needs no host
    // call and cannot race a fetch.
    const select = host.querySelector('[data-dsh-part="day-bank"] select')
    const option = select === null ? null : [...select.querySelectorAll('option')].find((entry) => entry.value === '2026-10-20')
    if (select !== null && option !== null) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      await act(async () => {
        setter.call(select, '2026-10-20')
        select.dispatchEvent(new window.Event('change', { bubbles: true }))
      })
      await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
    }
    const cardText = text(host.querySelector('[data-dsh-part="bank-card"]'))
    const occurrences = cardText.split('2026-10-20').length - 1
    check('a single-day voucher states its date once',
      occurrences === 1 && !cardText.includes('~'), 'occurrences=' + occurrences + ' ' + cardText)
  } finally {
    window.HTMLCanvasElement.prototype.getContext = realGetContext
    await act(async () => { localRoot.unmount() })
    host.remove()
  }
}

// ---- a synchronous clipboard throw releases the copy button ---------------
// The write was evaluated as the argument of `Promise.resolve().then(...)`, so a
// clipboard that throws synchronously (a policy-blocked webview, a patched
// clipboard) skipped both handlers: the button stayed disabled, the card stayed
// busy, and no sentence said the copy had failed.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const state = { snapshot, status: 'ready', error: null }
  const localStore = { getSnapshot: () => state, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  const realClipboard = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')
  try {
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
    await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
    const card = host.querySelector('[data-dsh-part="device-card"]')
    const copyButton = card === null
      ? undefined
      : [...card.querySelectorAll('button')].find((button) => text(button).includes('复制标识'))
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: () => { throw new Error('clipboard blocked by policy') } },
      configurable: true,
    })
    let thrown = null
    try {
      await act(async () => {
        copyButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 120))
      })
    } catch (error) {
      // A pre-fix build lets the throw escape the click handler; keeping it from
      // taking the run down lets the checks below report what is on screen.
      thrown = error
    }
    check('a synchronous clipboard throw releases the copy button',
      copyButton !== undefined && copyButton.disabled === false && card?.getAttribute('aria-busy') === 'false',
      'disabled=' + copyButton?.disabled + ' busy=' + card?.getAttribute('aria-busy') + (thrown === null ? '' : ' threw=' + thrown.message))
    const notice = host.querySelector('[data-dsh-part="device-notice"]')
    check('a synchronous clipboard throw says the copy failed',
      text(notice).includes('复制失败'), text(notice))
  } finally {
    if (realClipboard === undefined) delete window.navigator.clipboard
    else Object.defineProperty(window.navigator, 'clipboard', realClipboard)
    await act(async () => { localRoot.unmount() })
    host.remove()
  }
}

// ---- a local draw failure is not reported as a request failure ------------
// `describeError` was called without a fallback here, so a canvas that could not
// draw (jsdom has no 2D context, and no `Image` to decode the art) printed
// "请求失败，请稍后再试" — a transport failure, for a machine-side problem. The
// draw-specific sentence names it now, and the raw text stays in the title.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const mint = JSON.parse(JSON.stringify(overview))
  const mintTotals = { inputTokens: 900000, outputTokens: 300000, cacheReadTokens: 600000, cacheWriteTokens: 0, reasoningTokens: 0, calls: 9, cost: 1.2 }
  mint.usage.all.providers = [...mint.usage.all.providers, { provider: 'deepseek', totals: mintTotals, models: [] }]
  const state = { snapshot: mint, status: 'ready', error: null }
  const localStore = { getSnapshot: () => state, subscribe: () => () => {} }
  const localRoot = ReactDOMClient.createRoot(host)
  const realGetContext = window.HTMLCanvasElement.prototype.getContext
  try {
    window.HTMLCanvasElement.prototype.getContext = () => null
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
    await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
    const bankTab = [...host.querySelectorAll('[role="tab"]')].find((tab) => text(tab).includes('Token 银行'))
    await act(async () => {
      bankTab?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 250))
    })
    const errLine = host.querySelector('[data-dsh-part="bank-card"] [class*="errorLine"]')
    const sentence = text(errLine)
    check('a local draw failure is stated as a draw failure, not a request failure',
      errLine !== null && sentence.includes('票券生成失败（本机绘制出错）') && !sentence.includes('请求失败'),
      sentence === '' ? 'no error line' : sentence)
  } finally {
    window.HTMLCanvasElement.prototype.getContext = realGetContext
    await act(async () => { localRoot.unmount() })
    host.remove()
  }
}

// ---- an inverted custom pair keeps each typed value in its own box -------
// Typing a "from" later than the current "to" normalised the window by rewriting
// the fields, so the date typed into one box came back in the other. The window
// is still swapped (a range is a range), but the two inputs hold what was typed.
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const state = { snapshot, status: 'ready', error: null }
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
  await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
  const tileOf = (label) => [...host.querySelectorAll('[data-dsh-part="range-tiles"] button')]
    .find((button) => text(button).includes(label))
  await act(async () => {
    tileOf('近 30 天')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 150))
  })
  await act(async () => {
    tileOf('自定义')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 150))
  })
  const dateInputs = () => [...host.querySelectorAll('[data-dsh-part="custom-range"] input[type="date"]')]
  const typeDate = async (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    await act(async () => {
      setter.call(input, value)
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
      input.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
  }
  if (dateInputs().length === 2) {
    await typeDate(dateInputs()[0], '2026-10-05')
    await typeDate(dateInputs()[1], '2026-09-01')
  }
  const values = dateInputs().map((input) => input.value)
  check('an inverted custom pair keeps each typed value in its own box',
    JSON.stringify(values) === JSON.stringify(['2026-10-05', '2026-09-01']), JSON.stringify(values))
  await act(async () => { localRoot.unmount() })
  host.remove()
}

const failed = report.filter((row) => !row.ok)
console.log('\n=== ' + (report.length - failed.length) + '/' + report.length + ' checks passed ===')
// The jsdom window keeps timers and the React scheduler alive, so the process
// would sit there after the summary and read as a hang. Exit explicitly; the
// summary above is the whole result.
process.exit(failed.length > 0 ? 1 : 0)
