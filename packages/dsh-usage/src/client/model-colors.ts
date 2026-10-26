/**
 * Per-model categorical colors shared by the trend chart and the channel
 * breakdown: one model keeps one hue everywhere in the panel, so a color in
 * the stacked day bars is the same color in the provider bars and model rows.
 *
 * Names normalize first — stripping any `provider/` prefix and the letter
 * case — so `DeepSeek-V4.1-Flash`, `deepseek-v4.1-flash` and
 * `GLM-5.3-Flash` under a prefixed route are ONE model: one color, one
 * stacked segment, one legend row. The display name keeps the heaviest raw
 * spelling of the group (see normalizeModelRows).
 *
 * Palette slots are assigned by a stable hash of the normalized name — NOT by
 * usage rank, and not by "the next free slot" either. Rank assignment pinned
 * chart-1 (blue) onto whatever model leads the current window, so the
 * dominant model was blue in every window and the whole table reshuffled
 * whenever the tile changed; hashing keeps a model's hue constant across
 * windows and independent of how much it ran.
 *
 * A slot is only sixteen hues wide, so two names do collide in it — and the
 * slot used to be the whole color, which painted the second model of a channel
 * exactly like the first. Each slot now carries a ladder of five shades, and a
 * name's rung comes from the same hash, so a collision still lands on two
 * different shades and no model's color moves when the window's model set
 * changes.
 *
 * The shades are cut here, in TypeScript, from the hue bytes: a bar has to be
 * legible on the light AND the dark skin, and only a measured luminance can
 * promise that. The palette used to be CSS variables mixed toward white or
 * black with `color-mix`, which left the ends of that ramp at 1.4:1 on white
 * and 2.3:1 on the dark card — unreadable in exactly the theme the mix was
 * meant to fit. A mix cannot be clamped either, so a rung is placed by its
 * luminance instead: the two skins overlap in a narrow band, and every rung is
 * pulled into it.
 * @module @linxin666/dsh-usage/client/model-colors
 */

/** Fill for models past the palette (the collapsed tail), legible on both skins. */
export const MODEL_COLOR_OTHER = '#6f6f78'

/** How many models the palette distinguishes before the gray tail. */
export const MODEL_PALETTE_SIZE = 16

/** One hue per slot, the panel's chart palette. */
const PALETTE_HUES: readonly string[] = [
  '#0576ff', '#2f6f37', '#c46212', '#975bf1', '#d34591', '#0d8a8a', '#b3341f', '#7a9018',
  '#4b3fd0', '#d4a017', '#c25a7e', '#619e3a', '#2f9e73', '#0f96c9', '#a855c9', '#5c7ac0',
]

type Rgb = readonly [number, number, number]

/** The surface behind the bars on the light skin. */
const SURFACE_LIGHT: Rgb = [255, 255, 255]

/** The surface behind the bars on the dark skin: the panel's own card. */
const SURFACE_DARK: Rgb = [0x16, 0x17, 0x1a]

/** WCAG 2.1 non-text contrast: a bar has to clear this against its surface. */
const MIN_CONTRAST = 3

/**
 * Relative luminance a bar may sit at: the band where it clears MIN_CONTRAST on
 * white (luminance at most 0.3) and on the dark card (at least 0.127). The
 * margins keep rounding from pushing a rung under the floor.
 */
const LUMINANCE_FLOOR = MIN_CONTRAST * (luminance(SURFACE_DARK) + 0.05) - 0.05 + 0.004
const LUMINANCE_CEILING = (luminance(SURFACE_LIGHT) + 0.05) / MIN_CONTRAST - 0.05 - 0.015

/** Rungs on a slot's ladder: five shades, so one slot can hold five names. */
const SHADE_COUNT = 5

/** The color identity of a model: `prefix/`-stripped, trimmed, lower-cased. */
export function normalizeModelName(model: string): string {
  const bare = model.slice(model.lastIndexOf('/') + 1)
  return bare.trim().toLowerCase()
}

/** FNV-1a: a tiny deterministic string hash — same name, same slot, always. */
function hashOf(name: string): number {
  let hash = 0x811c9dc5
  for (let at = 0; at < name.length; at++) {
    hash ^= name.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/** `percent` of every channel: the hue mixed with black, in sRGB bytes. */
function dim(rgb: Rgb, percent: number): Rgb {
  return [
    Math.round((rgb[0] * percent) / 100),
    Math.round((rgb[1] * percent) / 100),
    Math.round((rgb[2] * percent) / 100),
  ]
}

/** `share` of the way to white: the hue lifted without leaving its family. */
function lighten(rgb: Rgb, share: number): Rgb {
  const lift = (channel: number): number => Math.round(channel + (255 - channel) * share)
  return [lift(rgb[0]), lift(rgb[1]), lift(rgb[2])]
}

function toHex(rgb: Rgb): string {
  return '#' + rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')
}

function channelLuminance(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function luminance(rgb: Rgb): number {
  return 0.2126 * channelLuminance(rgb[0]) + 0.7152 * channelLuminance(rgb[1]) + 0.0722 * channelLuminance(rgb[2])
}

/**
 * One hue pulled to a target relative luminance: darkened by scaling when the
 * target is below the hue's own luminance, lifted toward white when it is
 * above. Both moves are monotonic, so a bisection lands on the target — and
 * neither ever parks the hue at an extreme, which is what made the old ramp
 * unreadable.
 */
function withLuminance(base: Rgb, target: number): Rgb {
  const move = target <= luminance(base)
    ? (share: number): Rgb => dim(base, share * 100)
    : (share: number): Rgb => lighten(base, share)
  let low = 0
  let high = 1
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2
    if (luminance(move(mid)) < target) low = mid
    else high = mid
  }
  return move((low + high) / 2)
}

/**
 * One slot's ladder: SHADE_COUNT rungs spread across the luminance band both
 * skins share, so every shade is legible on white and on the dark card alike.
 */
function shadeLadder(hue: string): string[] {
  const base = hexToRgb(hue)
  const ladder: string[] = []
  for (let rung = 0; rung < SHADE_COUNT; rung += 1) {
    const target = LUMINANCE_FLOOR + ((LUMINANCE_CEILING - LUMINANCE_FLOOR) * rung) / (SHADE_COUNT - 1)
    ladder.push(toHex(withLuminance(base, target)))
  }
  return ladder
}

/** Each slot's ladder, cut once at load: the panel never recomputes a color. */
const SLOT_SHADES: readonly (readonly string[])[] = PALETTE_HUES.map(shadeLadder)

/**
 * Assign one palette color per normalized model name.
 *
 * The hue slot is `hash(name) % paletteSize` and nothing else — deliberately not
 * "the next free slot", which made a name's hue depend on which other names
 * happened to be in the same window: two models took chart-1 and chart-2, and a
 * window showing only the second recolored it to chart-1. Stability is the whole
 * promise of this table (the trend bars, the channel bars and the model rows
 * share it, and the user learns the colors), so a collision between two of the
 * sixteen hues is resolved on the shade ladder instead of by shifting someone
 * else's hue. The rung is the next slice of the same hash — never an arrival
 * counter: counting how many names of a slot had already been seen made a
 * model's shade depend on the rest of the window, so the same model sat on one
 * rung in 近 7 天 and on another in 近 30 天. Two names of one slot therefore
 * only collide again when their hashes agree on the rung bits too.
 */
export function assignModelColors(models: Iterable<string>): Map<string, string> {
  const colors = new Map<string, string>()
  for (const name of new Set(models)) {
    const hash = hashOf(name)
    const slot = hash % MODEL_PALETTE_SIZE
    const ladder = SLOT_SHADES[slot] ?? []
    // The slot consumed the low four bits, so the rung reads bits the slot did
    // not: the two decisions stay independent of each other and of the window.
    const rung = (hash >>> 5) % Math.max(ladder.length, 1)
    colors.set(name, ladder[rung] ?? MODEL_COLOR_OTHER)
  }
  return colors
}

/**
 * Fold raw model rows into normalized buckets while remembering which raw
 * spelling to show: the heaviest variant of each normalized name becomes its
 * display name (ties break alphabetically so the pick is deterministic).
 */
export function normalizeModelRows(rows: Iterable<{ model: string; total: number }>): Map<string, { display: string; total: number }> {
  const buckets = new Map<string, { display: string; displayTotal: number; total: number }>()
  for (const { model, total } of rows) {
    const key = normalizeModelName(model)
    const bucket = buckets.get(key) ?? { display: model, displayTotal: -1, total: 0 }
    bucket.total += total
    if (total > bucket.displayTotal || (total === bucket.displayTotal && model < bucket.display)) {
      bucket.display = model
      bucket.displayTotal = total
    }
    buckets.set(key, bucket)
  }
  const folded = new Map<string, { display: string; total: number }>()
  for (const [key, bucket] of buckets) folded.set(key, { display: bucket.display, total: bucket.total })
  return folded
}
