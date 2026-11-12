## Review

**Verdict:** NOT-READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-11T11:46:35Z
**Iteration:** 1

### Findings

**Prior findings**

| ID | Now | Severity | Note |
|---|---|---|---|

**New findings**

| Severity | Location | Finding | Required action |
|---|---|---|---|
| Critical | aidlc/spaces/default/intents/261111-conversational-feedback/construction/functional-design/frontend-components.md > §4 ChangePreviewCard 的 external-publish 分支（「渲染与交互」表与「编辑值的归属」段） | 卡片的**展示来源**与**提交来源**被拆成两份字节：卡片按 `ChangePreview.newContent` 与 `ExternalPublishMeta.title` 渲染，而编辑只写回 `request.args.title` / `request.args.body`，`preview` 既不随编辑更新、本身也被持久化。于是重挂载 / 切 tab / 重启后卡片重新从 `preview` 渲染，用户看到的是编辑前的旧正文，而提交走 `request.args` 里的新正文——恰好是 BR4.2 与 entities.md 的 `IssuePayload` 要排除的「卡片展示的字节 ≠ 提交的字节」。产物选择方案 A 的理由正是这条不变量，而产物自身违反了它。 | 明确唯一的权威字节来源并写死：让卡片从 `request.args` 渲染标题与正文（`preview` 只承载仓库 / 类型 / label / 目标 issue 号等不可编辑元信息），或让编辑同时写回 `preview.newContent` 与 `meta.title`。二者择一后，补一条「编辑 → 重挂载 → 卡片显示 == 提交字节」的测试。 |
| Major | aidlc/spaces/default/intents/261111-conversational-feedback/construction/functional-design/functional-spec.md > 决策表 5 新增工具的 risk / executionMode 契约（及 rules.md BR4.4） | 「`risk: 'write'` ⇒ 串行执行 ⇒ 防住并发重复提交」这条因果不成立。真实提交发生在 `ModelService.performApprovedAction` → `toolRegistry.execute`，该路径完全不读 `risk` 与 `executionMode`；`inferToolExecutionMode` 只作用于 pi agent loop 内的工具调用，而首次 `create_github_issue` 调用即以 `approval_required` 终止本轮，同轮并发本身不成立。另外决策表 5 要求锁定的 `inferToolExecutionMode('create_github_issue', { risk: 'write' })` 会先命中 `tool.executionMode` 分支（表中已显式设为 `sequential`），锁的是一条实际走不到的代码路径。BR4.4 的幂等预检又只拒绝 `submitted` / `submitting`，两张同 dedupKey 且均为 `awaiting_confirmation` 的卡片可被先后批准。 | 把并发保护写成真实生效的机制：说明跨卡片重复提交由 dedupKey 兜住、同轮并发不存在（首个调用即 terminate），并在 BR4.4 中把预检扩展到 `awaiting_confirmation`（或在发出网络请求前先原子置 `submitting`）；同时删除「write 顺带拿到串行执行」的因果表述与那条锁定未走分支的测试要求。 |
| Major | aidlc/spaces/default/intents/261111-conversational-feedback/construction/functional-design/functional-spec.md > 决策表 5（及 rules.md BR1.1） | 四个新工具的**注册与可见范围**没有写。`BaseChatRuntime.buildSkillModeTools()` 在无强制激活技能时返回 `toolRegistry.getAllDefinitions()`，即注册进 `ToolRegistry` 的工具对每一个会话可见；BR1.1 只收窄了反馈会话内部。因此 `create_github_issue` / `add_issue_comment` / `search_github_issues` / `get_plugin_diagnostics` 在普通对话、Guardian、选区菜单、知识编译等路径上同样可被调用，而工作流 3 依赖的澄清字段、诊断快照、去重选择在这些上下文里都不存在，`FeedbackDraft.sourceConversationId` 也会指向一个非反馈会话。 | 明确并写死四个工具的可见范围：若全部注册，必须定义非反馈会话下调用时的降级行为、`sourceConversationId` 语义，以及免批的 `search_github_issues` 的边界；若限定在反馈会话，则给出门控方式（可参照既有 `allowPluginControl` 的执行期自门控模式）。同时写清「反馈会话工具收窄」与「工具全局可见」两者的关系。 |
| Major | aidlc/spaces/default/intents/261111-conversational-feedback/construction/functional-design/functional-spec.md > 状态机 2 反馈会话的终态标识（及 frontend-components.md §3） | `ConversationSnapshot.feedbackOutcome` 的读写路径在现有代码里不存在。`ConversationController.saveActiveTab`（`src/ui/history/conversation-controller.ts:32-43`）与 `createTabData`（`src/ui/tabs/tab.ts:22-33`）都是逐字段枚举，`ConversationSnapshot`（`src/ui/types.ts:66-77`）与 `TabData`（`src/ui/tabs/types.ts`）也都是闭合接口——新增字段既不会被写盘，也不会在恢复时回到 tab，终态徽标重启后必然消失。产物只写了「该字段随会话快照一起持久化」。此外该字段与 `FeedbackDraft.submittedIssueNumber` / `submittedIssueUrl` 重复，而产物同时声称「不需要第二处真相」，两者可能不一致。 | 写出这条标识的完整落点（要改的接口、写入点、恢复点），或改为从 `FeedbackDraft` 派生（`sourceConversationId` + `status = submitted`）而不新增快照字段；二选一后删掉与 `FeedbackDraft` 重复的那一份真相。 |
| Major | .github/workflows/ci.yml > Guard against committed credentials（及 .github/workflows/release.yml 同名步骤） | 凭据守卫只扫检出后的工作树（即被构建的那个 commit 的树），不扫本次要并入的提交范围。一个「先提交 token、再在同一 PR 里删掉」的改动能通过守卫，token 仍进入 main 的历史并被 GitHub secret scanning 撤销——正是 BR6.1 要防的那个失败模式（现象是「昨天还好，今天所有用户静默 401」）。 | 让守卫覆盖本次变更的提交范围（例如 `git grep <base>..HEAD`，或取足够 checkout 深度后扫 `git log -p` 的范围），使「进入历史」与「留在工作树」两种情形都被拦住。 |
| Minor | aidlc/spaces/default/intents/261111-conversational-feedback/construction/functional-design/frontend-components.md > §4 与既有审批机制的关系 | 新增 `external-publish` kind 会改变共享组件的既有分支行为：`previewSupportsEditorPreview`（`src/ui/approval-card.ts:35-40`）只排除 `note-rename` / `note-delete` / `plugin-command`，因此 external-publish 卡片上会出现 🎯「Show editor preview」按钮；而 `showApprovalPreviewInEditor`（`src/ui/shell-view.ts:1334-1335`）会取 `preview.newContent` 当作编辑器预览内容打开。产物称「其余 kind 的渲染路径一行不动」，但这条分支恰恰会被新 kind 命中。 | 在产物中决定 external-publish 是否保留该按钮；若不保留，明确把它加入 `previewSupportsEditorPreview` 的排除集合并补测试断言。 |
| Minor | aidlc/spaces/default/intents/261111-conversational-feedback/construction/functional-design/functional-spec.md > 决策表 3 模板字段 → 正文小节（缺陷类 `provider` 行） | `provider` 写入的是 `bug_report.yml` 的 dropdown，其合法取值是模板里 6 个固定选项（Google Gemini / OpenAI / DeepSeek / Qwen·DashScope / Other OpenAI-compatible endpoint / Not relevant to this bug），而 `DiagnosticsSnapshot.providerType` 只有 `openai-compatible` / `anthropic` / `none` 三态，映射是有损的。产物只写「映射到模板下拉项」与「映射不到时写 Not relevant to this bug」，没有给出映射表；BR3.2 的同源测试只比对可填字段的 `id` 集合、不校验 dropdown 的选项取值，写错也不会被发现。 | 在决策表 3 中给出 `providerType` → 模板下拉项的确定性映射（含 `openai-compatible` 落到哪一项），并把 dropdown 的选项取值一并纳入同源校验测试的比对范围。 |
| Minor | aidlc/spaces/default/intents/261111-conversational-feedback/construction/functional-design/rules.md > BR4.4 与 entities.md > FeedbackDraft.entity_level_constraints | 两处对「哪些状态参与 dedupKey 唯一性」的口径不一致：entities.md 要求 `draft` / `awaiting_confirmation` / `submitting` / `submitted` 四态内 dedupKey 唯一、`failed` 允许重复；BR4.4 的预检只拒绝 `submitted` 与 `submitting`，对 `draft` / `awaiting_confirmation` 的重复不做处理，而 functional-spec.md 工作流 3 步骤 2d 的「创建或更新 FeedbackDraft」也没说明按什么键匹配。 | 统一为一处口径：写明步骤 2d 按 dedupKey 匹配已有草稿（而非新建），并把 BR4.4 的预检状态集与 entities.md 的唯一性约束对齐。 |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| `git grep -nEI 'github_pat_[A-Za-z0-9_]{20,}\|gh[pousr]_[A-Za-z0-9]{20,}' -- .`（与 ci.yml / release.yml 中同一条） | CLEAN（exit 0，未命中） | 当前树上守卫通过，两份 workflow 的守卫步骤与产物声明一致。 |
| 守卫正则的正负对照（node `RegExp.test`） | `github_pat_11ABCDEFGHIJKLMNOPQRST` 命中、36 位 `ghp_…` 命中、12 字符 `ghp_abcdefghij12` 不命中、20 字符 `ghp_abcdefghij1234567890` 命中 | 守卫口径与 BR6.1 一致；也确认了 `test/memory-manager.test.ts` 的 fixture 必须缩到 12 字符才能不触发守卫，该处理成立。 |
| `node` 对 traceability.json 的覆盖率交叉核对 | 56 行；状态 OK 43 / N/A 13；无重复 id、无孤儿 id；requirements.md 中 48 条 FR + 8 条 NFR 全部被覆盖，`upstream_ids` 亦为 56 | 覆盖率**完整**，与编排层更正后的数字一致（此前回报的「54 FR / OK 38 / N/A 16」不成立）。 |
| `node` 对 BR 引用的交叉核对 | rules.md 定义 38 条 BR；traceability.json 引用的 BR 全部可解析；无「被引用但未定义」；BR9.2 仅出现在 `reverse`（设计新增、无上游 FR，符合该字段语义）；摘要表 38/38 与定义集完全一致 | 规则集与追溯矩阵之间的引用闭合，无断链。 |
| 手工比对 `.github/ISSUE_TEMPLATE/bug_report.yml` / `feature_request.yml` 的可填字段 `id` 与 labels 取值 | 缺陷类 `what-happened`/`repro`/`plugin-version`/`obsidian-version`/`platform`/`provider`/`surface`/`console` 与 `labels: ["bug"]`；需求类 `problem`/`proposal`/`workaround`/`surface` 与 `labels: ["enhancement"]` —— 与决策表 2 / 决策表 3 逐项一致；`config.yml` 的私密上报链接与工作流 6 一致 | FR3.4 / FR3.5 / FR3.10 的模板同源前提**成立**，决策表 2、3、6 的模板侧事实可依赖。 |

本阶段定义未提供 validation tools，上述均为本次自行执行的核对。

### Summary

设计对现有代码的可证伪断言里，绝大多数经逐文件核验成立：`chatStream` 确为 8 个位置参数、`ChatTurnRequest` 已有 `forcedSkillName`、`stripAmbientContext` 与 `AMBIENT_CONTEXT_PREFIXES`（`active-note:` / `backlinks:`）可复用；编辑值经 `message.approval.args` 确实能到达 `executeApprovedAction`；`extractSyntaxHints` → 生成的 `SKILL.md` → `read_skill` 这条间接通道确实只被 `getEnabledPluginIds()` 排除 `PLUGIN_ID` 一道过滤挡住，且抽取正则不匹配 GitHub token 字符集；模板字段同源、追溯矩阵覆盖完整、规则引用闭合。但另有三条断言不成立或落不了地：`risk: 'write' ⇒ 串行` 不在提交路径上；四个新工具的可见范围未定义而代码默认全局暴露；`ConversationSnapshot` 的新字段没有读写路径。最严重的一条是可编辑预览把「展示」与「提交」拆成两份字节，在重挂载后会稳定复现「用户批准的与他看到的不一致」——这正是该设计为不可撤销公开写入设定的核心不变量，必须在进入 Code Generation 之前修正。
