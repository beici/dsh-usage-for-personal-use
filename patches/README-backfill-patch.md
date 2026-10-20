# dsh-usage 0.4.7 —— 会话日志回填补丁

本目录是 `@linxin666/dsh-usage@0.4.7` 的**本地热修补丁**及其工具。插件更新或 `pnpm install` 重装会覆盖 `node_modules` 里的文件，补丁需要重新应用。

## 为什么打这个补丁

上游 0.4.7 的用量统计有三个已实测的缺口（全部在本机复现）：

1. **只统计「插件挂载之后」的事件**。`start()` 里只挂 `ctx.on("session/event", ...)`，没有任何历史扫描；插件安装前的历史（本机 10-19 全部 + 10-20 前半段约 94M tokens）永远不会进账。
2. **挂载后到下一次 `request/header` 之间的事件被静默丢弃**。`onSessionEvent` 的 `assistant/message` 分支要求 `sessionRoutes.get(session)` 存在，否则 `return`。实测重启窗口内丢了 13 条事件（in 61 万 / cacheRead 763 万）。
3. 事件时间用 `Date.now()` 而不是事件自带的 `event.time`，跨日回放会记到错误日期。

## 补了什么（7 个 hunk，`lib/index.js` 83496B → 92154B）

| # | 位置 | 改动 |
|---|------|------|
| 1 | 导入区 | `node:fs/promises` 增加 `readdir`/`stat`；新增 `node:zlib` 的 `zstdDecompressSync` |
| 2 | `usage-service` region 前 | 新增 `session-log-backfill` region（180 行）：手写 zstd 多帧遍历（`zstdDecompressSync` 只解第一帧）、`transcriptTotals`、`foldTranscript`、两层 `listSessionLogs`、`collectSessionLogUsage` |
| 3 | 类字段 | 新增 `loadPromise;` |
| 4 | `start()` | `this.loadPromise = this.loadPersisted();`（改前不持有 promise） |
| 5 | `onSessionEvent` | 无路由时回退 `event.data.message?.source` 的 provider/model 并写回缓存；fold 时间用 `event.time` |
| 6 | `loadPersisted()` finally + 新方法 | `await this.backfillSessionLogs(); this.loaded = true; this.scheduleFlush();`；`backfillSessionLogs()` 按桶 `totalTokens` 取大者整桶替换（幂等、自愈，不丢日志里没有的旧桶） |
| 7 | `writeLedgerOnce()` | 开头 `await this.loadPromise`，避免回填未完成时先写盘 |

## 文件

- `index.orig-0.4.7.js` —— 上游 0.4.7 原件（83496B）
- `index.patched-0.4.7.js` —— 打好补丁的 0.4.7（92154B）
- `apply-patch.sh` —— 重装后重新打补丁：`bash apply-patch.sh [包目录]`（默认 desktop profile 的 dsh-usage；已打过会直接退出，非 0.4.7 会 WARNING）
- `verify-backfill.cjs` —— 核对覆盖率：扫 `~/.dsh/sessions/**/session.*.jsonl.zstd` 的真值 vs `usage-ledger.json`，逐 `day|provider` 打印覆盖率

## 生效方式

ESM 模块图在宿主进程内缓存，改盘上源码**不会**热生效（loader 无文件监听、无 reload 通道）。必须重启 DSH 桌面端：

1. 托盘右键 →「退出应用」，或关闭窗口后从开始菜单重开
2. 重启后跑 `node patches/verify-backfill.cjs`（在项目根目录执行）应当得到覆盖率 100%

补丁在生效前不会破坏任何东西：旧实例继续按旧逻辑写盘，回填只在启动时跑一次，且合并规则是「取大者」，不会把已正确记录的数字改小。

## 已知边界

- 只认 `assistant/message` 事件里带 `data.usage` 且 `data.message.source.provider` 非空的记录（本机 731 条全部满足）
- 会话文件上限 256MB/个、最多 2048 个文件；解不出的帧直接跳过
- 合并键是 `(本地日, provider, model)`；若某桶被外部写大过真值，max 会保留那个偏大值（当前无此证据）
- 补丁只动 `lib/index.js`，不碰 client 半区，UI 无需变化
