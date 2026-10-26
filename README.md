# @linxin666/dsh-usage — live-profile workspace

DSH Web GUI 的用量统计插件:按 provider 记录 token 账本、探测余额与编码套餐额度,并在侧栏
Settings 上方放一张紧凑的价格速览卡。
Usage statistics plugin for the DSH web GUI: per-provider balance and coding-plan
quota detection plus a live token usage ledger, with a compact price glance card
above the sidebar's Settings row.

> 本文件双语并列:每一节先中文,再英文,两种语言都能独立读完。
> This file is bilingual: each section gives the Chinese text first, then the
> English text, and either half reads on its own.

---

## 新增功能 · What's new in this build

### 中文

上一版是上游 0.4.8 加上账本相关的工作,面板提供 5 个窗口、一行汇总、逐日柱状图和渠道/模型
拆分。这一版新增下面这些内容。bug 修复和内部重构**有意不列**,它们都在 `git log` 里。

**8 个统计窗口。** 窗口条从 5 个磁贴变成 8 个:今日、昨日、近 3 天、近 7 天、近 30 天、
近 6 个月、全部、自定义。45 天以内的窗口按天累加;近 6 个月、全部,以及超过 45 天的自定义
区间,由一次 `GET /api/dsh-usage/range` 聚合查询给出,所以半年的视图不必再逐天抓两百次。

**一行汇总,顺带回答缓存到底值不值。** 汇总行现在有 6 格:总 tokens、输入、输出、缓存读、
缓存命中率、调用次数。命中率 = `cacheRead / (input + cacheRead + cacheWrite)`——判断
prompt 缓存是否划算时,看的就是这个数。

**撑得住长窗口的趋势图。** 原来的逐日柱状图换成 `TrendChart`:45 天以内按天分桶,46–200 天
按周,更长按月;网格线取 1/2/5×10ⁿ,悬浮提示给出总量、调用次数、命中率和前三名模型,没有
记录的日子明确标「无记录」。

**一个模型一种颜色,到处一致。** 柱子按模型堆叠,同一个模型在趋势图、渠道条、模型子条、
图例和悬浮提示里都是同一种颜色。颜色由**归一化后的模型名**做稳定哈希、在 16 色色板上取位
得到,所以同一个模型在任何窗口都是同一个颜色;只有大小写或 `provider/` 前缀不同的写法
(`DeepSeek-V4.1-Flash` 与 `deepseek-v4.1-flash`)会归一成同一个模型,而不是拆成两种颜色。

**拆分列出每一个模型,不只是前三名。** 每个渠道先画一条按模型堆叠的条,再把这个 host 返回
的**每一个**模型都列出来(协议单渠道上限 12 行),每行一条同色子条。渠道行以**窗口总量**
为分母,所以它的长度就是这个渠道在窗口里的占比;模型行以**自己的渠道**为分母,读起来就是
「这个渠道怎么分」。渠道行用更重的字重,模型行整体压暗一档,两个层级一眼能分开。

**从侧栏一步到面板。** 点侧栏底部的用量卡,直接打开 设置 · 使用统计,不用再走账号菜单。
做法是请 shell 的 registry 打开设置页(先合成一次 Ctrl+, 按键,这是平台的默认快捷键);
如果 500 ms 内面板没出现,才退回账号菜单那条路。

### English

The previous commit was upstream 0.4.8 plus the ledger work, and its panel
offered five windows, a totals line, a per-day bar chart and a channel/model
breakdown. This build adds the following. Bug fixes and internal refactors are
left out on purpose — they are in `git log`.

**Eight statistic windows.** The strip grew from five tiles to eight: 今日,
昨日, 近 3 天, 近 7 天, 近 30 天, 近 6 个月, 全部 and 自定义. Windows up to 45
days are summed day by day; 近 6 个月, 全部 and any custom range wider than 45
days are answered by one `GET /api/dsh-usage/range` aggregate, so a six-month
view no longer has to fetch two hundred days one at a time.

**A totals row that answers the cache question.** The row now states six cells:
total tokens, input, output, cache read, cache-hit ratio and calls. The ratio is
`cacheRead / (input + cacheRead + cacheWrite)` — the number you want when judging
whether the prompt cache is paying for itself.

**A trend chart that survives long windows.** `TrendChart` replaces the old
per-day bars: daily buckets up to 45 days, weekly from 46 to 200, monthly beyond
that, with 1/2/5×10ⁿ gridlines, a hover tooltip (totals, calls, hit ratio, top
three models) and an explicit 无记录 label on days with nothing recorded.

**One colour per model, everywhere.** Bars are stacked by model, and each model
keeps a single hue across the trend chart, the channel bars, the model rows, the
legend and the tooltip. Colours come from a stable hash of the normalized model
name over a sixteen-hue palette, so a model looks the same in every window, and
spellings that differ only by letter case or by a `provider/` prefix
(`DeepSeek-V4.1-Flash` and `deepseek-v4.1-flash`) fold into one model instead of
splitting into two colours.

**A breakdown that shows every model, not just the top three.** Each channel
draws one bar stacked by its models, then lists every model the host returned
(the wire caps a provider at twelve rows) with a sub-bar in the same hue. The
channel row measures against the window total, so its length is that channel's
share of the window; the model rows measure against their own channel, so they
read as how that channel splits. The channel header carries the heavier type and
the sub-rows sit one step lighter, which keeps the two levels apart at a glance.

**One click from the sidebar to the panel.** Clicking the usage card at the
bottom of the sidebar opens 设置 · 使用统计 directly instead of going through the
account menu. It asks the shell's registry to open the settings page (a synthetic
Ctrl+, keydown, the platform default) and falls back to the account-menu path
only if the page has not appeared within 500 ms.

---

## 概览 · Overview

### 中文

`dsh-usage` 插件的完整仓库:既有源码、测试脚本和说明文档,也保存着 DSH 桌面 profile 里
**实际安装**的那一份(`$DSH_HOME/profiles/desktop/node_modules/@linxin666/dsh-usage`),
所以本地改动可以追溯、可以复现。在它之上有四类改动:

1. **使用统计面板重做**(浏览器半边,`lib/client.js`)——「设置 · 使用统计」这一节现在提供
   今日 / 昨日 / 近 3 天 / 近 7 天 / 近 30 天 / 近 6 个月 / 全部 / 自定义 8 个窗口,每个
   窗口给出该窗口的汇总、趋势图,以及按渠道和按模型的拆分。
2. **会话日志回填**(host 半边,`lib/index.js`)——插件挂载之前发生的用量从会话日志里补读
   回来。它现在由 `src/` 构建,所以一次普通构建就能产出;早期手工打的补丁留在
   [`patches/`](patches/),只用于回滚。
3. **多设备账本**(两边都改)——每台机器写自己的 `usage-ledger.<device>.json`;总览把所有
   设备文件相加,任意设备都能导出自己的账本、导入同伴的账本。导入是替换该同伴的文件而不是
   合并,所以同一个文件导入两次不会重复计数。详见
   [`docs/multi-device.md`](docs/multi-device.md)。
4. **合并上游 0.4.8**——DeepSeek 峰谷价标签,以及能识别代理的 loopback 校验
   (`isProxiedRequest()`):带 `x-forwarded-for` 或 `cf-connecting-ip` 的请求不再被当作
   本机直连,堵住了 GUI 挂在反向代理后面时的鉴权绕过。

基线是 npm 上正式发布的 **0.4.8**,已在本地合并;这不是上游仓库的 fork,只带上面这些改动。

### English

Working copy of the `dsh-usage` plugin as it is **actually installed** in the
DSH desktop profile
(`$DSH_HOME/profiles/desktop/node_modules/@linxin666/dsh-usage`),
plus the sources, harnesses and notes behind the local modifications:

1. **Usage panel redesign** (browser half, `lib/client.js`) — the
   "设置 · 使用统计" section now offers 今日 / 昨日 / 近 3 天 / 近 7 天 / 近 30 天 /
   近 6 个月 / 全部 / 自定义 windows, each showing that window's totals, a trend
   chart and the per-channel + per-model breakdown.
2. **Session-log backfill** (host half, `lib/index.js`) — counts usage that
   happened before the plugin mounted, read from the session logs. Now part of
   `src/`, so a plain build produces it; the old hand-applied patch is kept in
   [`patches/`](patches/) for rollback only.
3. **Multi-device ledgers** (both halves) — each machine keeps its own
   `usage-ledger.<device>.json`; the overview sums every device file, and any
   device can export its own ledger and import a peer's. Importing replaces
   that peer's file, never merges into it, so importing the same file twice
   cannot double-count. See [`docs/multi-device.md`](docs/multi-device.md).
4. **Upstream 0.4.8 merge** — the DeepSeek peak/off-peak badge, and a
   proxy-aware loopback guard (`isProxiedRequest()`): requests carrying
   `x-forwarded-for` or `cf-connecting-ip` no longer count as loopback, which
   closes an auth bypass when the GUI is exposed through a reverse proxy.

Baseline is the published npm release **0.4.8**, merged locally; this workspace
is not a fork of the upstream repo, it only carries the changes above.

---

## 环境要求 · Requirements

### 中文

| 项 | 要求 |
| --- | --- |
| Node | `^22.19.0` 或 `>=24.0.0` |
| DSH | `>=0.2.1-rc.2` |
| React | `^18.2.0`(peer) |
| 许可证 | Apache-2.0 |

### English

| Item | Requirement |
| --- | --- |
| Node | `^22.19.0` or `>=24.0.0` |
| DSH | `>=0.2.1-rc.2` |
| React | `^18.2.0` (peer) |
| License | Apache-2.0 |

---

## 目录 · Layout

### 中文

| 路径 | 说明 |
| --- | --- |
| `packages/dsh-usage/` | 插件包本体:`src/`(权威 TS 源码)、`lib/`(构建产物)、`package.json`、`tsconfig*.json`、`tsdown.config.ts`,以及打包资产(`cordis.patch.yml`、`icon.svg`、README、`LICENSE`)。 |
| `shared/tsdown.client.ts` | 客户端打包预设(`clientBundle()` / `clientConfig()`,来自上游 monorepo),`packages/dsh-usage/tsdown.config.ts` 依赖它。 |
| `shared/web-platform.ts` | `PLATFORM_MODULES`:浏览器包里允许向 shell 外部引用的模块清单。 |
| `harness/render-test.mjs` | jsdom 渲染测试:用保存下来的线上 fixture 挂载构建产物,断言 60 条事实,覆盖 8 个窗口、汇总行、趋势图、渠道拆分、设备同步卡和 DeepSeek 峰谷标签。 |
| `harness/host-test.mjs` | host 侧测试(86 条),用 Node 的类型剥离直接跑 `src/`:设备 id、导出/导入、账本相加、旧版迁移、会话日志回填、range 聚合、loopback 校验和峰谷时钟。 |
| `harness/build-test-bundle.cjs` | 从构建好的 `lib/client.js` 派生出 `harness/client.test.cjs`,只多插一行测试需要的导出。 |
| `harness/make-panel-html.cjs` | 生成 `harness/panel.html`,一个自包含页面,用于无头截图。 |
| `fixtures/` | 2026-10-20 抓取的线上 `/api/dsh-usage` 响应(总览 + 4 天记录)。 |
| `patches/` | 早期的回填补丁、应用脚本,以及改动前的产物包,用于回滚。 |
| `preview/` | 重做后的截图(已签收)。 |
| `reference/upstream-0.4.8/` | 原封不动的 0.4.8 `src/` + `package.json`,用于对比升级。 |
| `docs/` | 文档。 |

### English

| Path | What it is |
| --- | --- |
| `packages/dsh-usage/` | The plugin package: `src/` (authoritative TS source), `lib/` (build output), `package.json`, `tsconfig*.json`, `tsdown.config.ts`, packaging assets (`cordis.patch.yml`, `icon.svg`, READMEs, `LICENSE`). |
| `shared/tsdown.client.ts` | The client-bundle preset (`clientBundle()` / `clientConfig()` from the upstream monorepo) — required by `packages/dsh-usage/tsdown.config.ts`. |
| `shared/web-platform.ts` | `PLATFORM_MODULES`: the externals the browser bundle may require from the shell. |
| `harness/render-test.mjs` | jsdom render test: mounts the built bundle with saved live fixtures and asserts 60 facts about the eight windows, the totals row, the trend chart, the channel breakdown, the device-sync card and the DeepSeek peak badge. |
| `harness/host-test.mjs` | Host-side tests (86 checks), run straight off `src/` with Node type stripping: device ids, export/import, ledger summing, legacy migration, transcript backfill, the range aggregate, the loopback fence and the peak clock. |
| `harness/build-test-bundle.cjs` | Derives `harness/client.test.cjs` from the built `lib/client.js` by adding one export line the test needs. |
| `harness/make-panel-html.cjs` | Builds `harness/panel.html`, a self-contained page for headless screenshots. |
| `fixtures/` | Live `/api/dsh-usage` responses captured 2026-10-20 (overview + 4 recorded days). |
| `patches/` | The legacy backfill patch, its appliers, and the pre-change bundles for rollback. |
| `preview/` | Signed-off screenshots of the redesign. |
| `reference/upstream-0.4.8/` | Pristine published 0.4.8 `src/` + `package.json`, for upgrade diffs. |
| `docs/` | This documentation. |

---

## 快速开始 · Quick start

### 中文

```bash
pnpm install --frozen-lockfile                     # 从 pnpm-lock.yaml 装工具链
cd packages/dsh-usage && ../../node_modules/.bin/tsc -b tsconfig.build.json \
  && ../../node_modules/.bin/tsdown                # 构建(~100 ms,exit 0)
cd ../.. && node harness/build-test-bundle.cjs && node harness/render-test.mjs
node --experimental-strip-types harness/host-test.mjs
```

期望输出:`=== 60/60 checks passed ===` 和 `=== 86/86 checks passed ===`。
`node_modules/` 已被 git 忽略,所以新克隆的仓库要先装依赖;构建能逐字节复现已提交的产物。

### English

```bash
pnpm install --frozen-lockfile                     # toolchain from pnpm-lock.yaml
cd packages/dsh-usage && ../../node_modules/.bin/tsc -b tsconfig.build.json \
  && ../../node_modules/.bin/tsdown                # build (~100 ms, exit 0)
cd ../.. && node harness/build-test-bundle.cjs && node harness/render-test.mjs
node --experimental-strip-types harness/host-test.mjs
```

Expected: `=== 60/60 checks passed ===` and `=== 86/86 checks passed ===`.
`node_modules/` is git-ignored, so a fresh clone must run the install first;
the build reproduces the committed artifacts byte-for-byte.

---

## 安装到其他机器 · Install on another machine

### 中文

profile 通常把 `@linxin666/dsh-usage` 钉在 registry 的某个版本上。这对本仓库是个问题:
profile 里任何别的插件的安装、升级或卸载都会重新解析这个 pin,并**覆盖这份拷贝**
(2026-10-20 04:17 已经发生过一次)。改成指向 git 依赖后,拷贝就稳定了——pnpm 把 commit
钉住,无关的包也不会再碰它。

**只把包装上还不够——profile 必须同时在 `dsh.profile.bundles` 里列出它**,否则 host 根本
不会加载。host 是从这个列表构建补丁层的,不是从 `node_modules`:

```js
// DSH host 里的 loadProfileDirectory()
const bundles = readProfileManifest(binName, dir).dsh?.profile?.bundles ?? [];
for (const packageName of bundles) { /* resolve, read dsh.bundle.patch, load */ }
```

装了但没进 `bundles` 的包等于从未被访问:没有 `cordis.patch.yml` 层、没有路由、没有面板。
插件管理器和插件市场会替你把两件事都做掉(它们的安装流程会追加 bundle);而单纯 `pnpm add`
只做了第一件。所以要么走插件管理器/市场安装,要么手工两步都做:

```bash
cd "${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
pnpm remove @linxin666/dsh-usage
pnpm add "git+https://github.com/<you>/dsh-usage.git#path:/packages/dsh-usage"
node -e '
  const fs = require("fs");
  const p = "package.json";
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  m.dsh ??= {}; m.dsh.profile ??= {};
  const b = m.dsh.profile.bundles ??= [];
  if (!b.includes("@linxin666/dsh-usage")) {
    b.push("@linxin666/dsh-usage");
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
    console.log("added to dsh.profile.bundles");
  } else console.log("already in dsh.profile.bundles");
'
```

追加顺序只在有 `before`/`after` 声明的 bundle 之间才有意义;这个插件没有声明。之后
**重启 DSH**:host bundle 在启动时一次性进 ESM 图,所以新的 host 路由要重启(只改客户端
半边的话,刷新页面即可)。

`#path:/packages/dsh-usage` 是必需的:插件在仓库的子目录里,不在根目录。连不上远端时,
本地克隆也一样:

```bash
pnpm add "git+file:///E:/path/to/dsh-usage/.git#path:/packages/dsh-usage"
# 或者,目录本身不是 git checkout:
pnpm add "file:E:/path/to/dsh-usage/packages/dsh-usage"
```

`github:<owner>/<repo>` 是同一件事的简写,本仓库的远端就是这种写法:

```
"@linxin666/dsh-usage": "github:beici/dsh-usage-for-personal-use#path:/packages/dsh-usage"
```

pnpm 会把这个 spec 写进 `package.json`,并解析成钉住 commit 的 codeload tarball
(`pnpm-lock.yaml` 里形如 `…/tar.gz/<sha>#path:/packages/dsh-usage`),所以装出来的是一份
普通拷贝,不是链接。这有两个后果:别的插件再安装也覆盖不掉这份拷贝;而**新提交不会自己
过来**——推完之后要重跑一次 `pnpm add`(或用 `pnpm update @linxin666/dsh-usage` 跟到分支
头),此后 `patches/install-patches.sh` 就不再需要了,因为树本身已经来自这个仓库。验证用
`patches/audit-store.sh` 加上面的哈希表。

POSIX 风格的路径用 `file:` 会失败(`ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`)——Windows 上要传
Windows 路径(`cygpath -w`)。在 pnpm 的 `hoisted` linker 下,两种写法装出来的都是真拷贝而
不是符号链接,所以**改 `src/` 不会更新已安装的机器**——重新构建、提交,再跑一次 `pnpm add`
(或 `pnpm update @linxin666/dsh-usage`)。

这些命令最后会以 `ERR_PNPM_IGNORED_BUILDS`(koffi、node-pty、protobufjs……)收尾。那是
profile 里既有的噪声,不是失败:插件已经就位,构建由把
`node_modules/@linxin666/dsh-usage/lib/client.js` 对下面的表做哈希来验证。

部署、重载行为与回滚见 [`docs/build-and-redeploy.md`](docs/build-and-redeploy.md);
新面板的设计见 [`docs/usage-panel-redesign.md`](docs/usage-panel-redesign.md);
设备文件、导出/导入与合并见 [`docs/multi-device.md`](docs/multi-device.md);
上游基线与补丁清单见 [`docs/upstream-and-local-patches.md`](docs/upstream-and-local-patches.md)。

### English

The profile normally pins `@linxin666/dsh-usage` to a registry version. That is
a problem for this workspace: any other plugin install, update or removal in
the profile re-resolves the pin and **overwrites the copy** (this already
happened once, on 2026-10-20 04:17). Pointing the profile at a git dependency
instead makes the copy stable — pnpm pins the commit, and unrelated packages no
longer touch it.

**Installing the package is not enough — the profile must also list it in
`dsh.profile.bundles`, or the host never loads it.** The host builds its patch
layers from that list, not from `node_modules`:

```js
// loadProfileDirectory() in the DSH host
const bundles = readProfileManifest(binName, dir).dsh?.profile?.bundles ?? [];
for (const packageName of bundles) { /* resolve, read dsh.bundle.patch, load */ }
```

A package that is installed but absent from `bundles` is simply never visited:
no `cordis.patch.yml` layer, no routes, no panel. The plugin manager and the
market do both halves for you (their install flow appends the bundle); a bare
`pnpm add` does only the first. So either install through the plugin manager /
market, or do both steps by hand:

```bash
cd "${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
pnpm remove @linxin666/dsh-usage
pnpm add "git+https://github.com/<you>/dsh-usage.git#path:/packages/dsh-usage"
node -e '
  const fs = require("fs");
  const p = "package.json";
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  m.dsh ??= {}; m.dsh.profile ??= {};
  const b = m.dsh.profile.bundles ??= [];
  if (!b.includes("@linxin666/dsh-usage")) {
    b.push("@linxin666/dsh-usage");
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
    console.log("added to dsh.profile.bundles");
  } else console.log("already in dsh.profile.bundles");
'
```

The append order matters only against bundles that declare `before`/`after`
rules; this one declares none. Then **restart DSH**: the host bundle is loaded
into the ESM graph once at boot, so a new host route needs a restart (a client
half alone would reload on page refresh).

`#path:/packages/dsh-usage` is required: the plugin lives in a subdirectory of
the repository, not at its root. On a machine without network access to the
remote, a local clone works the same way:

```bash
pnpm add "git+file:///E:/path/to/dsh-usage/.git#path:/packages/dsh-usage"
# or, for a plain directory that is not a git checkout:
pnpm add "file:E:/path/to/dsh-usage/packages/dsh-usage"
```

`github:<owner>/<repo>` is shorthand for the same thing and is what this
machine's profile uses:

```
"@linxin666/dsh-usage": "github:beici/dsh-usage-for-personal-use#path:/packages/dsh-usage"
```

pnpm writes that spec into `package.json` and resolves it to a codeload tarball
pinned to the commit (`…/tar.gz/<sha>#path:/packages/dsh-usage` in
`pnpm-lock.yaml`), so the installed tree is a plain copy, not a link. Two
consequences: another plugin's install can no longer overwrite it, and **new
commits do not arrive by themselves** — re-run the `pnpm add` once you have
pushed (or `pnpm update @linxin666/dsh-usage` to move to the branch head), then
`patches/install-patches.sh` is no longer needed because the tree already came
from this repo. Verify with `patches/audit-store.sh` plus the hash table above.

`file:` on POSIX-style paths fails (`ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`) —
pass a Windows path (`cygpath -w`) on Windows. Under pnpm's `hoisted` linker
both forms install a real copy, not a symlink, so **editing `src/` does not
update an installed machine** — rebuild, commit and re-run `pnpm add` (or
`pnpm update @linxin666/dsh-usage`).

pnpm ends these commands with `ERR_PNPM_IGNORED_BUILDS` (koffi, node-pty,
protobufjs, ...). That is pre-existing profile noise, not a failure: the
plugin is already in place, and the build is verified by hashing
`node_modules/@linxin666/dsh-usage/lib/client.js` against the table below.

Deployment, reload behaviour and rollback: [`docs/build-and-redeploy.md`](docs/build-and-redeploy.md).
Design of the new panel: [`docs/usage-panel-redesign.md`](docs/usage-panel-redesign.md).
Device files, export/import and merging: [`docs/multi-device.md`](docs/multi-device.md).
Upstream baseline and patch inventory: [`docs/upstream-and-local-patches.md`](docs/upstream-and-local-patches.md).

---

## 产物哈希 · Current artifact hashes

### 中文

本仓库构建的产物,带 8 窗口统计条、缓存命中格、`TrendChart`、按份额成比例的渠道条、等长的
子条轨道、按渠道尺度绘制的模型子条、更重的渠道标题,以及由 registry 打开的设置面板
(2026-10-26 核对):

| 文件 | 大小 | MD5 |
| --- | --- | --- |
| `lib/client.js` | 481,720 B | `8d75aa5e96692cf89bef548d161305fb` |
| `lib/client.js.map` | 605,803 B | `d7e5dc9bbf589f2c8131a896009763e1` |
| `lib/index.js` | 111,688 B | `8ff29bd29b0db52395b0e6458b2f6d87` |

`lib/client.js.map` 会把源码原样嵌进去,所以只有源码用 LF 换行时才能复现
(`.gitattributes` 在 checkout 时强制 `eol=lf`)。工作区里留着 CRLF 的源码时,map 会变大、
哈希也对不上,而 `client.js` 本身不变。请让 `src/` 保持 LF。

两边现在都从 `src/` 构建,所以 `lib/index.js` 和已安装副本是同一个产物——没有构建后的打补
丁步骤。部署就是一次普通拷贝,但要注意部署文档里提到的两个坑:在 profile 里跑
`pnpm install` 会把包重置回 registry tarball;`cp` 到 pnpm 硬链接上会穿透写入
content-addressed store。

### English

This workspace build, with the 8-window statistics strip, the cache-hit cell,
the TrendChart, share-proportional channel bars, uniform sub-bar tracks, the
channel-scale model sub-bars, the heavier channel headers and the
registry-invoked settings opener (verified 2026-10-26):

| File | Size | MD5 |
| --- | --- | --- |
| `lib/client.js` | 481,720 B | `8d75aa5e96692cf89bef548d161305fb` |
| `lib/client.js.map` | 605,803 B | `d7e5dc9bbf589f2c8131a896009763e1` |
| `lib/index.js` | 111,688 B | `8ff29bd29b0db52395b0e6458b2f6d87` |

`lib/client.js.map` embeds the sources verbatim, so it is only reproducible when
the source files use LF endings (`.gitattributes` enforces `eol=lf` in the
checkout). A worktree left with CRLF sources produces a larger, differently
hashed map while `client.js` itself stays identical. Keep `src/` LF.

Both halves now build from `src/`, so `lib/index.js` and the installed copy are
the same artifact — no post-build patching step. Deploying is a plain copy, but
note the two hazards in the deployment doc: a `pnpm install` in the profile
resets the package to the registry tarball, and `cp` onto a pnpm hardlink
writes through to the content-addressed store.

---

## 截图 · Screenshots

### 中文

今日、近 30 天与自定义区间(完整页面见 `preview/panel.html`)。

### English

Today, last 30 days and a custom range (full page in `preview/panel.html`).

![今日](preview/final-today.png)
![近 30 天](preview/final-last30.png)
![自定义区间](preview/shot-custom.png)

---

## 许可证 · License

Apache-2.0。见 [`packages/dsh-usage/LICENSE`](packages/dsh-usage/LICENSE)。
Licensed under the Apache License 2.0 — see
[`packages/dsh-usage/LICENSE`](packages/dsh-usage/LICENSE).
