/**
 * dsh-usage locale dictionaries (zh/en). The zh dictionary is the key source;
 * `en` mirrors its full key set (packages/AGENTS.md bilingual discipline).
 * @module @linxin666/dsh-usage/client/locales
 */
/** Dictionary namespace this package registers. */
export declare const NS = "dsh-web-ui-usage";
/** Chinese copy. */
export declare const zh: {
    'usage.title': string;
    'usage.tab.usage': string;
    'usage.tab.plans': string;
    'usage.tab.bank': string;
    'usage.refresh': string;
    'usage.refreshing': string;
    'usage.updated': string;
    'usage.loading': string;
    'usage.error': string;
    'usage.error.network': string;
    'usage.disabled': string;
    'usage.current': string;
    'usage.today': string;
    'usage.today.cost': string;
    'usage.day.label': string;
    'usage.day.today': string;
    'usage.day.title': string;
    'usage.day.cost': string;
    'usage.day.empty': string;
    'usage.day.loading': string;
    'usage.day.error': string;
    'usage.peak.on': string;
    'usage.peak.off': string;
    'usage.peak.tag.on': string;
    'usage.peak.tag.off': string;
    'usage.peak.ends': string;
    'usage.peak.starts': string;
    'usage.calls': string;
    'usage.tokens.total': string;
    'usage.tokens.input': string;
    'usage.tokens.output': string;
    'usage.tokens.cacheRead': string;
    'usage.tokens.cacheHit': string;
    'usage.trend': string;
    'usage.trend.label': string;
    'usage.range.title': string;
    'usage.range.today': string;
    'usage.range.yesterday': string;
    'usage.range.last7': string;
    'usage.range.last30': string;
    'usage.range.last3': string;
    'usage.range.last180': string;
    'usage.range.all': string;
    'usage.range.custom': string;
    'usage.range.customFrom': string;
    'usage.range.customTo': string;
    'usage.range.customPick': string;
    'usage.range.customPrompt': string;
    'usage.range.span': string;
    'usage.range.detail': string;
    'usage.range.channels': string;
    'usage.range.cost': string;
    'usage.range.empty': string;
    'usage.range.noRecord': string;
    'usage.range.loadFailed': string;
    'usage.range.loading': string;
    'usage.range.error': string;
    'usage.noData': string;
    'usage.balance': string;
    'usage.balance.unsupported': string;
    'usage.balance.noCredential': string;
    'usage.balance.noneConfigured': string;
    'usage.oauth': string;
    'usage.plan.reset': string;
    'usage.plan.noPlan': string;
    'usage.plan.noneConfigured': string;
    'usage.plan.windows.5h': string;
    'usage.plan.windows.week': string;
    'usage.plan.windows.month': string;
    'usage.plan.windows.other': string;
    'usage.plan.unit.hour': string;
    'usage.plan.unit.day': string;
    'usage.plan.unit.week': string;
    'usage.plan.unit.month': string;
    'usage.provider.error': string;
    'usage.errorListSeparator': string;
    'usage.config.title': string;
    'usage.config.enabled': string;
    'usage.config.pollIntervalSec': string;
    'usage.config.saveFailed': string;
    'usage.bank.title': string;
    'usage.bank.hint': string;
    'usage.bank.noUsage': string;
    'usage.bank.minted': string;
    'usage.bank.spend.observed': string;
    'usage.bank.spend.estimated': string;
    'usage.bank.window': string;
    'usage.bank.windowAll': string;
    'usage.bank.save': string;
    'usage.bank.share': string;
    'usage.bank.drawError': string;
    'usage.foot.cost': string;
    'usage.foot.noData': string;
    'usage.foot.open': string;
    'usage.foot.collapse': string;
    'usage.foot.expand': string;
    'usage.device.title': string;
    'usage.device.hint': string;
    'usage.device.local': string;
    'usage.device.peer': string;
    'usage.device.id': string;
    'usage.device.copyId': string;
    'usage.device.copied': string;
    'usage.device.none': string;
    'usage.device.error': string;
    'usage.ledger.error': string;
    'usage.ledger.note': string;
    'usage.stale': string;
    'usage.device.export': string;
    'usage.device.import': string;
    'usage.device.importing': string;
    'usage.device.imported': string;
    'usage.device.importSame': string;
    'usage.device.importFailed': string;
    'usage.device.dropHint': string;
    'usage.device.rescan': string;
};
/** English mirror; every zh key present. */
export declare const en: Record<UsageKey, string>;
export type UsageKey = keyof typeof zh;
/**
 * Active dictionary, picked by the document language at call time. The
 * section resolves its copy the same tiny way the pet's DOM-injected surface
 * does (the settings section has no framework locale seat of its own).
 */
export declare function dictionary(): Record<UsageKey, string>;
/** Translate a key with optional `{name}` template params; missing keys degrade to the key. */
export declare function t(key: string, params?: Record<string, unknown>): string;
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** dsh-usage UI copy. */
        'dsh-web-ui-usage': UsageKey;
    }
}
