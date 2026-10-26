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
 * Palette slots are assigned by a stable hash of the normalized name with
 * linear probing past taken slots — NOT by usage rank. Rank assignment pinned
 * chart-1 (blue) onto whatever model leads the current window, so the
 * dominant model was blue in every window and the whole table reshuffled
 * whenever the tile changed; hashing keeps a model's hue constant across
 * windows and independent of how much it ran. The hues themselves live in
 * usage.module.css as CSS variables with a light and a dark variant, so the
 * colors ride the theme instead of being baked in here.
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

/**
 * Assign one palette color per normalized model name. Names walk in hash
 * order (deterministic whatever order callers walk in) and each takes its
 * hash's preferred slot, bumping forward past taken ones, so an assignment
 * changes only when the collision chain it sits on changes. Names past the
 * palette stay out of the map and fall back to MODEL_COLOR_OTHER.
 */
export function assignModelColors(models: Iterable<string>): Map<string, string> {
  const names = [...new Set(models)].sort((left, right) => hashOf(left) - hashOf(right) || (left < right ? -1 : 1))
  const taken = new Set<number>()
  const colors = new Map<string, string>()
  for (const name of names) {
    if (colors.size >= MODEL_PALETTE_SIZE) break
    let slot = hashOf(name) % MODEL_PALETTE_SIZE
    while (taken.has(slot)) slot = (slot + 1) % MODEL_PALETTE_SIZE
    taken.add(slot)
    colors.set(name, `var(--dsw-chart-${slot + 1})`)
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
