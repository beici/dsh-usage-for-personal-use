#!/usr/bin/env node
/**
 * Derive the render-test bundle from the real build.
 *
 * The shipped `lib/client.js` only exports `apply` and `inject`, because the
 * plugin shell loads it for its side effects. The render test needs the
 * `UsageSectionCard` component and the settings opener, so this script copies
 * the built bundle and inserts exactly those export lines — the measured
 * behaviour under test is therefore the shipped bundle's, not a re-bundled
 * variant.
 *
 * Run after every rebuild:  node harness/build-test-bundle.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SOURCE = path.join(ROOT, 'packages/dsh-usage/lib/client.js')
const TARGET = path.join(__dirname, 'client.test.cjs')

const EXPORT_ANCHOR = '\t\texports.apply = apply;'
const EXPORT_LINE = '\t\texports.UsageSectionCard = UsageSectionCard;\n\t\texports.openUsageSettings = openUsageSettings;\n'

const source = fs.readFileSync(SOURCE, 'utf8')
if (source.includes('\t\texports.UsageSectionCard = UsageSectionCard;')) {
  throw new Error(`${TARGET} already present in the build — did the source add an export?`)
}
if (!source.includes(EXPORT_ANCHOR)) {
  throw new Error(`anchor ${JSON.stringify(EXPORT_ANCHOR)} not found in ${SOURCE}`)
}

const patched = source.replace(EXPORT_ANCHOR, EXPORT_LINE + EXPORT_ANCHOR)
fs.writeFileSync(TARGET, patched)
console.log(`wrote ${TARGET} (${Buffer.byteLength(patched)} bytes, +${Buffer.byteLength(patched) - Buffer.byteLength(source)})`)
