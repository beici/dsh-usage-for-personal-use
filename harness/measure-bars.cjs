// Measure bar fill vs track extents in the user's panel screenshots.
// Decodes an 8-bit non-interlaced PNG (RGB/RGBA/gray) with zlib and reports,
// for every horizontal band of saturated (colored) pixels: the y-range, the
// fill x-extent, the gray track x-extent on the band's middle row, and the
// fill percent of the track.
'use strict'
const fs = require('fs')
const zlib = require('zlib')

function decodePNG(path) {
  const buf = fs.readFileSync(path)
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png')
  let pos = 8
  let width = 0, height = 0, colorType = 0, bitDepth = 0, interlace = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error('unsupported depth/interlace')
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const r = raw[src + x]
      const left = x >= channels ? out[y * stride + x - channels] : 0
      const up = y > 0 ? out[(y - 1) * stride + x] : 0
      const ul = y > 0 && x >= channels ? out[(y - 1) * stride + x - channels] : 0
      let v
      if (filter === 0) v = r
      else if (filter === 1) v = r + left
      else if (filter === 2) v = r + up
      else if (filter === 3) v = r + ((left + up) >> 1)
      else v = r + paeth(left, up, ul)
      out[y * stride + x] = v & 0xff
    }
  }
  const at = (x, y) => {
    if (colorType === 2) return [out[y * stride + x * 3], out[y * stride + x * 3 + 1], out[y * stride + x * 3 + 2]]
    if (colorType === 6) return [out[y * stride + x * 4], out[y * stride + x * 4 + 1], out[y * stride + x * 4 + 2]]
    throw new Error('colortype ' + colorType + ' not handled')
  }
  return { width, height, at }
}

function analyze(path) {
  const img = decodePNG(path)
  console.log('== ' + path + ' ' + img.width + 'x' + img.height)
  const isFill = (p) => Math.max(...p) - Math.min(...p) > 18 && Math.min(...p) < 235
  const isTrack = (p) => Math.max(...p) - Math.min(...p) <= 10 && p[0] >= 225 && p[0] <= 251
  // Find bands of consecutive rows that contain fill pixels.
  let band = null
  const bands = []
  for (let y = 0; y < img.height; y++) {
    let minX = Infinity, maxX = -Infinity
    for (let x = 0; x < img.width; x++) {
      if (isFill(img.at(x, y))) { if (x < minX) minX = x; if (x > maxX) maxX = x }
    }
    if (maxX >= 0) {
      if (band === null) band = { y0: y, y1: y, minX, maxX }
      else { band.y1 = y; band.minX = Math.min(band.minX, minX); band.maxX = Math.max(band.maxX, maxX) }
    } else if (band !== null) { bands.push(band); band = null }
  }
  if (band !== null) bands.push(band)
  for (const b of bands) {
    if (b.y1 - b.y0 < 1) continue // skip text antialiasing slivers
    const midY = (b.y0 + b.y1) >> 1
    // fill extent on the mid row, including per-color runs
    const runs = []
    let run = null
    for (let x = 0; x < img.width; x++) {
      const p = img.at(x, midY)
      if (isFill(p)) {
        const hue = p[0] > p[2] && p[1] > p[2] ? 'green' : (p[0] > p[1] ? 'pink' : 'purple')
        if (run && run.hue === hue && x - run.x1 <= 2) run.x1 = x
        else { if (run) runs.push(run); run = { hue, x0: x, x1: x } }
      } else if (run && x - run.x1 > 2) { runs.push(run); run = null }
    }
    if (run) runs.push(run)
    // gray track extent on the mid row
    let t0 = -1, t1 = -1
    for (let x = 0; x < img.width; x++) {
      if (isTrack(img.at(x, midY))) { if (t0 < 0) t0 = x; t1 = x }
    }
    const fillPct = t1 > t0 && runs.length > 0
      ? (100 * (runs[runs.length - 1].x1 - runs[0].x0) / (t1 - t0)).toFixed(1)
      : 'n/a'
    console.log(
      'band y=' + b.y0 + '-' + b.y1 +
      ' fill x=' + b.minX + '-' + b.maxX +
      (t0 >= 0 ? ' track x=' + t0 + '-' + t1 : ' track: none') +
      ' fill/track=' + fillPct + '%' +
      ' runs=' + JSON.stringify(runs))
  }
}

for (const p of process.argv.slice(2)) analyze(p)
