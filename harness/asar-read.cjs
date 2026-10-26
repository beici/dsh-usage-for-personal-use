// Parse an asar archive header and dump selected files (read-only helper).
const fs = require('node:fs')
const path = require('node:path')

const asarPath = process.argv[2]
const mode = process.argv[3] || 'list'
const fd = fs.openSync(asarPath, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
// Pickle layout: [u32 4][u32 pickle2Total][u32 payloadSize][u32 jsonLen][json...]
if (head.readUInt32LE(0) !== 4) throw new Error('not an asar archive')
const headerPickleSize = head.readUInt32LE(4)
const jsonLen = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
const header = JSON.parse(jsonBuf.toString('utf8'))
const dataStart = 8 + headerPickleSize

const files = []
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const rel = prefix ? prefix + '/' + name : name
    if (entry.files) walk(entry, rel)
    else files.push({ rel, size: entry.size, offset: Number(entry.offset ?? 0) })
  }
}
walk(header, '')

if (mode === 'list') {
  const match = process.argv[4] ?? ''
  for (const f of files) if (f.rel.includes(match)) console.log(`${f.size}\t${f.rel}`)
  console.error(`total ${files.length} entries`)
} else if (mode === 'extract') {
  const rel = process.argv[4]
  const out = process.argv[5]
  const f = files.find((e) => e.rel === rel)
  if (!f) throw new Error('not found: ' + rel)
  const buf = Buffer.alloc(f.size)
  fs.readSync(fd, buf, 0, f.size, dataStart + f.offset)
  fs.writeFileSync(out, buf)
  console.log(`wrote ${out} (${f.size} bytes)`)
}
fs.closeSync(fd)
