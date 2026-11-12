# Review 自动化扫描分类治理（issue #69）

本目录保存 Obsidian 社区插件展页 [Scorecard → Review: Risks](https://community.obsidian.md/plugins/baizer#scorecard)
的扫描分类清单、统计口径和治理进度。它服务于
[issue #69](https://github.com/yinfi/baizer/issues/69)：把展页报告的 2972 条 warning
按类别、规则、代码位置拆开，逐批修复并保持可追溯。

> 展页计数是**自动化扫描计数**，不等于 2972 个可利用漏洞，也不等于已逐一复现的问题数。
> 本目录不做安全定性，只做分类、定位和修复进度记录。

## 1. 来源与扫描版本

| 项 | 值 |
|---|---|
| 展页 | https://community.obsidian.md/plugins/baizer （Review: Risks） |
| 页面报告 | `3002 issues found by automated scans of the latest release.` |
| 分类计数 | Warnings **2972**（38 类）、Other **30**（12 项）、Passed **5**、Disclosures **4** |
| 插件版本 | 1.5.0（页面 Last updated：Nov 3, 2026） |
| 扫描代码版本 | `65020a8862aeaf88d41a2e164a7f779c3281ddd0`（标签 1.5.0 / PR #62 合入版本） |
| 快照拉取时间 | 2026-11-05（见 `review-scan-1.5.0.json` 的 `source.fetchedAt`） |
| 审核器口径 | `eslint 9.37.0` + `eslint-plugin-obsidianmd 0.4.1` + `typescript-eslint 8.61.1`（TypeScript 规则）及 stylelint 扫描器（CSS 规则） |

## 2. 快照与工具

### 快照文件

- `review-scan-1.5.0.json`：机器可读分类清单。每个类别包含 `severity`、页面计数、规则、位置条目；
  位置按 `file + lines` 折叠，可按
  `https://github.com/yinfi/baizer/blob/<scanCommit>/<file>#L<line>` 还原每一条。
- `review-scan-1.5.0.md`：同一份数据的表格视图（便于人工核对）。

分类计数与展页徽标严格对账：38 类 warning 计数合计 2972，12 项 Other 合计 30，
Passed 5、Disclosures 4；页面未显示计数徽标的单条项目按 1 条记，并在 JSON 里标 `countInferred: true`。

### 重抓/重解析展页

```bash
node scripts/review-scan/scorecard-inventory.mjs \
  --out docs/review/review-scan-<version>.json \
  --markdown docs/review/review-scan-<version>.md \
  --compact
# 离线：先用浏览器保存页面，再 --html saved-page.html
```

脚本直接解析展页内嵌的 Next.js flight 数据（分类、徽标计数、规则、代码位置都在其中），
不依赖第三方包。展页改版时会报错退出，而不是静默输出空清单。

### 本地复现 ESLint 扫描（与审核器同口径）

```bash
node scripts/review-scan/reproduce-eslint.mjs --out review-eslint-report.json
```

- 首次运行会往系统临时目录安装**固定版本**的扫描依赖（不写入本仓库 `package.json`）；
- 使用审核器同款 eslint 配置生成逻辑（`obsidianmd.configs.recommended` + 把 error 降为 warn +
  显式打开 `no-unsafe-*` 五条规则）和同款忽略清单（测试、构建脚本、docs、i18n 等）；
- 输出按规则聚合的计数与按文件的规则计数，用于「修复前 / 修复后」同口径对比。

在扫描版本 `65020a8` 的源码上复现，`@typescript-eslint/no-unsafe-member-access` 为 **1150**，
与展页完全一致；`@typescript-eslint/no-explicit-any` 为 553，也与展页一致。
个别规则与展页有 ±1~3 的差异（审核器运行环境与本地依赖补丁版本差异），因此**最终计数仍以重新提交审核后的展页为准**。

## 3. 分类 → 规则映射

展页只在部分类别下明示规则名（5 条 `no-unsafe-*` 与 `obsidianmd/prefer-create-el`）。其余类别由
「标题语义 + 本地复现的规则计数」推定，已在表中标注来源；推定项不改变展页计数本身。

### 3.1 Warnings（38 类，页面合计 2972）

| # | 分类标题 | 规则 | 页面计数 | 规则来源 |
|---|---|---|---|---|
| 0 | Unsafe member access on an error or any typed value | @typescript-eslint/no-unsafe-member-access | 1150 | 页面明示 |
| 1 | Unexpected any. Specify a different type. | @typescript-eslint/no-explicit-any | 553 | 本地复现推断 |
| 2 | Unsafe assignment of an error or any typed value | @typescript-eslint/no-unsafe-assignment | 458 | 页面明示 |
| 3 | Unsafe call of an error or any typed value | @typescript-eslint/no-unsafe-call | 370 | 页面明示 |
| 4 | Passes unsafe values into typed parameters | @typescript-eslint/no-unsafe-argument | 157 | 页面明示 |
| 5 | Returns unsafe values from typed code | @typescript-eslint/no-unsafe-return | 71 | 页面明示 |
| 6 | This assertion is unnecessary since it does not change the type of the expression. | @typescript-eslint/no-unnecessary-type-assertion | 46 | 本地复现推断 |
| 7 | Avoid !important | stylelint: declaration-no-important | 24 | 本地复现推断（stylelint） |
| 8 | Use 'window.setTimeout()' instead of 'setTimeout()' | obsidianmd/prefer-window-timers | 19 | 本地复现推断 |
| 9 | Use 'window.clearTimeout()' instead of 'clearTimeout()' | obsidianmd/prefer-window-timers | 15 | 本地复现推断 |
| 10 | This assertion is unnecessary since the receiver accepts the original type of the expression. | @typescript-eslint/no-unnecessary-type-assertion | 13 | 本地复现推断 |
| 11 | Promise returned in function argument where a void return was expected. | @typescript-eslint/no-misused-promises | 13 | 本地复现推断 |
| 12 | Uses `document.createElement` instead of Obsidian's `createEl` helpers | obsidianmd/prefer-create-el | 10 | 页面明示 |
| 13 | Avoid using 'globalThis' | obsidianmd/no-global-this | 9 | 本地复现推断 |
| 14 | Promises must be awaited / returned / marked with `void` | @typescript-eslint/no-floating-promises | 8 | 本地复现推断 |
| 15 | Obsidian's configuration folder is not necessarily `.obsidian` | obsidianmd/hardcoded-config-path | 8 | 本地复现推断 |
| 16 | 'any' overrides all other types in this union type. | @typescript-eslint/no-redundant-type-constituents | 8 | 本地复现推断 |
| 17 | Empty block statement. | no-empty | 4 | 本地复现推断 |
| 18 | Use 'FileManager.trashFile()' instead of 'Vault.trash()' | obsidianmd/prefer-file-manager-trash-file | 4 | 本地复现推断 |
| 19 | Avoid `:has` | stylelint: selector-pseudo-class-disallowed-list | 4 | 本地复现推断（stylelint） |
| 20 | Unnecessary escape character: `\)` | no-useless-escape | 3 | 本地复现推断 |
| 21 | Unnecessary escape character: `\[` | no-useless-escape | 3 | 本地复现推断 |
| 22 | Avoid unnecessary logging to console | no-console（审核器以 obsidianmd/rule-custom-message 包装输出） | 2 | 本地复现推断 |
| 23 | Unexpected lexical declaration in case block. | no-case-declarations | 2 | 本地复现推断 |
| 24 | Method not declared with `this: void`（unbound method） | @typescript-eslint/unbound-method | 2 | 本地复现推断 |
| 25 | Unexpected use of 'localStorage' | no-restricted-globals | 2 | 本地复现推断 |
| 26 | Browser feature `css-display-contents` 仅部分支持 | stylelint: plugin/no-unsupported-browser-features | 2 | 本地复现推断（stylelint） |
| 27 | Browser feature `multicolumn` 仅部分支持 | stylelint: plugin/no-unsupported-browser-features | 2 | 本地复现推断（stylelint） |
| 28 | Direct Filesystem Access（`fs` 模块访问 vault 外文件系统） | 非 lint：风险披露项 | 1 | 非 ESLint 项 |
| 29 | Irregular whitespace not allowed. | no-irregular-whitespace | 1 | 本地复现推断 |
| 30 | Unnecessary escape character: `\.` | no-useless-escape | 1 | 本地复现推断 |
| 31 | Unnecessary escape character: `\?` | no-useless-escape | 1 | 本地复现推断 |
| 32 | Unexpected use of 'fetch' | no-restricted-globals | 1 | 本地复现推断 |
| 33 | PluginSettingTab 未实现 `getSettingDefinitions()` | obsidianmd/settings-tab/prefer-setting-definitions | 1 | 本地复现推断 |
| 34 | Promise-returning function provided to property where a void return was expected. | @typescript-eslint/no-misused-promises | 1 | 本地复现推断 |
| 35 | Use 'window.requestAnimationFrame()' | obsidianmd/prefer-window-timers | 1 | 本地复现推断 |
| 36 | Use 'window.clearInterval()' | obsidianmd/prefer-window-timers | 1 | 本地复现推断 |
| 37 | Unexpected duplicate "background" | stylelint: declaration-block-no-duplicate-properties | 1 | 本地复现推断（stylelint） |

### 3.2 Other（12 项，页面合计 30）

| # | 项目 | 规则 | 页面计数 |
|---|---|---|---|
| 0 | '_' is defined but never used. | no-unused-vars | 8 |
| 1 | 'e' is defined but never used. | no-unused-vars | 7 |
| 2 | `sessionRef` is deprecated（旧数据迁移保留字段） | @typescript-eslint/no-deprecated | 3 |
| 3 | Missing GitHub artifact attestations for release assets | 非 lint：发布资产 provenance | 2 |
| 4 | 'error' is defined but never used. | no-unused-vars | 2 |
| 5 | `substr` is deprecated | @typescript-eslint/no-deprecated | 2 |
| 6 | Vault Enumeration（`vault.getFiles` 等） | 非 lint：风险披露项 | 1 |
| 7 | Clipboard Access（读写系统剪贴板） | 非 lint：风险披露项 | 1 |
| 8 | `timeoutMs` is deprecated（兼容旧调用方保留字段） | @typescript-eslint/no-deprecated | 1 |
| 9 | '_providerId' is assigned a value but never used. | no-unused-vars | 1 |
| 10 | 'err' is defined but never used. | no-unused-vars | 1 |
| 11 | '_error' is defined but never used. | no-unused-vars | 1 |

### 3.3 Passed 与 Disclosures

- **Passed（5）**：Vault Read、Vault Write、No vulnerable dependencies、No obfuscation、
  Build reproduced the release `main.js` byte-for-byte。
- **Disclosures（4）**：Plugin might make requests to external domains（`api.bilibili.com`，
  合计 21 network calls）、Number of network request calls、Malware scan not available、
  Network requests scan not available。

Passed 只是页面报告，不是本次独立安全审计结论；Disclosures 是网络域名/请求次数与
「扫描不可用」的覆盖说明，不推定为漏洞。

## 4. 治理批次

每批都要求：先按分类清单定位 → 对照当前 main 的现状 → 只做与类别匹配的修复 →
用 `npm run build`、独立 `npx eslint .`、`npm test` 和本地复现扫描验证 → 发布并重新提交审核后，
以展页同口径计数下降为准。

| 批次 | 范围 | 状态 |
|---|---|---|
| B0 证据基线 | 完整分类清单、扫描版本、规则映射、本地复现器、进度跟踪 | ✅ 本 PR |
| B1 内部契约（`no-unsafe-member-access` 的「内部契约」根因） | 冗余 `as any`/`any` 标注 → 具名类型（UI 元素 helper、已声明的服务方法、插件公开字段、Obsidian 公开 API 类型） | ✅ 本 PR（全仓 1188 → 543；`main.ts` + `src/ui/**` 436 → 0；剩 543 属 B2 外部输入） |
| B2 外部输入（`no-unsafe-member-access` 与五条 type-aware 规则） | `JSON.parse`、磁盘设置/记忆记录、vault adapter、旧数据迁移、工具参数/返回、任意事件 payload：`unknown` + 明确窄化（`src/utils/narrow.ts`）。涉及 `src/settings.ts`、`src/memory/*`、`src/knowledge/*`、`src/services/*`、`src/runtime/pi/*`、`src/skills/**`、`src/utils/*`、`src/ui/*` 等 | ✅ 已拆三批完成：**#97** 清零 `no-unsafe-member-access`（560 → 0）；**#101** 清零 `no-explicit-any` + 四条 `no-unsafe-*`（issue 基线累计 726 → 0），本 PR 补齐收口与回归测试，见 §6.5 |
| B3 Obsidian API 偏好规则 | `prefer-window-timers` 36、`prefer-create-el` 10、`no-global-this` 9、`hardcoded-config-path` 8、`prefer-file-manager-trash-file` 4、`no-console` 2、`fetch` 1、`prefer-setting-definitions` 1 | ⏳ 待排期（部分会改变行为语义，需单独说明与回归） |
| B4 CSS（stylelint 类别） | `!important` 24、`:has` 4、浏览器特性 4、重复属性 1 | ⏳ 待排期（视觉变更，需 Before/After 截图） |
| B5 Info / 杂项类别 | unused vars 20、deprecated 字段 6（其中 `sessionRef`/`timeoutMs` 是有意保留的兼容字段，修前需确认策略）、empty block 4、case declarations 2、unbound-method 2、无必要转义 8、irregular whitespace 1 | ⏳ 待排期 |
| B6 Promise 规则（issue #92） | `no-misused-promises` 14、`no-floating-promises` 10、`prefer-promise-reject-errors` 2（展页同类合计 ≈26；含展页单列的「Promise-returning function 赋给期望 void 的属性」）。修的是「错误处理路径可能真的缺失」，不是纯风格 | ✅ 已由 PR #104 合入 main（`e7b81a0`）：三规则同口径复现归零；逐处失败落点见 §6.6 |

B2 的判定标准：新增 `unknown` 窄化时，对旧数据的行为（保留字段、默认值、回退文案）必须与现在一致，
并为迁移/回退路径补回归测试；不能把 `any` 换成另一个宽泛断言。

### B1 的实现边界

- 只做**类型层**改动：删除接收者本来就有类型的 `as any`、把 `any` 参数/字段换成真实类型
  （`HTMLElement`、`Editor`、`EditorView`、`ModelService`/`BaizerPlugin` 已声明成员、最小本地接口）。
- 不做外部输入窄化（那会引入新的运行时判断，归 B2）。
- 不改变防御性 `typeof` 检查、可选链兜底、异常文案、设置迁移时机等运行时行为。

## 5. 与 issue #69 验收的对应

| issue 验收项 | 本 PR 状态 |
|---|---|
| 完整分类清单补齐并可追溯至扫描版本与源代码；未验证部分明确标记 | ✅ 38+12+5+4 项全量，含扫描提交、逐位置 file/line、规则来源标注、证据限制见第 2 节 |
| 首批已覆盖位置不再触发 `no-unsafe-member-access` | ✅ 本地复现同口径验证（见 §6）；#67 已覆盖的 `main.ts` 位置在复现结果中已不再出现 |
| 展开页对应分类计数下降 | ⏳ 需要人工发布新版本并重新提交审核；本 PR 无法触发复扫。本地复现给出可信同口径计数，最终以展页复扫为准 |
| 全部治理完成后该 warning 类别消失 | ⏳ B2 之后；本 PR 记录剩余批次与清单 |
| 不能通过关闭扫描 / 禁用规则 / 扩大 ignore 伪造下降 | ✅ 复现器使用审核器同款规则与忽略清单；本 PR 未修改仓库 eslint 配置、未加 ignore、未加 `eslint-disable` |
| `npm run build`、`npx eslint .`、`npm test` 通过 | ✅（记录见 §6） |

## 6. B1 验证记录

### 6.1 扫描口径（与审核器同规则同忽略项，本地复现）

基线：`8bf2edaf5437b0c62537c465102bd7cabb4379f6`（本分支起点，即 #67 合入后的 main）；
修复后：本 PR 分支。命令：`node scripts/review-scan/reproduce-eslint.mjs`。

| 规则 | 修复前 | 修复后 | 变化 |
|---|---|---|---|
| `@typescript-eslint/no-unsafe-member-access` | 1188 | **543** | −645（−54.3%） |
| `@typescript-eslint/no-explicit-any` | 564 | 220 | −344 |
| `@typescript-eslint/no-unsafe-assignment` | 476 | 261 | −215 |
| `@typescript-eslint/no-unsafe-call` | 393 | 96 | −297 |
| `@typescript-eslint/no-unsafe-argument` | 159 | 90 | −69 |
| `@typescript-eslint/no-unsafe-return` | 74 | 44 | −30 |
| `@typescript-eslint/no-unnecessary-type-assertion` | 61 | 51 | −10 |
| `@typescript-eslint/no-redundant-type-constituents` | 10 | 7 | −3 |
| 其余类别（窗口计时器、`:has`、`!important`、info 类等） | — | — | 0（未新增，留待后续批次） |
| 全部规则消息合计 | 3063 | 1450 | −1613 |

按范围拆：`main.ts` + `src/ui/**` 的 `no-unsafe-member-access` **436 → 0**；
`src/` 其余内部契约（服务/运行时/技能/知识/记忆/工具）**752 → 543**，
剩余 543 条全部是外部输入/外部契约（见 §4 B2），不是本批目标。

**#67 已覆盖的位置**（clipboard `catch (e: any)`、旧设置 `raw as any`）在本次复现结果中不再出现，
`main.ts` 的 `no-unsafe-member-access` 47 → 0、`no-explicit-any` 13 → 0，满足 issue #69 的
「首批已覆盖位置不再触发」；展页计数下降仍需发布新版本后重新提交审核确认。

### 6.2 项目要求检查

| 检查 | 结果 |
|---|---|
| `npm run build` | ✅ 成功（`dist/main.js` 产出正常） |
| `npx eslint .`（仓库自带 lint，独立于 build） | ✅ **0 error**；warning **611 → 263**，逐规则无增加 |
| `npx tsc --noEmit` | ✅ 0 error |
| `npm test` | ✅ 109 个测试文件全部 PASS |
| 复现扫描 | ✅ 见 §6.1；逐规则核对：**没有任何规则计数增加** |

### 6.3 行为保持与例外（reviewer 请重点看）

本批只做类型层改动（删除接收者本有类型的冗余 `as any`、把 `any` 参数/字段换成具名类型、
在 Obsidian / Electron 未公开边界定义最小本地接口），运行时表达式与分支保持不变。已知三处需说明：

1. **`shell-view.openApprovalTarget`**：为满足审核器 `obsidianmd/no-tfile-tfolder-cast`，
   把 `file as any` 改为 `file instanceof TFile` 守卫。对非 `TFile` 目标（如文件夹）
   从「把文件夹传给 `leaf.openFile`」变为静默 no-op；正常笔记路径行为不变。
2. **`ChatController` 三个 public setter**（`setStreamEventHook` / `setMessageAddedHook` /
   `setStatusChangedHook`）：替代 `selection-menu.ts` 里 `(controller as any).onX = ...` 的直接赋值，
   行为等价，未新增其他 API。
3. **`harness-chat-runtime.resolveModelHandle`**：把方法取出后调用改为 `getter.call(handle)`，
   `this` 绑定与调用结果不变（此前用 `as any` 屏蔽了 unbound-method）。
4. **异常值窄化**：`catch (e: any)` 改为 `unknown` 后，异常文案沿用 HEAD 已有的 `thrownMessage()`。
   对 `Error` 与「带 message 的对象」与原来完全一致；对**非对象抛出值**（如直接 `throw 'x'`），
   原来 `${e.message}` 会显示 `undefined`，现在显示空文本 —— 即 issue #69 要求的异常值窄化，
   属于有意的小变化（`thrownMessage(e) || String(e)` 之类仍保留原有 `String(e)` 回退）。

其余如异常分支、`?.` 兜底、设置迁移时机、日志文案均未改。
本 PR 没有用户可见的 UI/视觉变化，因此不附 Before/After 截图；UI 相关改动只有上述类型收口。

### 6.4 复跑方式

```bash
node scripts/review-scan/reproduce-eslint.mjs --out review-eslint-report.json   # ESLint 分类
node scripts/review-scan/scorecard-inventory.mjs --out /tmp/new-snapshot.json    # 展页分类快照
npm run build && npx eslint . && npx tsc --noEmit && npm test
```

### 6.5 B2 收尾（issue #90）验证记录：五条 type-aware 规则清零

本次清理分三批合入：**#97** 先清零 `no-unsafe-member-access`（560 → 0），**#101** 清零 `no-explicit-any`
与四条 `no-unsafe-*` 的主体，本 PR（issue #90）补齐剩余的少量收口与窄化回归测试。下表「本 PR 分支」
为合入 #101 后的同口径复现结果。命令：`node scripts/review-scan/reproduce-eslint.mjs`（同 §6.1 口径）。

| 规则 | 941b1a2（issue 基线） | 当前 main（#97/#98 后） | 合入 #101 及本 PR 后 |
|---|---|---|---|
| `@typescript-eslint/no-explicit-any` | 224 | 64 | **0** |
| `@typescript-eslint/no-unsafe-assignment` | 266 | 55 | **0** |
| `@typescript-eslint/no-unsafe-call` | 99 | 0 | **0** |
| `@typescript-eslint/no-unsafe-argument` | 91 | 20 | **0** |
| `@typescript-eslint/no-unsafe-return` | 46 | 12 | **0** |
| `@typescript-eslint/no-unsafe-member-access`（#97 已完成） | 560 | 0 | 0 |
| 全部规则消息合计 | 1489 | 347 | 194 |

逐规则核对：**没有任何规则计数上升**（`no-empty` 4 → 2，其余持平或下降）。剩余 194 条属 B3/B4/B5 批次
（窗口计时器 41、unused vars 19 等）。

范围：issue #90 的 5 条规则在合入 #101 后的 main 上全部为 0；本 PR 在此基础上补充：pi 工具边界对
数组参数按「无参数」处理、反链键仅接受字符串、`getDerivedSkillStatuses()` 在设置页按窄契约收口，
以及 `stream-controller` 去掉冗余断言，并为这些分支补齐回归测试。

实现边界：外部弱类型输入（frontmatter/YAML/JSON、旧记忆数据、工具参数与返回、pi/ASR/HTTP/插件实例）
一律 `unknown` + 类型谓词/字段守卫；异常值沿用 `thrownMessage()` 口径；解析抛错语义保持不变。
未新增 `any`/`as any`/`eslint-disable`/`@ts-ignore`，未改动扫描器配置、忽略清单或规则开关。

行为保持与例外（均为畸形输入分支；合法数据行为不变）：

1. vault 工具缺参/错类型此前会在下游抛 `TypeError`，现在返回结构化错误（`Missing path parameter` 等）；
   审批预览的生成时机、文案与 permission 判定不变。
2. 旧记忆迁移/存储文件根节点类型错误（`{}`/`null`/非数组）此前抛 `TypeError`，现在按「无数据/只读」处理；
   旧字段缺失/类型不符回退原默认值，去重、排序、脱敏与迁移 state 时机不变。
3. 插件控制 / 网页剪藏 / 知识回填等工具对缺失或错类型参数返回明确错误，不再写半成品文件。
4. 非 `Error` 抛出值的错误文案从 `undefined` 变为空串或调用方回退文案（与 B1 的异常窄化口径一致）。

验证记录：

| 检查 | 结果 |
|---|---|
| `npm run build` | ✅ |
| `npx eslint .`（仓库自带 lint） | ✅ 0 error；warning 39 |
| `npx tsc --noEmit` | ✅ 0 error |
| `npm test` | ✅ 全部 PASS（含新增） |
| 同口径复现扫描 | ✅ 见上表；5 条规则归零，逐规则无上升 |

展页计数仍以发布后重新提交审核复扫为准；本 PR 不含 UI/视觉变化，故不附 Before/After 截图。

### 6.6 B6 验证记录（issue #92）：Promise 三条规则清零

代码修复已由 **PR #104** 合入 main（`e7b81a0`，2026-11-06）：新增 `src/utils/promise-guard.ts`
（`detach` / `voidHandler` / `toError`），把事件监听、定时器、Modal 回调、`Debouncer.run()`
等同步 void 契约里的异步失败统一交给日志与可选 Notice，并把 `Promise.reject()` 的原因收口成
`Error`。本 PR（#105）在 `#104` 之上补齐本目录的验证记录，并为「定型渲染失败」补一个纯文本兜底。

基线 `45bf8c7`（`#104` 合入前的 main）与本 PR 分支的同口径复现（`node scripts/review-scan/reproduce-eslint.mjs`，
同 §6.1 口径）：

| 规则 | 修复前 | 修复后 | 变化 |
|---|---|---|---|
| `@typescript-eslint/no-misused-promises` | 14 | **0** | −14 |
| `@typescript-eslint/no-floating-promises` | 10 | **0** | −10 |
| `@typescript-eslint/prefer-promise-reject-errors` | 2 | **0** | −2 |
| 全部规则消息合计 | 35 | 9 | −26 |

逐规则核对：**没有任何规则计数上升**；被改文件在复现结果的这三条规则下已不再出现。剩余 9 条属 B3/B5
批次（deprecated 3、无必要断言 2、`no-unsupported-api` 2、`no-unsafe-return` 1、settings 声明式 1）。

实现边界：不改规则开关、不扩 `ignores`、不加 `eslint-disable`；失败路径一律记日志（`logger.error`，
进开发者控制台与日志导出），需要用户可见的再叠加 `Notice`，没有空 `.catch(() => {})`。

#### 每处修复：失败路径现在去哪了

| 文件:行（基线） | 规则 | 修复 | 失败落点 |
|---|---|---|---|
| `main.ts:313` `pluginWatcher.start()` | floating | 不 await（分钟级扫描不能卡 onload），`detach` | `logger.error`；watcher 自身的 `notify` 仍提示扫描失败 |
| `main.ts:369` `runGuardianCheck()`（GuardianModal 提交回调） | floating | 同步回调内 `detach` | `logger.error`；常规失败本来就由 `runGuardianCheck` 把 guardian 状态置为 Error |
| `src/knowledge/runtime.ts:383` `watcher.onFileCreate()`（vault create 事件） | floating | 事件回调内 `detach` | `logger.error`；新笔记没登记 pending 不再无声 |
| `src/services/model-catalog-service.ts:143/148` `reject(error)` | prefer-promise-reject-errors | 非 Error 抛出值经 `toError()` 包成 Error（真 Error 原样透传，name/status 不丢） | 拒绝原因始终是 Error：`ModelService.getAvailableModels` 记 `logger.warn`，设置页模型行显示该错误文案 |
| `src/settings.ts:1824/1825/1857/1858/2893` `debouncedPersist(.Light).run()` | floating | debounce 回调自带 `catch`（日志 + Notice），`run()` 结果再经 `detach` | `logger.error` + `Notice`「Settings action failed: 原因」 |
| `src/settings.ts:2368` AddProviderModal 的 `async (draft)` 提交 | misused | `voidHandler` | `logger.error` + `Notice` |
| `src/settings.ts:2414` provider 卡片 click | misused | `voidHandler` | 同上（切换 provider / 保存失败） |
| `src/settings.ts:2566` provider 名称 change | misused | `voidHandler` | 同上 |
| `src/settings.ts:2591` 协议 change | misused | `voidHandler` | 同上 |
| `src/settings.ts:2621` API type change | misused | `voidHandler` | 同上 |
| `src/settings.ts:3284` 权限预设 click | misused | `voidHandler` | 同上 |
| `src/settings.ts:4001` `getProtocolOptions().forEach(option => dropdown.addOption(...))` | misused | 回调改块体：`DropdownComponent` 带 `then()` 会被规则当成 thenable，隐式返回触发误判 | 无异步工作，无需落点 |
| `src/skills/builtin/plugin-ctrl/plugin-watcher.ts:566` `setInterval(() => checkChanges())` | misused | `voidHandler` | `logger.error`；轮询异常不再静默中断自动生成/撤下 |
| `src/ui/chat-controller.ts:601` `/file-back` 后台归档 | floating | `detach` | `logger.error`；工具失败本来就转成会话内系统消息 |
| `src/ui/controllers/context-controller.ts:48` `onOpenFile` 回调 | misused | `voidHandler` | `logger.error`（从 context chip 打开链接失败不再无声） |
| `src/ui/shell-view.ts:446/1402` keydown 监听器返回 Promise | misused | `voidHandler`（同步部分先执行，`preventDefault` 语义不变） | `logger.error`；提交失败仍由 `processCommand` 在会话里显示错误消息 |
| `src/ui/shell-view.ts:452/1403` paste 监听器 `async` 但无 await | misused | `voidHandler` 适配为同步 void | `logger.error` |
| `src/ui/shell-view.ts:1143` 定型渲染 `.then()` 无 rejection 分支 | floating | `detach` + 本 PR 追加 `.catch` | `logger.error`；本 PR 进一步用纯文本兜底，终态区不会白屏 |
| `src/ui/shell-view.ts:1293` DiffModal 的 `async` 应用回调 | misused | `voidHandler` + 用户提示 | `logger.error` + `Notice`「Failed to apply changes: 原因」 |

#### 回归测试

- `test/promise-guard.test.ts`（#104）：用 `process.on('unhandledRejection')` 断言 rejected
  fire-and-forget Promise、任务内同步抛错、失败回调自身抛错都不会产生未处理 rejection；
  `voidHandler` 的同步部分在返回前执行；`listModels` 对字符串 rejection 返回 Error。
  对应 issue #92 要求的「至少覆盖一次 promise reject 不再是 unhandled」。

#### 项目要求检查

| 检查 | 结果 |
|---|---|
| `npm run build` | ✅ |
| `npx eslint .`（仓库自带 lint） | ✅ 0 error |
| `npx tsc --noEmit` | ✅ 0 error |
| `npm test` | ✅ 全部 PASS（含 `promise-guard` 测试） |
| 同口径复现扫描 | ✅ 见上表；三规则归零，逐规则无上升 |

行为变化只在失败路径：正常保存/切换/渲染的界面与文案不变；失败时的 `Notice` 是错误提示，不是布局/
视觉设计变更（基线在这些路径上刻意静默，没有可对照的同一画面，故按 §6.5 口径不附 Before/After 截图）。
展页计数仍以发布后重新提交审核复扫为准。

## 7. 维护约定

1. 每次发布并重新提交审核后，重跑 `scorecard-inventory.mjs` 更新快照，并把展页新计数写回本目录；
   分类增减时同步更新 §3 表格。
2. 修复前后用 `reproduce-eslint.mjs` 记录同口径计数；差异要能解释（环境差异写清楚，不能拿本地数字冒充展页）。
3. 不得通过关闭规则、扩大 ignore、`eslint-disable` 或调低扫描版本来造计数下降；
   如需临时豁免，需要在本目录单独记录原因和编号。
4. 后续可把 `reproduce-eslint.mjs` 的计数做成 CI ratchet（本 PR 未做，避免 CI 依赖网络安装扫描器）。
