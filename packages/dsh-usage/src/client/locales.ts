/**
 * dsh-usage locale dictionaries (zh/en). The zh dictionary is the key source;
 * `en` mirrors its full key set (packages/AGENTS.md bilingual discipline).
 * @module @linxin666/dsh-usage/client/locales
 */

/** Dictionary namespace this package registers. */
export const NS = 'dsh-web-ui-usage'

/** Chinese copy. */
export const zh = {
  'usage.title': '使用统计',
  'usage.tab.usage': '用量',
  'usage.tab.plans': '个人套餐',
  'usage.tab.bank': 'Token 银行',
  'usage.refresh': '刷新',
  'usage.refreshing': '刷新中…',
  'usage.updated': '更新于 {time}',
  'usage.loading': '正在加载用量数据…',
  'usage.error': '加载失败：{error}',
  'usage.error.network': '网络请求失败，请检查与 DSH 的连接',
  // A transport error carries the route and the status code; the code is the
  // only part a user can act on, so it gets a sentence of its own.
  'usage.error.status': '请求失败（HTTP {status}），请稍后再试',
  // Anything else (an abort, a mangled body) is not something the user can read
  // raw: the raw text stays in the tooltip.
  'usage.error.unknown': '请求失败，请稍后再试',
  // A read of a local file is not a request: the ledger and the device files
  // need their own sentence when the host reports no recognisable cause.
  'usage.error.readFailed': '读取失败',
  'usage.disabled': '插件已停用：勾选下方「启用插件」即可恢复统计。',
  'usage.current': '当前',
  'usage.today': '今日用量',
  'usage.day.label': '查看日期',
  'usage.day.today': '今日',
  'usage.day.loading': '正在加载该日用量…',
  'usage.day.error': '该日用量加载失败：{error}',
  'usage.peak.on': 'DeepSeek 高峰时段：计价 ×2，{time} 结束',
  'usage.peak.off': 'DeepSeek 空闲时段：计价为高峰一半，{time} 进入高峰',
  'usage.peak.tag.on': '高峰',
  'usage.peak.tag.off': '空闲',
  'usage.peak.ends': '{time} 结束',
  'usage.peak.starts': '{time} 进入高峰',
  'usage.calls': '{n} 次调用',
  // The stat cell already prints the count as its value; the label names the
  // unit only, so the same number is not stated twice.
  'usage.callsLabel': '次调用',
  'usage.tokens.total': '总 tokens',
  'usage.tokens.input': '输入',
  'usage.tokens.output': '输出',
  'usage.tokens.cacheRead': '缓存读',
  'usage.tokens.cacheHit': '缓存命中',
  'usage.trend.label': '用量趋势图：{from} 至 {to}，合计 {tokens}',
  // A failed aggregate leaves the total unmeasured: the label states the span
  // and the failure instead of a number nothing backs.
  'usage.trend.labelFailed': '用量趋势图：{from} 至 {to}，部分日期加载失败',
  'usage.trend.labelPartial': '用量趋势图：{from} 至 {to}，仅已加载的日期合计 {tokens}',
  // A window that failed whole has no bars to draw: one line says so instead.
  'usage.trend.loadFailed': '该时间段加载失败，暂无趋势数据',
  'usage.trend.tooFewDays': '还不足两天，画不出趋势',
  'usage.range.title': '统计窗口',
  'usage.range.today': '今日',
  'usage.range.yesterday': '昨日',
  'usage.range.last7': '近 7 天',
  'usage.range.last30': '近 30 天',
  'usage.range.last3': '近 3 天',
  'usage.range.last180': '近 6 个月',
  'usage.range.all': '全部',
  'usage.range.custom': '自定义',
  'usage.range.customFrom': '开始',
  'usage.range.customTo': '结束',
  'usage.range.customPick': '选择日期',
  'usage.range.customPrompt': '选择开始与结束日期以查看该区间的渠道与模型用量',
  'usage.range.span': '{from} ~ {to}',
  'usage.range.detail': '{label}用量',
  'usage.range.channels': '各渠道 / 各模型',
  'usage.range.cost': '消费（估算）',
  'usage.range.empty': '该时间范围内没有用量记录',
  'usage.range.noRecord': '无记录',
  'usage.range.loadFailed': '加载失败',
  'usage.range.loading': '正在加载该时间范围的用量…',
  'usage.range.error': '部分日期加载失败：{error}',
  'usage.noData': '暂无用量数据（统计自插件启用起）',
  'usage.balance': '余额',
  'usage.balance.unsupported': '暂不支持余额查询',
  'usage.balance.noCredential': '未配置凭据',
  'usage.balance.noneConfigured': '没有已配置的提供方',
  'usage.oauth': 'OAuth 凭据，不做余额查询',
  'usage.plan.reset': '{date} 重置',
  'usage.plan.noPlan': '未检测到套餐数据',
  'usage.plan.noneConfigured': '没有已配置的套餐类 provider（如 Kimi、GLM、OpenCode Go、MiniMax、Codex 订阅）',
  'usage.plan.windows.5h': '5 小时',
  'usage.plan.windows.week': '每周',
  'usage.plan.windows.month': '每月',
  'usage.plan.windows.other': '额度窗口',
  'usage.plan.unit.hour': '小时',
  'usage.plan.unit.day': '天',
  'usage.plan.unit.week': '周',
  'usage.plan.unit.month': '个月',
  'usage.provider.error': '查询失败：{error}',
  'usage.errorListSeparator': '；',
  'usage.config.title': '设置',
  'usage.config.enabled': '启用插件',
  'usage.config.pollIntervalSec': '轮询间隔（秒）',
  'usage.config.saveFailed': '保存失败：设置未被接受。',
  'usage.bank.title': '鲸元券',
  'usage.bank.hint': 'DeepSeek 官方 API 与 MiMo 每满 100 万 tokens 铸造 1 鲸元（不足 1 枚按 1 枚计）；保存或分享这张票券。',
  'usage.bank.noUsage': '暂无 DeepSeek 官方 / MiMo 用量数据（统计自插件启用起）',
  'usage.bank.minted': '累计铸造 {minted} 鲸元（{tokens} tokens）',
  'usage.bank.spend.observed': '官方余额实测花费 ¥{cost}（自 {since} 起）',
  'usage.bank.spend.estimated': '消费估算：约 ¥{cost}',
  'usage.bank.window': '统计窗口 {from} ~ {to}',
  'usage.bank.windowAll': '全部保留期',
  'usage.bank.save': '保存图片',
  'usage.bank.saving': '正在生成…',
  'usage.bank.share': '分享',
  'usage.bank.drawError': '票券生成失败：{error}',
  'usage.bank.saveError': '票券保存失败：{error}',
  'usage.foot.cost': '今日消费',
  'usage.foot.noData': '今日暂无用量',
  'usage.foot.open': '打开使用统计设置',
  'usage.foot.collapse': '收起用量卡片',
  'usage.foot.expand': '展开用量卡片',
  'usage.device.title': '多端汇总',
  'usage.device.hint': '每台机器只写自己的用量文件，总览把它们相加；导入别人的文件只替换那一台的数据，不会覆盖本机记录。',
  'usage.device.local': '本机',
  'usage.device.peer': '已导入',
  'usage.device.copyId': '复制标识',
  'usage.device.copied': '已复制',
  'usage.device.none': '只有本机数据',
  'usage.device.error': '部分文件无法读取：{error}',
  'usage.ledger.error': '账本读取异常，下面的数字可能不完整：{error}',
  'usage.ledger.note': '说明：{note}',
  // Full-width comma: the sentence is Chinese prose, so a half-width mark reads
  // as a typo between two CJK characters.
  'usage.stale': '上次刷新失败（{error}），下面是 {time} 的数据',
  'usage.device.export': '导出本机用量',
  // A notice states what happened, so it cannot reuse the button label: the
  // past tense is what tells a finished action from an offered one.
  'usage.device.exported': '已导出本机用量',
  'usage.device.exportFailed': '导出失败：{error}',
  'usage.device.import': '导入其他设备',
  'usage.device.importing': '导入中…',
  'usage.device.imported': '已导入 {deviceId} 的用量',
  'usage.device.importSame': '这个文件就是本机导出的，无需导入。',
  'usage.device.importFailed': '导入失败：{error}',
  'usage.device.dropHint': '也可以把导出的 .json 文件直接放进 ~/.dsh/dsh-usage/ 后点「重新扫描」。',
  'usage.device.rescan': '重新扫描',
  'usage.device.rescanned': '已重新扫描',
  'usage.device.rescanFailed': '重新扫描失败：{error}',
}

/** English mirror; every zh key present. */
export const en: Record<UsageKey, string> = {
  'usage.title': 'Usage Statistics',
  'usage.tab.usage': 'Usage',
  'usage.tab.plans': 'Plans',
  'usage.tab.bank': 'Token Bank',
  'usage.refresh': 'Refresh',
  'usage.refreshing': 'Refreshing…',
  'usage.updated': 'Updated {time}',
  'usage.loading': 'Loading usage data…',
  'usage.error': 'Failed to load: {error}',
  'usage.error.network': 'Network request failed. Check the connection to DSH.',
  'usage.error.status': 'Request failed (HTTP {status}). Try again in a moment.',
  'usage.error.unknown': 'The request failed. Try again in a moment.',
  'usage.error.readFailed': 'Read failed',
  'usage.disabled': 'Plugin disabled. Tick "Enable plugin" below to resume statistics.',
  'usage.current': 'Current',
  'usage.today': 'Today',
  'usage.day.label': 'Day',
  'usage.day.today': 'Today',
  'usage.day.loading': 'Loading that day…',
  'usage.day.error': 'Failed to load that day: {error}',
  'usage.peak.on': 'DeepSeek peak hours: 2x pricing, ends {time}',
  'usage.peak.off': 'DeepSeek off-peak: half of peak pricing, peak returns {time}',
  'usage.peak.tag.on': 'Peak',
  'usage.peak.tag.off': 'Off-peak',
  'usage.peak.ends': 'ends {time}',
  'usage.peak.starts': 'peak at {time}',
  'usage.calls': '{n} calls',
  'usage.callsLabel': 'calls',
  'usage.tokens.total': 'Total tokens',
  'usage.tokens.input': 'Input',
  'usage.tokens.output': 'Output',
  'usage.tokens.cacheRead': 'Cache read',
  'usage.tokens.cacheHit': 'Cache hit',
  'usage.trend.label': 'Usage trend: {from} to {to}, {tokens} in total',
  'usage.trend.labelFailed': 'Usage trend: {from} to {to}, some days failed to load',
  'usage.trend.labelPartial': 'Usage trend: {from} to {to}, {tokens} across the days that loaded',
  'usage.trend.loadFailed': 'This window failed to load, so there is no trend to show',
  'usage.trend.tooFewDays': 'Not enough days yet to draw a trend',
  'usage.range.title': 'Time window',
  'usage.range.today': 'Today',
  'usage.range.yesterday': 'Yesterday',
  'usage.range.last7': 'Last 7 days',
  'usage.range.last30': 'Last 30 days',
  'usage.range.last3': 'Last 3 days',
  'usage.range.last180': 'Last 6 months',
  'usage.range.all': 'All',
  'usage.range.custom': 'Custom',
  'usage.range.customFrom': 'From',
  'usage.range.customTo': 'To',
  'usage.range.customPick': 'Pick dates',
  'usage.range.customPrompt': 'Pick a start and end date to see channel and model usage for that span',
  'usage.range.span': '{from} - {to}',
  'usage.range.detail': '{label} usage',
  'usage.range.channels': 'By channel and model',
  'usage.range.cost': 'Spend (estimated)',
  'usage.range.empty': 'No usage recorded in this window',
  'usage.range.noRecord': 'No usage recorded',
  'usage.range.loadFailed': 'Failed to load',
  'usage.range.loading': 'Loading this window…',
  'usage.range.error': 'Some days failed to load: {error}',
  'usage.noData': 'No usage data yet (counting starts when the plugin is enabled)',
  'usage.balance': 'Balance',
  'usage.balance.unsupported': 'Balance query not supported',
  'usage.balance.noCredential': 'No credential configured',
  'usage.balance.noneConfigured': 'No providers configured',
  'usage.oauth': 'OAuth credential, no balance query',
  'usage.plan.reset': 'resets {date}',
  'usage.plan.noPlan': 'No plan data detected',
  'usage.plan.noneConfigured': 'No plan-capable provider configured (such as Kimi, GLM, OpenCode Go, MiniMax, Codex subscription)',
  'usage.plan.windows.5h': '5 hours',
  'usage.plan.windows.week': 'Weekly',
  'usage.plan.windows.month': 'Monthly',
  'usage.plan.windows.other': 'Quota window',
  'usage.plan.unit.hour': 'hours',
  'usage.plan.unit.day': 'days',
  'usage.plan.unit.week': 'weeks',
  'usage.plan.unit.month': 'months',
  'usage.provider.error': 'Query failed: {error}',
  'usage.errorListSeparator': '; ',
  'usage.config.title': 'Settings',
  'usage.config.enabled': 'Enable plugin',
  'usage.config.pollIntervalSec': 'Poll interval (seconds)',
  'usage.config.saveFailed': 'Save failed: the deployment did not accept the setting.',
  'usage.bank.title': 'Whale-yuan voucher',
  'usage.bank.hint': 'Every full 1,000,000 tokens spent on the DeepSeek official API or on MiMo mint one whale yuan (a note is never worth less than one); save or share the note.',
  'usage.bank.noUsage': 'No DeepSeek official or MiMo usage yet (counting starts when the plugin is enabled)',
  'usage.bank.minted': 'Minted {minted} whale yuan ({tokens} tokens)',
  'usage.bank.spend.observed': 'Spent ¥{cost} observed on the official balance (watching since {since})',
  'usage.bank.spend.estimated': 'Estimated spend: about ¥{cost}',
  'usage.bank.window': 'Window {from} - {to}',
  'usage.bank.windowAll': 'All retained days',
  'usage.bank.save': 'Save image',
  'usage.bank.saving': 'Rendering…',
  'usage.bank.share': 'Share',
  'usage.bank.drawError': 'Failed to render the voucher: {error}',
  'usage.bank.saveError': 'Failed to save the voucher: {error}',
  'usage.foot.cost': 'Today spend',
  'usage.foot.noData': 'No usage yet today',
  'usage.foot.open': 'Open usage statistics settings',
  'usage.foot.collapse': 'Collapse the usage card',
  'usage.foot.expand': 'Expand the usage card',
  'usage.device.title': 'Devices',
  'usage.device.hint': 'Each machine writes only its own usage file and the totals above sum them; importing another device replaces that device file and never overwrites this machine history.',
  'usage.device.local': 'This device',
  'usage.device.peer': 'Imported',
  'usage.device.copyId': 'Copy id',
  'usage.device.copied': 'Copied',
  'usage.device.none': 'This device only',
  'usage.device.error': 'Some files could not be read: {error}',
  'usage.ledger.error': 'The usage ledger could not be read, so the numbers below may be incomplete: {error}',
  'usage.ledger.note': 'Note: {note}',
  'usage.stale': 'Last refresh failed ({error}); the numbers below are from {time}',
  'usage.device.export': 'Export this device',
  'usage.device.exported': 'Exported this device',
  'usage.device.exportFailed': 'Export failed: {error}',
  'usage.device.import': 'Import another device',
  'usage.device.importing': 'Importing…',
  'usage.device.imported': 'Imported usage from {deviceId}',
  'usage.device.importSame': 'That file was exported by this device; nothing to import.',
  'usage.device.importFailed': 'Import failed: {error}',
  'usage.device.dropHint': 'You can also drop an exported .json into ~/.dsh/dsh-usage/ and press Rescan.',
  'usage.device.rescan': 'Rescan',
  'usage.device.rescanned': 'Rescanned',
  'usage.device.rescanFailed': 'Rescan failed: {error}',
}

export type UsageKey = keyof typeof zh

/**
 * Active dictionary, picked by the document language at call time. The
 * section resolves its copy the same tiny way the pet's DOM-injected surface
 * does (the settings section has no framework locale seat of its own).
 */
export function dictionary(): Record<UsageKey, string> {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'zh'
  return lang.toLowerCase().startsWith('en') ? en : zh
}

/** Translate a key with optional `{name}` template params; missing keys degrade to the key. */
export function t(key: string, params?: Record<string, unknown>): string {
  let text: string = (dictionary() as Record<string, string>)[key] ?? key
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-usage UI copy. */
    'dsh-web-ui-usage': UsageKey
  }
}
