/**
 * The usage statistics settings section: three tabs (用量: one time window
 * picked from 今日 / 昨日 / 近 3 天 / 近 7 天 / 近 30 天 / 近 6 个月 / 近 1 年 /
 * 自定义, rendered as window totals plus the per-channel and per-model
 * breakdown and the trend chart, with balances below; 个人套餐: per-provider
 * plan quota windows; Token 银行: the whale-yuan voucher minted from the
 * DeepSeek official family's usage) plus a compact settings row.
 *
 * Data: today and the whole-ledger aggregates ride the host's loopback-fenced
 * /api/dsh-usage/overview document. A window at most RANGE_FETCH_MAX_DAYS
 * long is merged in the browser from one small `/api/dsh-usage/day` request
 * per day the ledger recorded inside the window (the overview lists those
 * days); a longer one reads a single `/api/dsh-usage/range` aggregate instead
 * — one request answering the whole-window summary plus the per-day series,
 * which is what makes the multi-month windows viable. Merged days and fetched
 * ranges are cached for the session. Polling runs only while the section is
 * mounted and the tab is visible.
 * @module @linxin666/dsh-usage/client/UsageSectionCard
 */
import { type ReactNode } from 'react';
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client';
import type { UsageStoreInstance } from './usage-store.ts';
import { type DeviceSyncApi } from './DeviceSyncCard.tsx';
import { type UsageDayView, type UsageRangeResponse } from '../core/types.ts';
export { formatTokens } from './format.ts';
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
    /**
     * Fetch one window aggregate (from/to local-date keys) from the host:
     * whole-window totals, the per-provider per-model breakdown, and the
     * per-day series, in one request. Windows past RANGE_FETCH_MAX_DAYS read
     * this instead of one request per recorded day.
     */
    loadRange: (from: string, to: string) => Promise<UsageRangeResponse>;
    /** The shared configuration form this section's settings row reads and writes. */
    settings: ConfigForm<UsageSettings>;
    /** Manual cross-device ledger export/import (absent on an older host face). */
    deviceSync?: DeviceSyncApi;
}
export interface UsageSectionProps extends UsageSectionFace {
    /** Close the settings panel (the shell owns the open state). */
    close: () => void;
}
/** The section component; the slot merges the face into these props. */
export declare function UsageSectionCard(props: UsageSectionProps): ReactNode;
