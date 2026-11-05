# Baizer 插件审核扫描分类清单（扫描读取日 2026-11-04）

> 本文档是 issue #69「插件审核：自动化扫描 2972 条 warning 的分类治理」的**分类清单与治理台账**。
> 目的：把 Obsidian 社区插件审核页面上的一串聚合数字，拆成「规则 + 文件 + 数量」的可追溯条目，
> 并给出可本地复现的度量手段。
>
> 配套的可复现度量工具在 [`tools/plugin-review-baseline/`](../../tools/plugin-review-baseline/README.md)。
>
> **本文所有数字都来自下列两处证据之一，没有估算值：**
> 1. 审核页面自身的 Next.js RSC payload（解码后逐项读取），落地为 [`scan-inventory.json`](scan-inventory.json)；
> 2. 干净检出（fix 之前）上捕获的 type-aware ESLint JSON 输出，聚合为
>    [`baseline-pristine.json`](../../tools/plugin-review-baseline/metrics/baseline-pristine.json)。
>
> 凡是推断、未复核、或本地无对应项的地方，均已显式标注。

---

## 1. 来源与扫描版本

| 项 | 值 |
| --- | --- |
| 页面 URL | <https://community.obsidian.md/plugins/baizer#scorecard> |
| 读取日期 | 2026-11-04 |
| 页面结论原文 | `3002 issues found by automated scans of the latest release.` |
| 页面分区徽章 | `Warnings` = 2972，`Other` = 30，`Passed` = 5，`Disclosures` = 4 |
| 扫描代码链接指向的 release commit | `65020a8862aeaf88d41a2e164a7f779c3281ddd0` |
| 扫描器 | Obsidian 社区插件审核系统自带 linter，**未开源**，规则集无法直接获取 |
| 原始证据（未入库） | 解码后的 RSC flight payload；页面 HTML 原始快照 |
| 提取脚本（已入库） | [`tools/plugin-review-baseline/extract-scorecard.mjs`](../../tools/plugin-review-baseline/extract-scorecard.mjs) |
| 结构化产物（已入库） | [`scan-inventory.json`](scan-inventory.json) |

**关于扫描版本的重要说明**：页面上的代码位置链接全部指向 release commit
`65020a8862aeaf88d41a2e164a7f779c3281ddd0`。本文第 4 节的本地复现是在**当前 `main`**（即本次治理的
工作分支基线）上跑的，两者不是同一棵树。因此第 4 节只能做**逐文件分布的形状对比**，不能做逐行对齐。

页面标题里的「2972 条 warning」指的是 `Warnings` 分区的合计，不是 3002。3002 是
`Warnings (2972)` + `Other (30)` 之和，这一等式由页面自身两个分区徽章给出，见 §2.2。

---

## 2. 完整分类清单

### 2.1 34 类清单（与已提取的 `categories2.json` 逐项对应）

下表 34 行按页面顺序排列。数量一列是页面徽章上的数字（单条定位的类别页面不渲染徽章，计 1）。
「规则 id」一列**只填页面自己直接印出来的规则 id**；页面没有印出的留 `—`，其规则归属见 §4.1。

| # | 分区 | 类别文本（页面原文，截断） | 数量 | 规则 id（页面直出） | 示例位置 |
| ---: | --- | --- | ---: | --- | --- |
| 1 | Warnings | Unsafe member access on an `error` or `any` typed value | 1150 | `@typescript-eslint/no-unsafe-member-access` | `main.ts#L204`<br>`main.ts#L328` |
| 2 | Warnings | Unexpected any. Specify a different type. | 553 | — | `main.ts#L68`<br>`main.ts#L203` |
| 3 | Warnings | Unsafe assignment of an `error` or `any` typed value | 458 | `@typescript-eslint/no-unsafe-assignment` | `main.ts#L324`<br>`main.ts#L325` |
| 4 | Warnings | Unsafe call of an `error` or `any` typed value | 370 | `@typescript-eslint/no-unsafe-call` | `main.ts#L480`<br>`main.ts#L542` |
| 5 | Warnings | Passes unsafe values into typed parameters | 157 | `@typescript-eslint/no-unsafe-argument` | `main.ts#L601`<br>`main.ts#L645` |
| 6 | Warnings | Returns unsafe values from typed code | 71 | `@typescript-eslint/no-unsafe-return` | `main.ts#L88`<br>`main.ts#L195` |
| 7 | Warnings | This assertion is unnecessary since it does not change the type of the expression. | 46 | — | `main.ts#L328`<br>`main.ts#L329` |
| 8 | Warnings | Avoid !important — override styles by increasing selector specificity or using CSS variables instead. | 24 | — | `styles.css#L6`<br>`styles.css#L11` |
| 9 | Warnings | Use 'window.setTimeout()' instead of 'setTimeout()' for popout window compatibility. | 19 | — | `src/knowledge/runtime.ts#L209`<br>`src/knowledge/watcher.ts#L101` |
| 10 | Warnings | Use 'window.clearTimeout()' instead of 'clearTimeout()' for popout window compatibility. | 15 | — | `src/memory/hindsight-types.ts#L112`<br>`src/memory/hindsight-types.ts#L113` |
| 11 | Warnings | This assertion is unnecessary since the receiver accepts the original type of the expression. | 13 | — | `src/memory/hindsight-store.ts#L354`<br>`src/runtime/pi/harness-chat-runtime.ts#L134` |
| 12 | Warnings | Promise returned in function argument where a void return was expected. | 13 | — | `src/settings.ts#L2238-L2249`<br>`src/settings.ts#L2284-L2299` |
| 13 | Warnings | Uses `document.createElement` instead of Obsidian's `createEl` helpers | 10 | `obsidianmd/prefer-create-el` | `src/settings.ts#L676`<br>`src/ui/ghost-text.ts#L28` |
| 14 | Warnings | Avoid using 'globalThis'. Use 'window' or 'activeWindow' for popout window compatibility. | 9 | — | `src/runtime/pi/anthropic-sdk-shim.ts#L352`<br>`src/runtime/pi/anthropic-sdk-shim.ts#L356` |
| 15 | Warnings | Promises must be awaited, end with a call to .catch, end with a call to .then with a rejection handler or be … | 8 | — | `main.ts#L263`<br>`main.ts#L319` |
| 16 | Warnings | Obsidian's configuration folder is not necessarily `.obsidian`, it can be configured by the user. Use `Vault#… | 8 | — | `src/memory/hindsight-migration.ts#L17`<br>`src/runtime/pi/harness-env.ts#L46` |
| 17 | Warnings | 'any' overrides all other types in this union type. | 8 | — | `src/memory/hindsight-migration.ts#L34`<br>`src/memory/hindsight-migration.ts#L36` |
| 18 | Warnings | Empty block statement. | 4 | — | `src/knowledge/file-back.ts#L105`<br>`src/knowledge/linter.ts#L180` |
| 19 | Warnings | Use 'FileManager.trashFile()' instead of 'Vault.trash()' to respect the user's file deletion preference. | 4 | — | `src/knowledge/indexer.ts#L94`<br>`src/knowledge/indexer.ts#L107` |
| 20 | Warnings | Avoid :has — it can cause significant performance issues due to broad selector invalidation. | 4 | — | `styles.css#L10`<br>`styles.css#L15` |
| 21 | Warnings | Unnecessary escape character: \). | 3 | — | `main.ts#L453`<br>`src/services/clip-input.ts#L13` |
| 22 | Warnings | Unnecessary escape character: \[. | 3 | — | `src/knowledge/runtime.ts#L418`<br>`src/knowledge/runtime.ts#L450` |
| 23 | Warnings | Avoid unnecessary logging to console | 2 | — | `src/settings.ts#L3487`<br>`src/utils/logger.ts#L89` |
| 24 | Warnings | Unexpected lexical declaration in case block. | 2 | — | `src/ui/chat-controller.ts#L346`<br>`src/ui/chat-controller.ts#L347` |
| 25 | Warnings | A method that is not declared with `this: void` may cause unintentional scoping of `this` when separated from… | 2 | — | `src/ui/guardian-completion.ts#L555`<br>`src/ui/guardian-completion.ts#L556` |
| 26 | Warnings | Unexpected use of 'localStorage'. Prefer `App#saveLocalStorage` / `App#loadLocalStorage` functions to write /… | 2 | — | `src/ui/selection-ai/floating-panel.ts#L22`<br>`src/ui/selection-ai/floating-panel.ts#L33` |
| 27 | Warnings | Unexpected browser feature "css-display-contents" is only partially supported by Obsidian 1.6.5 | 2 | — | `styles.css#L972`<br>`styles.css#L3401` |
| 28 | Warnings | Unexpected browser feature "multicolumn" is only partially supported by Obsidian 1.6.5 | 2 | — | `styles.css#L2893`<br>`styles.css#L3393` |
| 29 | Other | '_' is defined but never used. | 8 | — | `src/skills/builtin/web-clipper/executor.ts#L84`<br>`src/skills/builtin/web-clipper/executor.ts#L174` |
| 30 | Other | 'e' is defined but never used. | 7 | — | `main.ts#L169`<br>`src/services/model-service.ts#L700` |
| 31 | Other | `sessionRef` is deprecated. 阶段A 起改用 sessionRefs(per-conversation)。保留字段仅供旧数据迁移。 旧版全局单会话的引用。loadSettings 会把它迁移到… | 3 | — | `src/services/model-service.ts#L172`<br>`src/services/model-service.ts#L173` |
| 32 | Other | Missing GitHub artifact attestations for release assets | 2 | — | — |
| 33 | Other | 'error' is defined but never used. | 2 | — | `src/services/model-service.ts#L160`<br>`src/services/model-service.ts#L668` |
| 34 | Other | `substr` is deprecated. A legacy feature for browser compatibility | 2 | — | `src/ui/chat-controller.ts#L754`<br>`src/ui/shell-view.ts#L942` |

**合计 = 2986**（28 条 `Warnings` 类别 2962 + 6 条 `Other` 类别 24）。

> 已逐项核对：这 34 行的数量序列与 `%TEMP%\categories2.json` 中 34 条的数量序列**完全一致**
> （1150, 553, 458, 370, 157, 71, 46, 24, 19, 15, 13, 13, 10, 9, 8, 8, 8, 4, 4, 4, 3, 3, 2, 2, 2, 2, 2, 2
> ／ 8, 7, 3, 2, 2, 2）。区别仅在于 `categories2.json` 的 `links` 字段对部分类别取错了集合
> （例如 `'_' is defined but never used.` 一条挂上了 1331 个链接），本文改用页面 payload 中该类别
> 自身的链接列表，因此位置数是可信的。

### 2.2 差额 16 的定位（2986 → 3002）

34 类清单合计 **2986**，页面报告总数 **3002**，差 **16**。

这 16 条**不需要推测**：页面自己的两个分区徽章给出了等式，且解码后的 payload 里能数出全部条目。

| 分区 | 徽章（页面） | payload 条目数 | 条目数量合计 | 一致？ |
| --- | ---: | ---: | ---: | --- |
| `Warnings` | 2972 | 38 | 2972 | ✅ |
| `Other` | 30 | 12 | 30 | ✅ |
| **合计** | — | 50 | **3002** | ✅ 与页面报告总数一致 |

`categories2.json` 只抽到了前 28 条 `Warnings`（`medium:0`–`medium:27`）和前 6 条 `Other`
（`info:0`–`info:5`），因此漏掉的是：

- **10 条 `Warnings`**：`medium:28`–`medium:37`，每条只有 1 个位置（其中 `medium:28`
  「Direct Filesystem Access」页面不给代码位置），合计 10；
- **6 条 `Other`**：`info:6`–`info:11`，每条只有 1 个位置，合计 6。

10 + 6 = **16**。§2.3 与 §2.4 给出这 50 条的完整清单。

> 也就是说：差额不是「页面少报了」，而是**先前的抽取只覆盖了折叠状态下可见的前 34 条**。
> 本文不再使用「剩余 16 条原因不明」的说法，因为 payload 已经把它们逐条列出来了。

### 2.3 `Warnings` 分区完整清单（38 项，合计 2972）

| 页面键 | 数量 | 规则 id（页面直出） | 页面列出位置数 | 示例位置 |
| --- | ---: | --- | ---: | --- |
| `medium:0` | 1150 | `@typescript-eslint/no-unsafe-member-access` | 953 | `main.ts#L204`<br>`main.ts#L328` |
| `medium:1` | 553 | — | 518 | `main.ts#L68`<br>`main.ts#L203` |
| `medium:2` | 458 | `@typescript-eslint/no-unsafe-assignment` | 442 | `main.ts#L324`<br>`main.ts#L325` |
| `medium:3` | 370 | `@typescript-eslint/no-unsafe-call` | 354 | `main.ts#L480`<br>`main.ts#L542` |
| `medium:4` | 157 | `@typescript-eslint/no-unsafe-argument` | 149 | `main.ts#L601`<br>`main.ts#L645` |
| `medium:5` | 71 | `@typescript-eslint/no-unsafe-return` | 71 | `main.ts#L88`<br>`main.ts#L195` |
| `medium:6` | 46 | — | 43 | `main.ts#L328`<br>`main.ts#L329` |
| `medium:7` | 24 | — | 24 | `styles.css#L6`<br>`styles.css#L11` |
| `medium:8` | 19 | — | 19 | `src/knowledge/runtime.ts#L209`<br>`src/knowledge/watcher.ts#L101` |
| `medium:9` | 15 | — | 15 | `src/memory/hindsight-types.ts#L112`<br>`src/memory/hindsight-types.ts#L113` |
| `medium:10` | 13 | — | 12 | `src/memory/hindsight-store.ts#L354`<br>`src/runtime/pi/harness-chat-runtime.ts#L134` |
| `medium:11` | 13 | — | 13 | `src/settings.ts#L2238-L2249`<br>`src/settings.ts#L2284-L2299` |
| `medium:12` | 10 | `obsidianmd/prefer-create-el` | 10 | `src/settings.ts#L676`<br>`src/ui/ghost-text.ts#L28` |
| `medium:13` | 9 | — | 9 | `src/runtime/pi/anthropic-sdk-shim.ts#L352`<br>`src/runtime/pi/anthropic-sdk-shim.ts#L356` |
| `medium:14` | 8 | — | 8 | `main.ts#L263`<br>`main.ts#L319` |
| `medium:15` | 8 | — | 7 | `src/memory/hindsight-migration.ts#L17`<br>`src/runtime/pi/harness-env.ts#L46` |
| `medium:16` | 8 | — | 8 | `src/memory/hindsight-migration.ts#L34`<br>`src/memory/hindsight-migration.ts#L36` |
| `medium:17` | 4 | — | 4 | `src/knowledge/file-back.ts#L105`<br>`src/knowledge/linter.ts#L180` |
| `medium:18` | 4 | — | 4 | `src/knowledge/indexer.ts#L94`<br>`src/knowledge/indexer.ts#L107` |
| `medium:19` | 4 | — | 4 | `styles.css#L10`<br>`styles.css#L15` |
| `medium:20` | 3 | — | 3 | `main.ts#L453`<br>`src/services/clip-input.ts#L13` |
| `medium:21` | 3 | — | 3 | `src/knowledge/runtime.ts#L418`<br>`src/knowledge/runtime.ts#L450` |
| `medium:22` | 2 | — | 2 | `src/settings.ts#L3487`<br>`src/utils/logger.ts#L89` |
| `medium:23` | 2 | — | 2 | `src/ui/chat-controller.ts#L346`<br>`src/ui/chat-controller.ts#L347` |
| `medium:24` | 2 | — | 2 | `src/ui/guardian-completion.ts#L555`<br>`src/ui/guardian-completion.ts#L556` |
| `medium:25` | 2 | — | 2 | `src/ui/selection-ai/floating-panel.ts#L22`<br>`src/ui/selection-ai/floating-panel.ts#L33` |
| `medium:26` | 2 | — | 2 | `styles.css#L972`<br>`styles.css#L3401` |
| `medium:27` | 2 | — | 2 | `styles.css#L2893`<br>`styles.css#L3393` |
| `medium:28` | 1 | — | 0 | — |
| `medium:29` | 1 | — | 1 | `src/knowledge/runtime.ts#L482` |
| `medium:30` | 1 | — | 1 | `src/services/clip-input.ts#L13` |
| `medium:31` | 1 | — | 1 | `src/services/clip-input.ts#L13` |
| `medium:32` | 1 | — | 1 | `src/services/video-transcription.ts#L113` |
| `medium:33` | 1 | — | 1 | `src/settings.ts#L1685` |
| `medium:34` | 1 | — | 1 | `src/ui/controllers/context-controller.ts#L48` |
| `medium:35` | 1 | — | 1 | `src/ui/selection-ai/selection-menu-state.ts#L192` |
| `medium:36` | 1 | — | 1 | `src/ui/shell-view.ts#L1152` |
| `medium:37` | 1 | — | 1 | `styles.css#L2362` |

### 2.4 `Other` 分区完整清单（12 项，合计 30）

`Other` 分区里的 `info:*` 与 `Disclosures` 分区里的 `info:*` **键名重复**（两个分区各自从
`info:0` 开始编号）。先前抽取把两个分区的条目混在一起，这也是 `categories2.json` 中
`info:0` 挂错链接的原因之一。下表是 `Other` 分区。

| 页面键 | 数量 | 规则 id（页面直出） | 页面列出位置数 | 示例位置 |
| --- | ---: | --- | ---: | --- |
| `info:0` | 8 | — | 8 | `src/skills/builtin/web-clipper/executor.ts#L84`<br>`src/skills/builtin/web-clipper/executor.ts#L174` |
| `info:1` | 7 | — | 7 | `main.ts#L169`<br>`src/services/model-service.ts#L700` |
| `info:2` | 3 | — | 3 | `src/services/model-service.ts#L172`<br>`src/services/model-service.ts#L173` |
| `info:3` | 2 | — | 0 | main.js, styles.css |
| `info:4` | 2 | — | 2 | `src/services/model-service.ts#L160`<br>`src/services/model-service.ts#L668` |
| `info:5` | 2 | — | 2 | `src/ui/chat-controller.ts#L754`<br>`src/ui/shell-view.ts#L942` |
| `info:6` | 1 | — | 0 | — |
| `info:7` | 1 | — | 0 | — |
| `info:8` | 1 | — | 1 | `src/services/model-service.ts#L617` |
| `info:9` | 1 | — | 1 | `src/settings.ts#L1470` |
| `info:10` | 1 | — | 1 | `src/ui/components/attachment-modal.ts#L143` |
| `info:11` | 1 | — | 1 | `src/ui/renderers/tool-renderer.ts#L234` |

---

## 3. Warning 与 Info / Passed 的区分

页面把审核结果分成四块：`Warnings`、`Other`、`Passed`、`Disclosures`。
**只有 `Warnings` 是「问题」**；`Other` 是提示性条目；`Passed` 与 `Disclosures` 是页面自报的
结论与披露，**不是独立验证过的发现**。

### 3.1 `Passed` 分区（5 项，页面自报）

| # | 页面文本 |
| ---: | --- |
| 0 | **Vault Read**：Reads individual vault files via the Obsidian API (`vault.read`, `vault.cachedRead`) |
| 1 | **Vault Write**：Creates or modifies vault files via the Obsidian API (`vault.modify`, `vault.create`, etc.) |
| 2 | No vulnerable dependencies found. |
| 3 | No obfuscation detected. |
| 4 | Build reproduced the release `main.js` byte-for-byte |

### 3.2 `Disclosures` 分区（4 项，页面自报）

| # | 页面文本 | 页面附带的取值 |
| ---: | --- | --- |
| 0 | Plugin might make requests to external domains | `api.bilibili.com` |
| 1 | Number of network request calls | `21 network calls` |
| 2 | Malware scan not available. | （无） |
| 3 | Network requests scan not available. | （无） |

### 3.3 结论：`Other` / `Passed` / `Disclosures` 均未经独立验证

- `Passed` 的 5 项（Vault Read/Write、无漏洞依赖、无混淆、构建可复现）**只是页面自报**。
  本任务**没有**独立复核依赖漏洞扫描、混淆检测或构建可复现性。
- `Disclosures` 的「外部域名 `api.bilibili.com`」「21 次网络调用」同样是**页面自报**。
  本任务没有独立抓包或审计出网行为。
- `Malware scan not available.` 与 `Network requests scan not available.` 表示**该两项扫描未执行**，
  既不是通过也不是失败，**不能当作已核查**。
- `Other` 的 12 条里，`_` / `e` / `error` / `err` / `_error` / `_providerId` 未使用变量、
  `sessionRef` / `substr` / `timeoutMs` 弃用、以及 GitHub artifact attestations 缺失，
  属于「提示」而非「阻断项」，但其中未使用变量与弃用 API 是**真实存在的代码事实**，可以修。

---

## 4. 与当前 `main` 的映射

本地复现手段：`tools/plugin-review-baseline/eslint.review.config.mjs`（type-aware ESLint，
`parserOptions.projectService: true`）。基线数字取自**干净检出**上捕获的 ESLint JSON 输出，
不是本次会话的实时跑分——`src/**` 正在被并发修改，实时跑分会被在途改动污染。

### 4.1 扫描类别 → ESLint 规则 → 本地复现计数

「本地复现」一列 = 在干净检出上该 ESLint 规则报出的条数。`—` 表示本地配置里没有对应规则，
**不代表该项不存在**，只代表当前 harness 覆盖不到（见 §7）。

| 页面键 | 扫描类别（截断） | 页面数量 | 映射到的 ESLint 规则 | 映射依据 | 本地该规则总数 | 备注 |
| --- | --- | ---: | --- | --- | ---: | --- |
| `medium:0` | Unsafe member access on an `error` or `any` typed value | 1150 | — | 无本地对应 | 0 |  |
| `medium:1` | Unexpected any. Specify a different type. | 553 | — | 无本地对应 | 0 |  |
| `medium:2` | Unsafe assignment of an `error` or `any` typed value | 458 | — | 无本地对应 | 0 |  |
| `medium:3` | Unsafe call of an `error` or `any` typed value | 370 | — | 无本地对应 | 0 |  |
| `medium:4` | Passes unsafe values into typed parameters | 157 | — | 无本地对应 | 0 |  |
| `medium:5` | Returns unsafe values from typed code | 71 | — | 无本地对应 | 0 |  |
| `medium:6` | This assertion is unnecessary since it does not change the type of th… | 46 | — | 无本地对应 | 0 |  |
| `medium:7` | Avoid !important — override styles by increasing selector specificity… | 24 | — | 无本地对应 | 0 |  |
| `medium:8` | Use 'window.setTimeout()' instead of 'setTimeout()' for popout window… | 19 | — | 无本地对应 | 0 |  |
| `medium:9` | Use 'window.clearTimeout()' instead of 'clearTimeout()' for popout wi… | 15 | — | 无本地对应 | 0 |  |
| `medium:10` | This assertion is unnecessary since the receiver accepts the original… | 13 | — | 无本地对应 | 0 |  |
| `medium:11` | Promise returned in function argument where a void return was expecte… | 13 | — | 无本地对应 | 0 |  |
| `medium:12` | Uses `document.createElement` instead of Obsidian's `createEl` helpers | 10 | — | 无本地对应 | 0 |  |
| `medium:13` | Avoid using 'globalThis'. Use 'window' or 'activeWindow' for popout w… | 9 | — | 无本地对应 | 0 |  |
| `medium:14` | Promises must be awaited, end with a call to .catch, end with a call … | 8 | — | 无本地对应 | 0 |  |
| `medium:15` | Obsidian's configuration folder is not necessarily `.obsidian`, it ca… | 8 | — | 无本地对应 | 0 |  |
| `medium:16` | 'any' overrides all other types in this union type. | 8 | — | 无本地对应 | 0 |  |
| `medium:17` | Empty block statement. | 4 | — | 无本地对应 | 0 |  |
| `medium:18` | Use 'FileManager.trashFile()' instead of 'Vault.trash()' to respect t… | 4 | — | 无本地对应 | 0 |  |
| `medium:19` | Avoid :has — it can cause significant performance issues due to broad… | 4 | — | 无本地对应 | 0 |  |
| `medium:20` | Unnecessary escape character: \). | 3 | — | 无本地对应 | 0 |  |
| `medium:21` | Unnecessary escape character: \[. | 3 | — | 无本地对应 | 0 |  |
| `medium:22` | Avoid unnecessary logging to console | 2 | — | 无本地对应 | 0 |  |
| `medium:23` | Unexpected lexical declaration in case block. | 2 | — | 无本地对应 | 0 |  |
| `medium:24` | A method that is not declared with `this: void` may cause unintention… | 2 | — | 无本地对应 | 0 |  |
| `medium:25` | Unexpected use of 'localStorage'. Prefer `App#saveLocalStorage` / `Ap… | 2 | — | 无本地对应 | 0 |  |
| `medium:26` | Unexpected browser feature "css-display-contents" is only partially s… | 2 | — | 无本地对应 | 0 |  |
| `medium:27` | Unexpected browser feature "multicolumn" is only partially supported … | 2 | — | 无本地对应 | 0 |  |
| `medium:28` | **Direct Filesystem Access**: Uses the Node.js `fs` module to access … | 1 | — | 无本地对应 | 0 |  |
| `medium:29` | Irregular whitespace not allowed. | 1 | — | 无本地对应 | 0 |  |
| `medium:30` | Unnecessary escape character: \.. | 1 | — | 无本地对应 | 0 |  |
| `medium:31` | Unnecessary escape character: \?. | 1 | — | 无本地对应 | 0 |  |
| `medium:32` | Unexpected use of 'fetch'. Use the built-in `requestUrl` function ins… | 1 | — | 无本地对应 | 0 |  |
| `medium:33` | This PluginSettingTab does not implement getSettingDefinitions(); its… | 1 | — | 无本地对应 | 0 |  |
| `medium:34` | Promise-returning function provided to property where a void return w… | 1 | — | 无本地对应 | 0 |  |
| `medium:35` | Use 'window.requestAnimationFrame()' instead of 'requestAnimationFram… | 1 | — | 无本地对应 | 0 |  |
| `medium:36` | Use 'window.clearInterval()' instead of 'clearInterval()' for popout … | 1 | — | 无本地对应 | 0 |  |
| `medium:37` | Unexpected duplicate "background" | 1 | — | 无本地对应 | 0 |  |
| `info:0` | '_' is defined but never used. | 8 | — | 无本地对应 | 0 |  |
| `info:1` | 'e' is defined but never used. | 7 | — | 无本地对应 | 0 |  |
| `info:2` | `sessionRef` is deprecated. 阶段A 起改用 sessionRefs(per-conversation)。保留字… | 3 | — | 无本地对应 | 0 |  |
| `info:3` | Missing GitHub artifact attestations for release assets | 2 | — | 无本地对应 | 0 |  |
| `info:4` | 'error' is defined but never used. | 2 | — | 无本地对应 | 0 |  |
| `info:5` | `substr` is deprecated. A legacy feature for browser compatibility | 2 | — | 无本地对应 | 0 |  |
| `info:6` | **Vault Enumeration**: Enumerates all files in the vault (`vault.getF… | 1 | — | 无本地对应 | 0 |  |
| `info:7` | **Clipboard Access**: Reads or writes the system clipboard. May expos… | 1 | — | 无本地对应 | 0 |  |
| `info:8` | `timeoutMs` is deprecated. 保留字段以兼容调用方旧签名，但已不再消费。 无状态生成迁移到 pi complete… | 1 | — | 无本地对应 | 0 |  |
| `info:9` | '_providerId' is assigned a value but never used. | 1 | — | 无本地对应 | 0 |  |
| `info:10` | 'err' is defined but never used. | 1 | — | 无本地对应 | 0 |  |
| `info:11` | '_error' is defined but never used. | 1 | — | 无本地对应 | 0 |  |

### 4.2 头号类别 `@typescript-eslint/no-unsafe-member-access` 逐文件对比

这是扫描结果里最大的一类（1150 / 3002 ≈ 38%），也是判断「本地 harness 是否忠实复现扫描器」的关键证据。

| 指标 | 扫描页面 | 本地复现（干净检出） |
| --- | ---: | ---: |
| 报出的问题数 | **1150** | **1194** |
| 涉及文件数 | **61** | **61** |
| 页面列出的位置数 | 953（去重后） | 1194 |

**结论：文件集合完全相同（同为 61 个），逐文件排序高度吻合。** 数量差异来自扫描器与本地
ESLint / `typescript-eslint` 版本、规则选项、以及纳入文件集合的差异——扫描器的确切配置未公开，
无法逐项对齐。因此这个 harness 是一个可靠的**相对**度量（某文件/某规则变好还是变坏），
不是分值的精确预测器。

> ⚠️ **扫描的逐文件数量是下界。** 页面为这 1150 条问题只列出 **953 个去重后的位置**
> （同一位置可能对应多条问题，且部分链接是 `#L320-L322` 这样的区间锚点）。所以下表
> 「扫描」一列是**下界**，真实逐文件数量只会 ≥ 该值，不能据此断言某个文件「只有这么多」。

| 文件 | 扫描（下界） | 本地复现 |
| --- | ---: | ---: |
| `src/ui/chat-controller.ts` | 103 | 151 |
| `src/settings.ts` | 74 | 79 |
| `src/memory/hindsight-migration.ts` | 55 | 76 |
| `src/ui/renderers/message-renderer.ts` | 68 | 71 |
| `src/skills/builtin/vault-ops.ts` | 61 | 65 |
| `main.ts` | 50 | 47 |
| `src/memory/memory-manager.ts` | 23 | 37 |
| `src/knowledge/compiler.ts` | 26 | 35 |
| `src/skills/builtin/plugin-ctrl/executor.ts` | 21 | 33 |
| `src/ui/approval-card.ts` | 20 | 32 |
| `src/services/video-transcription.ts` | 20 | 30 |
| `src/skills/builtin/obsidian-bases/executor.ts` | 20 | 30 |
| `src/ui/shell-view.ts` | 21 | 27 |
| `src/runtime/pi/pi-event-adapter.ts` | 23 | 26 |
| `src/skills/builtin/json-canvas/executor.ts` | 19 | 25 |
| `src/services/model-catalog-service.ts` | 18 | 25 |
| `src/utils/video_utils.ts` | 20 | 24 |
| `src/services/model-service.ts` | 11 | 23 |
| `src/utils/request-url-fetch.ts` | 21 | 22 |
| `src/ui/components/knowledge-status-panel.ts` | 19 | 21 |
| 其余 41 个文件 | 260 | 315 |
| **合计（61 个文件）** | **953** | **1194** |

> 文件集合完全一致：扫描与本地都命中这 61 个文件，无单边文件。

### 4.3 本地复现的整体基线（干净检出，fix 之前）

| 指标 | 值 |
| --- | ---: |
| lint 的文件数 | 127 |
| 有问题的文件数 | 88 |
| errors | 90 |
| warnings | 2972 |
| **problems 合计** | **3062** |

本地 3062 与页面 3002 是**两次不同的测量**，不可互相替代，也不可相减当成「已修好 60 条」。

> ⚠️ **数值巧合，不是同一件事。** 本地 severity=`warn` 的条数恰好也是 2972，与页面
> `Warnings` 徽章相同。但两者的规则集合与文件集合都不同（本地含
> `@typescript-eslint/require-await` 等页面未列出的规则，页面含全部 `obsidianmd/*` 与 CSS 规则），
> 这个相等是巧合，**不要**据此声称本地跑分复现了页面的 2972。

本地规则分布：

| 数量 | 规则 |
| ---: | --- |
| 1194 | `@typescript-eslint/no-unsafe-member-access` |
| 564 | `@typescript-eslint/no-explicit-any` |
| 486 | `@typescript-eslint/no-unsafe-assignment` |
| 396 | `@typescript-eslint/no-unsafe-call` |
| 162 | `@typescript-eslint/no-unsafe-argument` |
| 75 | `@typescript-eslint/no-unsafe-return` |
| 63 | `@typescript-eslint/no-unnecessary-type-assertion` |
| 38 | `@typescript-eslint/require-await` |
| 18 | `@typescript-eslint/no-unused-vars` |
| 14 | `@typescript-eslint/no-misused-promises` |
| 11 | `@typescript-eslint/no-unused-expressions` |
| 10 | `@typescript-eslint/no-redundant-type-constituents` |
| 8 | `@typescript-eslint/no-floating-promises` |
| 7 | `no-useless-escape` |
| 4 | `@typescript-eslint/ban-ts-comment` |
| 4 | `prefer-const` |
| 3 | `@typescript-eslint/no-base-to-string` |
| 2 | `@typescript-eslint/unbound-method` |
| 2 | `no-case-declarations` |
| 1 | `no-irregular-whitespace` |

---

## 5. 查重与归属（不要重开已关闭的范围）

| 条目 | 状态 | 与本任务的关系 |
| --- | --- | --- |
| #67 | 已关闭（经 PR #78） | 已清理 **10 条具体的 `main.ts` warning** |
| #68 | — | **无关**的 CI 工作 |
| #69（本 issue） | 进行中 | 2972 条 warning 的分类治理；本文件是其分类台账 |

> 上表 #67 的「10 条 `main.ts` warning」来自 issue/PR 记录，**本任务未独立复核**该数字。
> 本 PR **不重开** #67、#68 的范围：`main.ts` 与 CI 配置都不在本次写入范围内。

**本 PR 的写入范围**：`tools/plugin-review-baseline/**`、`docs/plugin-review/**`、
`package.json`（仅新增一行 `lint:review` 脚本），以及 `src/ui/**` 的修复（由本 PR 的另外两个
并行任务承担）。**不修改** `main.ts`，**不修改** `eslint.config.mjs`（CI 的 `npx eslint .`
必须保持通过）。

---

## 6. 分批计划与状态

分批依据：本地干净检出上 `@typescript-eslint/no-unsafe-member-access` 的逐文件数量
（合计 1194 / 61 个文件）。每批都能追溯到「规则 + 文件 + 数量」。

### 6.1 批次 1 —— 本 PR 范围（`src/ui/**`）

范围：`chat-controller` / `shell-view` / `approval-card` / `history` / `guardian` /
`renderers` / `components` / `tabs` / `selection-ai` / `selection-menu`。

| 文件 | 本地复现 | 扫描（下界） |
| --- | ---: | ---: |
| `src/ui/chat-controller.ts` | 151 | 103 |
| `src/ui/renderers/message-renderer.ts` | 71 | 68 |
| `src/ui/approval-card.ts` | 32 | 20 |
| `src/ui/shell-view.ts` | 27 | 21 |
| `src/ui/components/knowledge-status-panel.ts` | 21 | 19 |
| `src/ui/renderers/tool-renderer.ts` | 18 | 17 |
| `src/ui/renderers/thinking-renderer.ts` | 16 | 16 |
| `src/ui/guardian-completion.ts` | 13 | 7 |
| `src/ui/components/change-preview-card.ts` | 10 | 10 |
| `src/ui/history/conversation-store.ts` | 10 | 10 |
| `src/ui/renderers/code-block-renderer.ts` | 7 | 7 |
| `src/ui/components/context-chips.ts` | 4 | 4 |
| `src/ui/tabs/tab-bar.ts` | 4 | 4 |
| `src/ui/selection-ai/floating-panel.ts` | 4 | 1 |
| `src/ui/selection-menu.ts` | 3 | 3 |
| `src/ui/components/command-dropdown.ts` | 2 | 2 |
| `src/ui/components/input-toolbar.ts` | 2 | 2 |
| **小计（17 个文件）** | **395** | **314** |

> **批次 1 修复后计数（经核验）**：使用同一份 `tools/plugin-review-baseline/eslint.review.config.mjs`、
> 同一组 targets（`main.ts src`），before 取自干净检出（HEAD `8bf2eda`，所有写入者开始前）的完整
> 跑分，after 取自全部写入者停止后的冻结工作树，两次测量均独立复核：
>
> | | before | after |
> | --- | ---: | ---: |
> | 全库总问题数 | 3062 | 2068 |
> | `@typescript-eslint/no-unsafe-member-access`（全库） | 1194 / 61 个文件 | 799 / 44 个文件 |
> | `@typescript-eslint/no-unsafe-member-access`（本批 17 个文件，`src/ui/**`） | 395 | **0** |
> | 其他规则 | — | **无一条计数上升**；连带清零 `ban-ts-comment`（4→0）、`no-unused-expressions`（11→0） |
>
> `npx tsc --noEmit` 全程保持 0 行；`npx eslint .`（CI 实际使用的命令）0 error（611→366 条
> warning，降幅主要来自 `no-explicit-any`）；`npm test` 全部通过（含本批新增的 7 组回归用例，
> 覆盖 `getErrorText`/`getErrorName`/`isApprovalRequiredResult` 的真实调用路径）。
> diff 中新增代码行（550 行插入里约 467 行非注释）不含任何新增 `any`；仅 2 处为保留「刻意复刻
> 模板插值对真值非字符串 message 的文本化」而加的窄范围 `eslint-disable-next-line`（均带中文
> 说明，且这两条规则本仓库 `eslint.config.mjs` 均未启用，不影响 CI）。
>
> 产物不是逐字节相同（新增的命名类型/守卫/辅助函数会改变打包后的 JS 文本），但已逐一核对全部
> 59 处产物差异块，未发现行为差异；详见 §7 的证据与局限说明。

### 6.2 批次 2 及以后 —— 其余文件

以下文件不在批次 1 范围内，按数量从大到小排列，可整批或再拆分。

| 文件 | 本地复现 | 扫描（下界） |
| --- | ---: | ---: |
| `src/settings.ts` | 79 | 74 |
| `src/memory/hindsight-migration.ts` | 76 | 55 |
| `src/skills/builtin/vault-ops.ts` | 65 | 61 |
| `main.ts` | 47 | 50 |
| `src/memory/memory-manager.ts` | 37 | 23 |
| `src/knowledge/compiler.ts` | 35 | 26 |
| `src/skills/builtin/plugin-ctrl/executor.ts` | 33 | 21 |
| `src/services/video-transcription.ts` | 30 | 20 |
| `src/skills/builtin/obsidian-bases/executor.ts` | 30 | 20 |
| `src/runtime/pi/pi-event-adapter.ts` | 26 | 23 |
| `src/skills/builtin/json-canvas/executor.ts` | 25 | 19 |
| `src/services/model-catalog-service.ts` | 25 | 18 |
| `src/utils/video_utils.ts` | 24 | 20 |
| `src/services/model-service.ts` | 23 | 11 |
| `src/utils/request-url-fetch.ts` | 22 | 21 |
| `src/skills/builtin/plugin-ctrl/skill-generator.ts` | 18 | 14 |
| `src/knowledge/ontology.ts` | 17 | 12 |
| `src/knowledge/metadata-index.ts` | 16 | 13 |
| `src/services/operation-audit-log.ts` | 16 | 12 |
| `src/runtime/pi/harness-chat-runtime.ts` | 15 | 13 |
| `src/knowledge/runtime.ts` | 14 | 14 |
| `src/services/obsidian-context-service.ts` | 14 | 11 |
| `src/utils/file-operation-contract.ts` | 14 | 7 |
| `src/knowledge/frontmatter.ts` | 12 | 11 |
| `src/skills/skill-files.ts` | 11 | 7 |
| `src/skills/builtin/plugin-ctrl/plugin-watcher.ts` | 10 | 10 |
| `src/skills/builtin/web-clipper/executor.ts` | 10 | 10 |
| `src/runtime/base-chat-runtime.ts` | 10 | 7 |
| `src/runtime/pi/anthropic-sdk-shim.ts` | 8 | 8 |
| `src/services/workspace-edit-service.ts` | 6 | 5 |
| `src/skills/pi-skill-source.ts` | 6 | 3 |
| `src/knowledge/indexer.ts` | 4 | 4 |
| `src/skills/builtin/web-search/executor.ts` | 4 | 3 |
| `src/runtime/pi/session-store/compaction.ts` | 3 | 2 |
| `src/skills/builtin/knowledge/executor.ts` | 3 | 2 |
| `src/knowledge/ontology-service.ts` | 2 | 1 |
| `src/skills/builtin/read-skill.ts` | 2 | 1 |
| `src/knowledge/file-back.ts` | 1 | 1 |
| `src/runtime/pi/pi-approval-policy.ts` | 1 | 1 |
| `src/runtime/pi/pi-native-model.ts` | 1 | 1 |
| `src/runtime/pi/pi-tool-adapter.ts` | 1 | 1 |
| `src/services/clip-protocol.ts` | 1 | 1 |
| `src/skills/tool-registry.ts` | 1 | 1 |
| `src/utils/logger.ts` | 1 | 1 |
| **小计（44 个文件）** | **799** | **639** |

### 6.3 其他规则的后续批次

`@typescript-eslint/no-unsafe-member-access` 之外，本地复现数量较大的规则还有
`@typescript-eslint/no-explicit-any`（564）、`no-unsafe-assignment`（486）、
`no-unsafe-call`（396）等，见 §4.3。这些与 `no-unsafe-member-access` 高度同源
（`any` 是它们的共同根因），建议在批次 1 验证完收敛手法后再单独立批，不要与批次 1 混在一个 PR 里。

---

## 7. 限制与未验证项

1. **扫描器未开源。** Obsidian 审核扫描的规则集无法获取。本 harness 的规则集是从页面自己的
   类别列表反推的，**不可能**逐条等价。
2. **扫描的逐文件数量是下界。** 页面为 1150 条 `no-unsafe-member-access` 问题只列出
   953 个去重位置。§4.2 表中「扫描」一列只能当 ≥ 值使用。
3. **本地无对应项的类别。** 以下页面类别在当前 harness 中**完全覆盖不到**，因此它们的
   「修好了没有」在本地无法度量：全部 `obsidianmd/*` 规则（`window.setTimeout` /
   `clearTimeout` / `clearInterval` / `requestAnimationFrame` / `globalThis` / `localStorage` /
   `Vault#configDir` / `FileManager.trashFile` / `requestUrl` / `createEl` /
   `getSettingDefinitions`）、全部 CSS 检查（`!important` 24 条、`:has` 4 条、
   `"background"` 重复 1 条、浏览器特性支持 2+2 条）、`no-console`、弃用 API
   （`sessionRef` / `substr` / `timeoutMs`）、artifact attestations 缺失、
   以及 `Direct Filesystem Access` / `Vault Enumeration` / `Clipboard Access` 这类静态能力描述。
   合计约 **100 条**页面条目在本地没有对应规则。
4. **本地多出的规则。** 反过来，本地配置会报出页面未列出的规则：
   `@typescript-eslint/require-await`（38）、`no-unused-expressions`（11）、
   `ban-ts-comment`（4）、`no-base-to-string`（3）、`prefer-const`（4）。比对时不能只对总数。
5. **2972 vs 2972 是巧合**，见 §4.3 的说明。
6. **不声称分值下降。** 页面的重新扫描发生在**下一次 release 之后**。本 PR 合并时，
   scorecard 上的 3002 / 2972 / 1150 不会立即变化。本文档**不做任何「数字已下降」的声明**。
7. **`styles.css` 不在本地 lint 范围内**，页面上的 CSS 类别（约 31 条）没有本地对照。
8. **#67 的「10 条」未复核**，见 §5。
9. **`Passed` / `Disclosures` 未独立验证**，见 §3.3。
10. **行号会漂移。** §2 与 §4 里的位置都基于 release commit
    `65020a8862aeaf88d41a2e164a7f779c3281ddd0`（页面）或干净检出（本地）。当前 `main` 上的行号
    可能已经不同，定位时请以文件 + 规则为准。
11. **本次会话中的 `src/**` 是并发修改的。** 任何在本文件写作时点跑出的实时数字都包含在途改动，
    不能作为 before/after 证据；before 数字一律以
    [`baseline-pristine.json`](../../tools/plugin-review-baseline/metrics/baseline-pristine.json) 为准。
12. **批次 1 不提供运行时「无差异」的字节级证明，只有逐块人工核对。** 本批是类型层改动（删除
    不必要的 `as any`、补具名契约类型、`catch` 窄化为 `unknown`），理论上不应改变任何渲染结果或
    运行时行为；但 esbuild 产物不是逐字节相同（新增的命名类型/守卫/辅助函数必然改变打包后的 JS
    文本），所以不能像预期那样用「两份产物哈希一致」直接证明无差异。实际做法是：对比干净检出
    与改动后在同一相对路径深度构建的产物，归一化后得到 59 处差异块，逐块人工核对，均确认是
    等价重写（例如 `x.call(this.api, …)` ⇄ `this.api.x(…)`、`A?.() ?? B()` 拆成两条语句、
    `||` 与 `??` 在当前语境下等价）。**未在真实 Obsidian 宿主里加载插件做手动验证**，这一步
    仍待人工验证；DOM 结构相关的行为由现有渐染器测试（`message-renderer` / `thinking-renderer` /
    `tool-renderer` 等）在 Node mock 环境下覆盖，不是真实渲染截图。
