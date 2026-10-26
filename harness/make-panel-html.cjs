#!/usr/bin/env node
/**
 * Builds a self-contained HTML page that renders the redesigned usage section
 * exactly as the plugin bundle would, so a headless browser can screenshot it.
 * Everything (bundle, CSS, fixtures) is inlined: file:// pages cannot fetch
 * sibling files, and we do not want to stand up a server.
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const FIXT = path.join(ROOT, 'fixtures')

const bundle = fs.readFileSync(path.join(ROOT, 'harness/client.test.cjs'), 'utf8')
const react = fs.readFileSync(path.join(ROOT, 'node_modules/react/umd/react.development.js'), 'utf8')
const reactDom = fs.readFileSync(path.join(ROOT, 'node_modules/react-dom/umd/react-dom.development.js'), 'utf8')

const overview = JSON.parse(fs.readFileSync(path.join(FIXT, 'overview.json'), 'utf8'))
const days = Object.fromEntries(['2026-09-21', '2026-09-22', '2026-10-19', '2026-10-20'].map((d) => [d, JSON.parse(fs.readFileSync(path.join(FIXT, `day-${d}.json`), 'utf8')).day]))

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>dsh-usage redesigned panel</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #f3f4f6;
    font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif;
    font-size: 13px;
    color: #1f2328;
    -webkit-font-smoothing: antialiased;
  }
  .dialog {
    width: 760px;
    margin: 24px auto;
    background: #ffffff;
    border: 1px solid rgba(0,0,0,.1);
    border-radius: 12px;
    padding: 20px 24px 24px;
    box-shadow: 0 12px 32px rgba(0,0,0,.08);
  }
  .dialogHead {
    display: flex; align-items: center; justify-content: space-between;
    padding-bottom: 12px; margin-bottom: 16px;
    border-bottom: 1px solid rgba(0,0,0,.08);
  }
  .dialogTitle { font-size: 15px; font-weight: 600; }
  .dialogSub { font-size: 12px; opacity: .6; }
  .dark { color-scheme: dark; }
  .dark body { background: #0f1115; }
  .dark .dialog { background: #171a1f; border-color: rgba(255,255,255,.12); color: #e6e8eb; box-shadow: none; }
  .dark .dialogHead { border-bottom-color: rgba(255,255,255,.1); }
</style>
</head>
<body>
<div class="dialog">
  <div class="dialogHead">
    <span class="dialogTitle">设置 · 使用统计</span>
    <span class="dialogSub">CodeBuddy (腾讯) · deepseek-v4.1-flash</span>
  </div>
  <div id="root"></div>
</div>

<script>${react}</script>
<script>${reactDom}</script>
<script>
  // Real react/jsx-runtime and react-dom/client are separate ESM entry points
  // with no UMD build. A faithful jsx/jsxs shim is required: the compiled
  // bundle calls jsxs(type, props, key), and React.createElement's third
  // argument is a CHILD, so passing the key straight through would replace the
  // element's children with the key string (that is exactly what painted the
  // raw "today"/"buddy" text before this shim existed).
  function createJsx(type, config, maybeKey) {
    const props = {}
    for (const name of Object.keys(config || {})) {
      if (name !== 'key' && name !== 'ref') props[name] = config[name]
    }
    const key = maybeKey !== undefined ? maybeKey : (config && config.key)
    if (key !== undefined && key !== null) props.key = key
    const children = config && config.children
    if (children === undefined) return window.React.createElement(type, props)
    return window.React.createElement(type, props, ...(Array.isArray(children) ? children : [children]))
  }
  window.ReactJSXRuntime = { jsx: createJsx, jsxs: createJsx, Fragment: window.React.Fragment }
  window.ReactDOMClient = { createRoot: ReactDOM.createRoot }
</script>
<script>
  window.__ModuleLoader__ = {
    load({ factory }) {
      const table = {
        'react': window.React,
        'react/jsx-runtime': window.ReactJSXRuntime,
        'react-dom/client': window.ReactDOMClient,
        '@deepseek-ai/dsh-client-store': { defineStore: () => ({ create: () => ({ getSnapshot: () => ({}), subscribe: () => () => {} }) }) },
      }
      const require = (name) => table[name]
      // The bundle's footer is "return module.exports", so the factory's return
      // value is the export surface even though the real loader ignores it.
      window.__usage = factory(require)
    },
  }
  window.__fixtures = { overview: ${JSON.stringify(overview)}, days: ${JSON.stringify(days)} }
</script>
<script>
${bundle}
</script>
<script>
  (function () {
    const exports = window.__usage
    const { UsageSectionCard } = exports
    const { overview, days } = window.__fixtures

    const storeState = { snapshot: overview, status: 'ready', error: null }
    const settingsState = { status: 'ready', writable: true, value: { enabled: true, pollIntervalSec: 60 } }
    const face = {
      store: { getSnapshot: () => storeState, subscribe: () => () => {} },
      settings: { getSnapshot: () => settingsState, subscribe: () => () => {}, set: async () => true },
      poll: () => {},
      refresh: () => {},
      loadDay: async (date) => { const day = days[date]; if (day === undefined) throw new Error('no fixture ' + date); return day },
      loadRange: async (from, to) => ({
        ok: true, from, to,
        totals: overview.usage.all.totals,
        providers: overview.usage.all.providers,
        series: overview.usage.days.map((row) => ({ date: row.date, totals: row.totals })),
      }),
      close: () => {},
    }
    const root = window.ReactDOMClient.createRoot(document.getElementById('root'))
    root.render(window.React.createElement(UsageSectionCard, face))

    // Optional scripted interactions for the per-tab screenshots:
    //   ?tab=last30 | yesterday | custom | plan | bank
    const want = new URLSearchParams(location.search).get('tab')
    if (want) {
      window.setTimeout(() => {
        const qa = (sel) => [...document.querySelectorAll(sel)]
        const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        if (want === 'last30' || want === 'yesterday' || want === 'custom') {
          const tiles = qa('[data-dsh-part="range-tiles"] button')
          click(tiles[{ last30: 4, yesterday: 1, custom: 7 }[want]])
          if (want === 'custom') {
            window.setTimeout(() => {
              const inputs = qa('[data-dsh-part="custom-range"] input[type="date"]')
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
              setter.call(inputs[0], '2026-09-01'); inputs[0].dispatchEvent(new Event('input', { bubbles: true }))
              setter.call(inputs[1], '2026-10-20'); inputs[1].dispatchEvent(new Event('input', { bubbles: true }))
            }, 60)
          }
        } else if (want === 'plan') {
          click(qa('[data-dsh-part="tabs"] button')[1])
        } else if (want === 'bank') {
          click(qa('[data-dsh-part="tabs"] button')[2])
        }
      }, 120)
    }
  })()
</script>
</body>
</html>
`

const out = path.join(ROOT, 'harness/panel.html')
fs.writeFileSync(out, html)
console.log('wrote', out, html.length, 'bytes')
