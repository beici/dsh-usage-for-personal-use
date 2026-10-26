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
 * name's rung is its order inside the slot, so two colliding names land two
 * rungs apart instead of on the same color.
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
export declare const MODEL_COLOR_OTHER = "#6f6f78";
/** How many models the palette distinguishes before the gray tail. */
export declare const MODEL_PALETTE_SIZE = 16;
/** The color identity of a model: `prefix/`-stripped, trimmed, lower-cased. */
export declare function normalizeModelName(model: string): string;
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
 * else's hue. The rung is the name's order inside its slot, stepped by two, so
 * consecutive names of one slot are as far apart on the ladder as it goes.
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
