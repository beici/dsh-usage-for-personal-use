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
 * windows and independent of how much it ran. The hues themselves live in
 * usage.module.css as CSS variables with a light and a dark variant, so the
 * colors ride the theme instead of being baked in here.
 *
 * A slot is only sixteen hues wide, so two names do collide in it — and the
 * slot used to be the whole color, which painted the second model of a channel
 * exactly like the first. A name's color now has a second axis: a shade of its
 * slot mixed toward white or black. Both axes come from the name, so a model
 * keeps its color in every window and the order the names arrive in never
 * matters; only a full hash coincidence in both axes can repeat a color.
 * @module @linxin666/dsh-usage/client/model-colors
 */

/** Fill for models past the palette (the collapsed tail). */
export const MODEL_COLOR_OTHER = 'var(--dsw-chart-other)'

/** How many models the palette distinguishes before the gray tail. */
export const MODEL_PALETTE_SIZE = 16

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

/** Lowest share of the slot hue a shade keeps, in percent. */
const SHADE_MIN_PERCENT = 58

/** Percent steps a shade walks above the minimum (58 % … 92 %). */
const SHADE_SPAN = 35

/** Shades a slot can carry: the hue itself plus white and black at every step. */
const SHADE_COUNT = SHADE_SPAN * 2 + 1

/**
 * One slot in one shade: shade 0 is the slot's own hue (`--dsw-chart-N`), every
 * other shade mixes that hue toward white or black, walking 58 % … 92 % of the
 * hue. A shade therefore reads as the same hue in a lighter or darker tone —
 * apart from its slot neighbour, but never so far that it leaves the light/dark
 * skin the palette defines.
 */
function slotColor(slot: number, shade: number): string {
  const hue = `var(--dsw-chart-${slot + 1})`
  if (shade === 0) return hue
  const percent = SHADE_MIN_PERCENT + Math.ceil(shade / 2) - 1
  return `color-mix(in srgb, ${hue} ${percent}%, ${shade % 2 === 1 ? 'white' : 'black'})`
}

/**
 * Assign one palette color per normalized model name.
 *
 * The hue slot is `hash(name) % paletteSize` and nothing else — deliberately not
 * "the next free slot", which made a name's hue depend on which other names
 * happened to be in the same window: two models took chart-1 and chart-2, and a
 * window showing only the second recolored it to chart-1. Stability is the whole
 * promise of this table (the trend bars, the channel bars and the model rows
 * share it, and the user learns the colors), so a collision between two of the
 * sixteen hues is resolved by the shade axis instead of by shifting someone
 * else's hue: the bits above the slot pick a white/black mix of that same hue,
 * which keeps the pair apart without letting any other name move.
 */
export function assignModelColors(models: Iterable<string>): Map<string, string> {
  const colors = new Map<string, string>()
  for (const name of new Set(models)) {
    const hash = hashOf(name)
    colors.set(name, slotColor(hash % MODEL_PALETTE_SIZE, Math.floor(hash / MODEL_PALETTE_SIZE) % SHADE_COUNT))
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
