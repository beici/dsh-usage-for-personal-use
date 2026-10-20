/**
 * The usage statistics settings section: three tabs (用量: one time window
 * picked from 今日 / 昨日 / 近 7 天 / 近 30 天 / 自定义, rendered as window
 * totals plus the per-channel and per-model breakdown and a per-day bar chart,
 * with balances below; 个人套餐: per-provider plan quota windows; Token 银行:
 * the whale-yuan voucher minted from the DeepSeek official family's usage)
 * plus a compact settings row.
 *
 * Data: today and the whole-ledger aggregates ride the host's loopback-fenced
 * /api/dsh-usage/overview document. Any window that reaches past today is
 * merged in the browser from one small `/api/dsh-usage/day` request per day
 * the ledger recorded inside the window (the overview lists those days), so a
 * window costs a handful of cheap loopback requests at most and the merged
 * days are cached for the session. Polling runs only while the section is
 * mounted and the tab is visible.
 * @module @linxin666/dsh-usage/client/UsageSectionCard
 */
import { type ReactNode } from 'react';
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client';
import type { UsageStoreInstance } from './usage-store.ts';
import { type DeviceSyncApi } from './DeviceSyncCard.tsx';
import { type UsageDayView } from '../core/types.ts';
/** The settings fields this section edits (immediate-apply semantics). */
export interface UsageSettings {
    enabled?: boolean;
    pollIntervalSec?: number;
}
/** The registration-side face the section's slot entry injects. */
export interface UsageSectionFace {
    /** The section-local store (overview snapshot + lifecycle). */
    store: UsageStoreInstance;
    /** Fetch one overview now. */
    poll: () => void;
    /** Force a host probe cycle now (resolves with the fresh overview). */
    refresh: () => void;
    /**
     * Fetch one retained local day (YYYY-MM-DD) from the host. The overview
     * only carries today plus the list of recorded days, so a window that
     * reaches past today is one small on-demand request per recorded day.
     */
    loadDay: (date: string) => Promise<UsageDayView>;
    /** The shared configuration form this section's settings row reads and writes. */
    settings: ConfigForm<UsageSettings>;
    /** Manual cross-device ledger export/import (absent on an older host face). */
    deviceSync?: DeviceSyncApi;
}
export interface UsageSectionProps extends UsageSectionFace {
    /** Close the settings panel (the shell owns the open state). */
    close: () => void;
}
/** Compact token count: 12345 -> 12.3k, 1234567 -> 1.23M. */
export declare function formatTokens(value: number): string;
/** The section component; the slot merges the face into these props. */
export declare function UsageSectionCard(props: UsageSectionProps): ReactNode;
