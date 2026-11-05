# Review 扫描分类清单（搬运快照）

- 来源：https://community.obsidian.md/plugins/baizer
- 拉取时间：2026-11-05T01:55:28.115Z
- 当前版本：1.5.0
- 扫描代码版本：65020a8862aeaf88d41a2e164a7f779c3281ddd0
- 页面原文：3002 issues found by automated scans of the latest release.（Warnings 2972，Other 30，Passed 5）

## Warnings（Risk 级别）

| # | 分类标题 | 规则 | 页面计数 | 位置条目 | 命中文件数 |
|---|---|---|---|---|---|
| 0 | Unsafe member access on an error or any typed value | @typescript-eslint/no-unsafe-member-access | 1150 | 1150 | 61 |
| 1 | Unexpected any. Specify a different type. | （页面未列出） | 553 | 553 | 67 |
| 2 | Unsafe assignment of an error or any typed value | @typescript-eslint/no-unsafe-assignment | 458 | 458 | 51 |
| 3 | Unsafe call of an error or any typed value | @typescript-eslint/no-unsafe-call | 370 | 370 | 44 |
| 4 | Passes unsafe values into typed parameters | @typescript-eslint/no-unsafe-argument | 157 | 157 | 35 |
| 5 | Returns unsafe values from typed code | @typescript-eslint/no-unsafe-return | 71 | 71 | 33 |
| 6 | This assertion is unnecessary since it does not change the type of the expression. | （页面未列出） | 46 | 46 | 12 |
| 7 | Avoid !important — override styles by increasing selector specificity or using CSS variables instead. | （页面未列出） | 24 | 24 | 1 |
| 8 | Use 'window.setTimeout()' instead of 'setTimeout()' for popout window compatibility. | （页面未列出） | 19 | 19 | 12 |
| 9 | Use 'window.clearTimeout()' instead of 'clearTimeout()' for popout window compatibility. | （页面未列出） | 15 | 15 | 6 |
| 10 | This assertion is unnecessary since the receiver accepts the original type of the expression. | （页面未列出） | 13 | 13 | 10 |
| 11 | Promise returned in function argument where a void return was expected. | （页面未列出） | 13 | 13 | 3 |
| 12 | Uses document.createElement instead of Obsidian's createEl helpers | obsidianmd/prefer-create-el | 10 | 10 | 5 |
| 13 | Avoid using 'globalThis'. Use 'window' or 'activeWindow' for popout window compatibility. | （页面未列出） | 9 | 9 | 6 |
| 14 | Promises must be awaited, end with a call to .catch, end with a call to .then with a rejection handler or be explicitly marked as ignored with the void operator. | （页面未列出） | 8 | 8 | 5 |
| 15 | Obsidian's configuration folder is not necessarily .obsidian, it can be configured by the user. Use Vault#configDir to get the current value | （页面未列出） | 8 | 8 | 5 |
| 16 | 'any' overrides all other types in this union type. | （页面未列出） | 8 | 8 | 3 |
| 17 | Empty block statement. | （页面未列出） | 4 | 4 | 2 |
| 18 | Use 'FileManager.trashFile()' instead of 'Vault.trash()' to respect the user's file deletion preference. | （页面未列出） | 4 | 4 | 3 |
| 19 | Avoid :has — it can cause significant performance issues due to broad selector invalidation. | （页面未列出） | 4 | 4 | 1 |
| 20 | Unnecessary escape character: \). | （页面未列出） | 3 | 3 | 3 |
| 21 | Unnecessary escape character: \[. | （页面未列出） | 3 | 3 | 2 |
| 22 | Avoid unnecessary logging to console | （页面未列出） | 2 | 2 | 2 |
| 23 | Unexpected lexical declaration in case block. | （页面未列出） | 2 | 2 | 1 |
| 24 | A method that is not declared with this: void may cause unintentional scoping of this when separated from its object. Consider using an arrow function or explicitly .bind()ing the method to avoid calling the method with an unintended this value.  If a function does not access this, it can be annotated with this: void. | （页面未列出） | 2 | 2 | 1 |
| 25 | Unexpected use of 'localStorage'. Prefer App#saveLocalStorage / App#loadLocalStorage functions to write / read localStorage data that's unique to a vault. | （页面未列出） | 2 | 2 | 1 |
| 26 | Unexpected browser feature "css-display-contents" is only partially supported by Obsidian 1.6.5 | （页面未列出） | 2 | 2 | 1 |
| 27 | Unexpected browser feature "multicolumn" is only partially supported by Obsidian 1.6.5 | （页面未列出） | 2 | 2 | 1 |
| 28 | Direct Filesystem Access: Uses the Node.js fs module to access the filesystem outside of the Obsidian vault API. Can read and write any file on the system. | （页面未列出） | 1（页面未显示徽标，按 1 条） | 0 | 0 |
| 29 | Irregular whitespace not allowed. | （页面未列出） | 1（页面未显示徽标，按 1 条） | 1 | 1 |
| 30 | Unnecessary escape character: \.. | （页面未列出） | 1（页面未显示徽标，按 1 条） | 1 | 1 |
| 31 | Unnecessary escape character: \?. | （页面未列出） | 1（页面未显示徽标，按 1 条） | 1 | 1 |
| 32 | Unexpected use of 'fetch'. Use the built-in requestUrl function instead of fetch for network requests in Obsidian. | （页面未列出） | 1（页面未显示徽标，按 1 条） | 1 | 1 |
| 33 | This PluginSettingTab does not implement getSettingDefinitions(); its settings will not appear in Obsidian's settings search for users on 1.13.0 or later. Consider adopting the declarative settings API. | （页面未列出） | 1（页面未显示徽标，按 1 条） | 1 | 1 |
| 34 | Promise-returning function provided to property where a void return was expected. | （页面未列出） | 1（页面未显示徽标，按 1 条） | 1 | 1 |
| 35 | Use 'window.requestAnimationFrame()' instead of 'requestAnimationFrame()' for popout window compatibility. | （页面未列出） | 1（页面未显示徽标，按 1 条） | 1 | 1 |
| 36 | Use 'window.clearInterval()' instead of 'clearInterval()' for popout window compatibility. | （页面未列出） | 1（页面未显示徽标，按 1 条） | 1 | 1 |
| 37 | Unexpected duplicate "background" | （页面未列出） | 1（页面未显示徽标，按 1 条） | 1 | 1 |

## Other（Info 级别）

| # | 分类标题 | 规则 | 页面计数 | 位置条目 |
|---|---|---|---|---|
| 0 | '_' is defined but never used. | （页面未列出） | 8 | 8 |
| 1 | 'e' is defined but never used. | （页面未列出） | 7 | 7 |
| 2 | sessionRef is deprecated. 阶段A 起改用 sessionRefs(per-conversation)。保留字段仅供旧数据迁移。 旧版全局单会话的引用。loadSettings 会把它迁移到 sessionRefs 的一个兜底键后不再写入。 | （页面未列出） | 3 | 3 |
| 3 | Missing GitHub artifact attestations for release assets | main.js, styles.css | 2 | 0 |
| 4 | 'error' is defined but never used. | （页面未列出） | 2 | 2 |
| 5 | substr is deprecated. A legacy feature for browser compatibility | （页面未列出） | 2 | 2 |
| 6 | Vault Enumeration: Enumerates all files in the vault (vault.getFiles, getMarkdownFiles, etc.). Gives the plugin access to every file path in the vault. | （页面未列出） | 1（页面未显示徽标，按 1 条） | 0 |
| 7 | Clipboard Access: Reads or writes the system clipboard. May expose content copied from outside Obsidian. | （页面未列出） | 1（页面未显示徽标，按 1 条） | 0 |
| 8 | timeoutMs is deprecated. 保留字段以兼容调用方旧签名，但已不再消费。 无状态生成迁移到 pi completeSimple 后走原生 signal 硬中断； 超时应由调用方用 AbortSignal 表达，而非此毫秒数。 | （页面未列出） | 1（页面未显示徽标，按 1 条） | 1 |
| 9 | '_providerId' is assigned a value but never used. | （页面未列出） | 1（页面未显示徽标，按 1 条） | 1 |
| 10 | 'err' is defined but never used. | （页面未列出） | 1（页面未显示徽标，按 1 条） | 1 |
| 11 | '_error' is defined but never used. | （页面未列出） | 1（页面未显示徽标，按 1 条） | 1 |

## Passed

- Vault Read: Reads individual vault files via the Obsidian API (vault.read, vault.cachedRead)
- Vault Write: Creates or modifies vault files via the Obsidian API (vault.modify, vault.create, etc.)
- No vulnerable dependencies found.
- No obfuscation detected.
- Build reproduced the release main.js byte-for-byte

## Disclosures

| # | 标题 | 说明 |
|---|---|---|
| 0 | Plugin might make requests to external domains | Plugin might make requests to external domains |
| 1 | Number of network request calls | Number of network request calls |
| 2 | Malware scan not available. | Malware scan not available. |
| 3 | Network requests scan not available. | Network requests scan not available. |
