/**
 * Number formatting shared by the usage section, its foot card, and the trend
 * chart — one home so a tile, a stat cell, and a tooltip always print the same
 * magnitude the same way.
 * @module @linxin666/dsh-usage/client/format
 */
/** Compact token count: 12345 -> 12.3k, 1234567 -> 1.23M. */
export declare function formatTokens(value: number): string;
