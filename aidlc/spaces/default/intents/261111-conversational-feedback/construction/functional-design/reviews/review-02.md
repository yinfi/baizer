## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-11T12:10:54Z
**Iteration:** 2

### Findings

**Prior findings**

| ID | Now | Severity | Note |
|---|---|---|---|
| Critical（可编辑预览两份字节） | Fixed | Critical | `frontend-components.md` §4 已把唯一权威钉在 `request.args`：渲染、编辑写回、执行提交三者同源；`ExternalPublishMeta` 去掉 `title`、正文不再放 `preview.newContent`，并写明「preview 只承载不可编辑元信息」；`entities.md` 的 `IssuePayload` 增加同一条不变量。补了「编辑 → 重挂载 → 显示 == 提交字节」的测试要求。闭合并经代码核验：`message-renderer.ts:120` 传的就是 `message.approval`，`adoptMessages` 只浅拷贝消息对象、`approval` 引用不变，`runApproval` 读同一对象并把 `request.args` 交给 `executeApprovedAction`（`chat-controller.ts:816`）。 |
| Major-1（`write ⇒ 串行` 不在提交路径） | Fixed | Major | 决策表 5 删掉了那条锁定未走分支的测试要求，并把 `risk`/`executionMode` 的真实作用范围写成两列；并发保护改为落在真实提交路径上的三层（`requestId` / dedupKey 跨卡片复用 / 同步原子认领），`BR4.4` 与工作流 3、4 同步改写。与代码一致：`performApprovedAction` 只调 `toolRegistry.execute`（`model-service.ts:1138`），不读 `risk`/`executionMode`。③ 的前提未写明，见 New findings。 |
| Major-2（四个工具可见范围未定义） | Fixed | Major | 新增 `Tool.visibility`、`getAllDefinitions({ includeFeedbackTools })` 缺省不含、决策表 6 写死门控与「可见性 vs 技能收窄是两件事」。旁路已核验：`getAllDefinitions()` 全仓只有 `base-chat-runtime.ts:347` 一个调用点；`getTools()` 只有 `model-service.ts:876`（`getAvailableTools`）一个外部调用者，而后者只有 `chat-controller.ts:595`（`/tools`）一个调用者；`adaptToolDefinitionsToPi` 只有 `harness-chat-runtime.ts:65` 一个构造点，`turn.conversationId` 就在作用域内；`ActiveRunController.setActiveTools` 只接受工具**名**、只能在既有集合内收窄，不构成旁路。fail-closed 缺省关得住。残留一处 fail-open，见 New findings。 |
| Major-3（`feedbackOutcome` 没有读写路径） | Fixed | Major | 采纳「从草稿派生」，删除快照字段设想；`TabBarItem` 的派生字段不持久化，因此不构成第二处真相。新增 `BR1.6` 补上了真正需要持久化的那一件事（会话 `kind`），并写死写入点 `saveActiveTab`、恢复点 `createTabData(snapshot)`。两点核对通过：`ConversationStore.cloneSnapshot` 是顶层展开（`conversation-store.ts:152-154`），新字段能随快照落盘；`isConversationFile` 只校验必填字段，多一个 `kind` 不会导致快照被判非法。 |
| Major-4（守卫只扫工作树） | Fixed | Major | 抽成 `scripts/guard-credentials.sh`，CI `--range`、发布 `--history`，扫 diff 文本（删除行同样命中），两份都补 `fetch-depth: 0`。我在临时仓库独立复现：「先提交 token 再删掉」在 `--range` 与 `--history` 下均命中（exit 0 = HIT），旧的树扫描对同一仓库 CLEAN——评审指出的漏洞确实被关掉了。`{30,}` 阈值与真实格式长度一致，本仓 `--history` 与 `--range main..HEAD` 均 CLEAN。残留一处错误处理缺陷，见 New findings。 |
| Minor-1（`previewSupportsEditorPreview` 被新 kind 命中） | Fixed | Minor | 已加入排除集合并补测试要求；同时因为正文不再放 `preview.newContent`，`showApprovalPreviewInEditor` 形成双保险。 |
| Minor-2（provider → dropdown 缺确定性映射） | Fixed | Minor | 新增决策表 3b（穷尽映射，无「映射不到」分支）；`DiagnosticsSnapshot.providerType` 改为 `provider` 且只携带已落到模板域的取值，原始 label 不进快照；`BR3.2` 的同源测试扩为「字段 id + dropdown 选项取值 + label 取值」，并加了穷尽性与覆盖性断言。`Anthropic` 例外集的处理与编排层的决定一致。 |
| Minor-3（dedupKey 口径不一致） | Fixed | Minor | `BR4.4` 与 `entities.md` 的唯一性约束已互相对齐并互相引用。语义定性仍不准确，见 New findings。 |
| Minor（`PreparedChatTurn` 缺隔离开关，评审在断言 1 中附带指出） | Fixed | Minor | `BR1.2` 已写明开关必须在 `ChatTurnRequest` **与** `PreparedChatTurn` 两处都存在，并说明理由（retain 短路发生在 `HarnessChatRuntime`）。与代码一致：`retainCompletedTurn` 的调用点在 `harness-chat-runtime.ts:285/293`，拿到的是 `PreparedChatTurn`。 |

**New findings**

| Severity | Location | Finding | Required action |
|---|---|---|---|
| Major | aidlc/spaces/default/intents/261111-conversational-feedback/construction/functional-design/rules.md > BR1.1 的 logic；及 functional-spec.md > 决策表 6「组装点」行 | 反馈会话的能力隔离有一条 fail-open 通路。`BR1.1` 的反馈分支写的是「以 forcedSkillName = "feedback" 解析激活技能，工具集 = 该技能声明的 tools ∪ {read_skill}」，但**没有写技能解析不到时的行为**；`SkillRegistry.activateSkill` 在技能被禁用或不存在时返回 `null`（`skill-registry.ts:283-288`，`isEnabled` 读 `settings.disabledSkills`），于是 `buildSkillModeTools(null, request)` 落到既有的「返回全量工具集」分支，而决策表 6 又会因为 `isolatedContext === true` 把 `includeFeedbackTools` 置真——结果是反馈会话拿到**全量工具集（含所有 vault 读工具）加上四个反馈工具**。内置 skill 在设置页有逐项开关（`settings.ts:1256-1258` 的 `skill.<name>`，`setSkillControlValue` 写 `disabledSkills`），用户点一下即可触发。触发后 BR1.1 的 `violation_behaviour` 描述的后果（模型能读用户笔记，而这些内容会被写进一条公开发布的 issue）就成立了，而且是静默的。此外该 logic 块里有两条 `ELSE`（「走既有技能解析路径」重复出现一次），规则本身读不出确定语义。 | 在 `BR1.1` 的反馈分支里把「技能解析不到」写成显式且 fail-closed 的一条：反馈会话拿不到 `feedback` 技能时，工具集**不得**退回全量，只能是四个反馈工具 ∪ `read_skill`，或直接拒绝该轮并给出明确提示；同时把重复的那条 `ELSE` 合并掉。补一条测试：把 `feedback` 从 `disabledSkills` 之外置为禁用后发起反馈会话，断言模型拿到的工具集里没有任何 vault 读工具。 |
| Minor | scripts/guard-credentials.sh > `scan_range` 与退出码分支 | 「扫描本身出错时同样失败，不得把读不到历史当成干净」这条承诺不成立。`matches="$(scan_range "$@" \| grep -EI "$PATTERN")"` 在 `set -o pipefail` 下取的是管道里**最右**的非零退出码：`git log` 失败（如 128）且没有输出时 `grep` 返回 1，于是 `rc=1`，脚本判定为 CLEAN 并 `exit 0`，`if [ "$rc" -ne 1 ]` 那条错误分支永远不会走到。实测该构造：`git-fails path -> rc=1`。`base` 的可解析性有前置校验挡着，所以可达性不高（主要是 `base` 可解析、range 本身不可用的情形），但这是一条被明确写进 `BR6.1` 与 `scripts` 注释的保障。 | 把 `git` 的退出码与 `grep` 的退出码分开取（例如先跑 `scan_range` 落状态，再单独判 grep），使「读不到历史」走出 `exit 1`；补一个「base 可解析但 range 不可用」的用例，断言脚本返回 1 而不是 0。 |
| Minor | aidlc/spaces/default/intents/261111-conversational-feedback/construction/functional-design/rules.md > BR4.4 的 ③；及 entities.md > FeedbackDraft.dedupKey 约束 | 「提交前同步原子认领」的成立前提没有写出来。这一步要真的关掉窗口，必须满足两个未声明的条件：草稿集合是**进程内共享的同一份内存对象**，且按 dedupKey 的查找是同步的。产物只说草稿持久化走 `plugin.saveData()` / `data.json`，没有说读路径；若实现时在 `execute` 里先 `await` 一次加载草稿，两次并发批准就又都能通过。另外 ② 已经保证同 dedupKey 只存在一张卡片，③ 实际是冗余的一层（不是错，但它挡不住任何 ② 挡不住的东西，容易被当成主要保障）。 | 写明 ③ 的前提（草稿集合是内存单例、按 dedupKey 的查找在同一个同步块内完成），或改为维护一张同步的 dedupKey 认领表；补一条测试：对同一 dedupKey 同时发起两次批准，断言只发出一次写入请求。 |
| Minor | aidlc/spaces/default/intents/261111-conversational-feedback/construction/functional-design/rules.md > BR4.4 与 entities.md > FeedbackDraft.dedupKey 约束 | dedupKey 的「身份」定性与其算法不一致。算法仍是「由 `kind + targetIssueNumber + 归一化后的 title + 归一化后的 body` 计算」，所以**卡片上的编辑不改变它，对话里改写内容会改变它**：改写后派生新键、匹配不到旧草稿，于是新建一份草稿，旧草稿留在 `draft` 状态并占用未提交上限 20。产物两处都称它是「这一次反馈的身份，不是内容校验和」，按字面理解会让人以为它对同一会话恒定，从而写出「会话内只派生一次」的实现——那会破坏 ② 的作用。 | 把措辞改成与算法一致（「渲染时的内容派生键，一经派生不再随卡片编辑变化」），并补一句说明：对话改写会派生新键、旧草稿保留并计入上限，需由用户按 BR5.4 的提示清理。 |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| `git --no-pager log -p --format= --all \| grep -EI '<PATTERN>'` 与本仓 `--range main..HEAD` 同款命令 | 均 exit 1（无命中） | 本仓库在全量历史与本次变更范围下都干净；`{30,}` 阈值不会误报 `test/memory-manager.test.ts` 的历史 fixture。 |
| 临时仓库正负对照（自建，`--range <base>..HEAD` / `--all` / 旧树扫描三种） | 「先提交 token 再在同一 PR 删掉」：`--range` exit 0（HIT）、`--history` exit 0（HIT）、旧树扫描 exit 1（CLEAN） | 独立复现了 Major-4 的漏洞与修复：新守卫拦得住「进过历史又被删掉」的形态，旧守卫拦不住。 |
| 守卫退出码构造实测（`set -euo pipefail` 下 `m="$( (exit 128) \| grep -E x )"`） | `rc=1` | 确认「扫描出错即失败」不成立——`pipefail` 取的是最右非零码，git 失败被 grep 的 1 掩盖，脚本会报 CLEAN。对应上面的 Minor。 |
| `git grep -c` 对 `traceability.json` 计数 | `"status": "OK"` = 44，`"status": "N/A"` = 13，`"id": "FR` = 48，`"id": "NFR` = 8，`"id": "BR` = 1 | 覆盖率完整：48 FR + 8 NFR = 56 行，OK 44 / N/A 12（另 1 条 N/A 在 `reverse` 的 BR9.2 上）。与产物与编排层的数字逐位一致。 |
| `git grep -c '^  - id: BR'` 对 `rules.md` 计数 | 39 | 规则集 39 条，与追溯矩阵引用的条数一致（38 条原规则 + 新增 BR1.6）。 |
| 代码核验（`getAllDefinitions` / `getTools` / `getAvailableTools` / `adaptToolDefinitionsToPi` / `toolRegistry.execute` / `ToolContext` / `activateSkill` / `disabledSkills` 的调用点枚举） | 见上表各行 Note | fail-closed 缺省关得住、旁路为零；同时定位到 `activateSkill` 返回 null 的 fail-open 通路与 `disabledSkills` 的设置页入口。 |

本阶段定义未提供 validation tools；CI 未在本 PR 触发（`ci.yml` 的 `pull_request.branches: [main]` 过滤的是基分支，本 PR 基分支为 `agent/aidlc-product-agent/1ea36048266f`，已读配置确认），因此守卫的 CI 接线未经 CI 验证——上面是按脚本与 workflow 文本逐行核验的。

### Summary

返工的 1 Critical + 4 Major + 3 Minor 全部真实闭合，且闭合方式比最小改动更彻底：Critical 用「唯一权威 = `request.args`」从结构上消除了两份字节；Major-1 把并发保护搬到了真实提交路径上并删掉了假保障；Major-2 的 fail-closed 缺省经旁路枚举确认关得住（`getAllDefinitions`、`getTools`、`adaptToolDefinitionsToPi` 各只有一个调用点，steering 只能收窄工具名）；Major-3 用 `BR1.6` 补上了真正需要持久化的那件事并写死了读写点；Major-4 的守卫我在临时仓库独立复现了漏洞与修复。剩下一条 Major：反馈会话在 `feedback` 技能被禁用或解析不到时会静默退回**全量工具集**，恰好是 BR1.1 要防的那件事，而内置 skill 在设置页一键可关——建议进开发前顺手补上这条 fail-closed 分支，它只是一个子句加一条测试。另有三条 Minor（守卫错误处理、原子认领的前提、dedupKey 的措辞）。这些都不影响可实施性，判定 READY。
