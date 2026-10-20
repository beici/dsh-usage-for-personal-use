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

const { act } = require('react-dom/test-utils')
const container = window.document.getElementById('root')
const root = ReactDOMClient.createRoot(container)

await act(async () => {
  root.render(React.createElement(UsageSectionCard, {
    store,
    poll: () => {},
    refresh: () => {},
    loadDay,
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
check('five range tiles', tiles.length === 5, 'got ' + tiles.length)
if (tiles.length === 5) {
  const labels = tiles.map((b) => text(b.querySelector('span')))
  check('tile order + labels', JSON.stringify(labels) === JSON.stringify(['今日', '昨日', '近 7 天', '近 30 天', '自定义']), JSON.stringify(labels))
  check('today tile active', tiles[0].getAttribute('aria-pressed') === 'true')
  for (const b of tiles) console.log('   tile:', text(b))
}

const windowCard = q('[data-dsh-part="window-card"]')
check('window card rendered', windowCard !== null)
console.log('   window card text:', text(windowCard))

const stats = qa('[data-dsh-part="window-card"] [class*="statValue"]').map(text)
check('six stat cells', stats.length === 6, JSON.stringify(stats))

const chart = q('[data-dsh-part="daily-chart"]')
check('no daily chart for a single-day window', chart === null)

const breakdown = q('[data-dsh-part="channel-breakdown"]')
check('channel breakdown rendered', breakdown !== null)
const modelRows = qa('[data-dsh-part="model-rows"] [class*="chartModel"]')
console.log('   breakdown text:', text(breakdown).slice(0, 400))
check('model rows visible', modelRows.length >= 1, 'rows=' + modelRows.length)

// ---- switch to 近 30 天 --------------------------------------------------
const last30 = tiles[3]
await act(async () => { last30.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await new Promise((r) => setTimeout(r, 120)) })
const card30 = q('[data-dsh-part="window-card"]')
console.log('   last30 card:', text(card30).slice(0, 500))
const stats30 = qa('[data-dsh-part="window-card"] [class*="statValue"]').map(text)
check('last30 six stat cells', stats30.length === 6, JSON.stringify(stats30))
const bars30 = qa('[data-dsh-part="daily-chart"] [class*="dailyBar"]')
check('last30 daily bars = 30 calendar days', bars30.length === 30, 'bars=' + bars30.length)
const spans = q('[data-dsh-part="window-card"] [class*="spanLine"]')
check('last30 span line', text(spans) === '2026-09-21 ~ 2026-10-20', text(spans))
console.log('   last30 fetched days:', JSON.stringify([...new Set(fetched)]))

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
check('yesterday totals match fixture', statsY[0] === '45M' && statsY[1] === '44.6M' && statsY[2] === '386k' && statsY[5] === '521', JSON.stringify(statsY) + ' expected total=' + yTotal + ' billedInput=' + yInput)

// ---- custom --------------------------------------------------------------
const custom = tiles[4]
await act(async () => { custom.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
// Until a date is picked the tile prompts and the card explains, instead of
// silently showing the seven-day default's numbers.
check('untouched custom tile prompts', text(tiles[4]).includes('选择日期'), text(tiles[4]))
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
  const barsC = qa('[data-dsh-part="daily-chart"] [class*="dailyBar"]')
  check('custom daily bars = 30', barsC.length === 30, 'bars=' + barsC.length)
  console.log('   custom card:', text(q('[data-dsh-part="window-card"]')).slice(0, 400))
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
    const file2 = new window.File(['{"deviceId":"scrip-desktop-9c1f2a"}'], 'self.json', { type: 'application/json' })
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

const failed = report.filter((row) => !row.ok)
console.log('\n=== ' + (report.length - failed.length) + '/' + report.length + ' checks passed ===')
if (failed.length > 0) process.exitCode = 1
