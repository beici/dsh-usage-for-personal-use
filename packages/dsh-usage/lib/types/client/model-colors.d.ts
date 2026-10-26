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
export declare const MODEL_COLOR_OTHER = "var(--dsw-chart-other)";
/** How many models the palette distinguishes before the gray tail. */
export declare const MODEL_PALETTE_SIZE = 16;
/** The color identity of a model: `prefix/`-stripped, trimmed, lower-cased. */
export declare function normalizeModelName(model: string): string;
/**
 * Assign one palette color per normalized model name. Names walk in hash
 * order (deterministic whatever order callers walk in) and each takes its
 * hash's preferred slot, bumping forward past taken ones, so an assignment
 * changes only when the collision chain it sits on changes. Names past the
 * palette stay out of the map and fall back to MODEL_COLOR_OTHER.
 */
export declare function assignModelColors(models: Iterable<string>): Map<string, string>;
/**
 * Fold raw model rows into normalized buckets while remembering which raw
 * spelling to show: the heaviest variant of each normalized name becomes its
 * display name (ties break alphabetically so the pick is deterministic).
 */
export declare function normalizeModelRows(rows: Iterable<{
    model: string;
    total: number;
}>): Map<string, {
    display: string;
    total: number;
}>;
