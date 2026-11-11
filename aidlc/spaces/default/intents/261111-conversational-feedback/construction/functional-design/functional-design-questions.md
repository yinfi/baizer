# Functional Design — 澄清问题（本阶段已结清）

本次由编排层直接派发 `functional-design`，**未经过 `units-generation` / `domain-design` / `contract-design`**，因此没有 Unit DAG、没有 `components.md`、没有 `contract-summary.md`。按阶段说明「输入缺失时不臆造缺失产物」，本阶段以 `inception/requirements-analysis/requirements.md` 为唯一规范输入，以**现有代码结构作为既成领域设计**（与 `261021-pi-runtime-refactor` 同一处理方式），产物落在 `construction/functional-design/`（不设 per-unit 子目录）。

下面 12 个问题中，Q3 / Q9 / Q12 是本阶段新增的**推导结论**（PRD 与编排层可否决），其余为设计决策。每条都附了「否决代价」。

## Q1. [架构] 反馈会话的上下文隔离（FR2.7 双隔离）落在哪一层？

`prepareTurn` 在 `memoryManager` 存在时无条件注入 `recallForPrompt` 召回与 Mental Model 块（`base-chat-runtime.ts:83-96`），环境上下文则由 UI 侧 `ContextController.collectCommandContext()` 经 `ObsidianContextService` 注入 `active-note:` / `backlinks:` 两类项（`obsidian-context-service.ts:92`）。

- A.（推荐）**会话级显式开关**：`chatStream`/`chat` 末尾新增可选 `turnOptions?: ChatTurnOptions`（`{ isolatedContext?: boolean; forcedSkillName?: string }`），透传进已有的 `ChatTurnRequest`（该类型已有 `forcedSkillName` 字段，只需补 `isolatedContext`）。`prepareTurn` 在 `isolatedContext` 为真时**同时**跳过记忆注入并剔除环境上下文项（复用既有 `stripAmbientContext`）。
- B. 只靠 UI 侧传空 `contextItems` + `selection`，运行时不做任何判断。
- C. 在 `ChatRuntimeDeps` 上注册「隔离会话 id 集合」，运行时按 `conversationId` 查表。

[Answer]: A. 会话级显式开关

**为什么不选 B**：隔离会退化成「UI 约定」——`collectCommandContext({ includeCurrent: false })` 今天成立，明天一次重构（例如统一上下文采集入口）就可能把当前笔记带回来，而且**失败是静默的**（用户看不到自己的笔记被写进了公开 issue）。B 把安全属性放在了最容易被无意改掉的位置。
**为什么不选 C**：隐藏状态，且 `conversationId` 的登记时机与 `prepareTurn` 的调用时机存在竞态（tab 重挂载后谁负责重新登记）。A 的显式参数在调用点就可见，测试也只需构造一个 request。
**否决代价**：改用 B/C 需重做 FR2.7 的验证方式，且 FR2.7 要求的「必须是反馈会话专属开关、不得改动普通对话记忆行为」在 B 下无法用测试锁定。

## Q2. [架构] FR6.1 要求的「可编辑的提交预览」如何落地而不污染既有审批卡？

现有审批卡是**只读**的：`renderChangePreviewCard` 渲染的是 diff（`change-preview-card.ts:3-16`），`ChangePreviewKind` 是闭合联合类型（`change-preview.ts:1-8`），没有任何编辑能力。

- A.（推荐）**扩展 `ChangePreview` 而不是另造确认 UI**：新增 `kind: 'external-publish'`，并新增一个可选字段承载对外发布的元信息（仓库、类型、label、目标 issue 号）；卡片在且仅在 `kind === 'external-publish'` 时把标题与正文渲染为可编辑控件，**编辑值写回 `request.args`**（该结构随消息快照持久化，见 `approval-card.ts` 的 `ApprovalRequest`），执行时 `executeApprovedAction(action, request.args, ...)` 天然以编辑后的值为准。
- B. 审批卡保持只读；「编辑」发生在对话里——智能体先把完整草稿打印出来，用户用自然语言要求修改，改完再调工具出卡，卡只是最终闸门。
- C. 完全不复用审批卡，为反馈另造一套确认 UI。

[Answer]: A. 扩展 `ChangePreview`，卡片在 `external-publish` 下可编辑

**为什么选 A 而不是 B**：FR6.1 明确要求「用户可在**预览中**编辑」，B 把编辑移出了预览环节，属于对已定稿 Must 需求的改写；而 A 的编辑值落在**已持久化的 `request.args`** 上，重挂载不丢编辑，也不存在「卡片显示的和实际提交的不是同一份字节」这种对不可撤销公开写操作最危险的偏差。
**为什么不选 C**：直接违反 PRD 约束「复用既有审批机制：不另造确认 UI」。
**收窄风险的手段**：可编辑分支由 `preview.kind === 'external-publish'` 唯一门控，其余 kind 的渲染路径一行不动，并补一条测试断言「非 `external-publish` 的预览不出现任何可编辑控件」。
**否决代价**：改回 B 需修订 FR6.1 的措辞（编辑不在预览中）；改 C 需重做一套 UI 且与现有 `requestId` 去重、`ApprovalState` 生命周期脱钩。

## Q3. [产品] 反馈会话要不要把对话内容写进长期记忆（`retainCompletedTurn`）？

PRD 只规定了「不注入」（FR2.7），没规定「不写入」。`BaseChatRuntime.retainCompletedTurn`（`base-chat-runtime.ts:411-417`）会在 `memoryManager` 存在时把整轮存进 Hindsight。

- A.（推荐）**不写入**：反馈会话对记忆系统**只读为零、写也为零**，即完全不触碰 `MemoryManager`。
- B. 正常写入（与普通对话一致）。

[Answer]: A. 不写入

**理由**：其一，隔离契约若只单向（读为零、写为非零），测试与推理都要分两个方向，而收益为零——反馈会话的产物已经落在 issue 与会话 JSONL 两处，记忆里再存一份没有消费者。其二，一次性的报障对话写进长期记忆后会污染后续普通对话的召回（"上次你说 XXX 有问题"这类无关噪声）。其三，写入意味着反馈内容有可能在未来某个普通对话里被召回，而那条链路不受 FR2.7 约束。
**否决代价**：改回 B 只需去掉 `isolatedContext` 对 retain 的短路，但需要重新评估「反馈内容经记忆回流到普通对话」的隐私影响。

## Q4. [产品] FR6.2 的联系方式取舍——要不要加一个「联系方式」字段？

- A.（推荐）**不加字段**：只把取舍讲清楚——「所有 issue 以发布方账号发出、不显示提交者身份；想被追问就在正文里留下联系方式，而**留下即等于公开它**」，由用户在正文里自行决定。
- B. 加一个可选的「联系方式」字段，随正文渲染进 issue。

[Answer]: A. 不加字段

**理由**：其一，加字段等于**邀请**用户公开 PII——一个标着「可选」的输入框会把「留下邮箱」变成默认动作，而这里的后果是不可逆的公开；其二，PRD 的「范围外」已明确「不做『用户身份标识』字段……联系方式由用户在正文里自行决定是否留下」，加字段与该条冲突；其三，用户真的想留，正文里写一句就够了，插件的字段化不增加任何能力，只增加暴露面。
**配套**：`feedback` 技能必须被明确告知**不得主动索要**联系方式；用户主动问「你们怎么联系我」时，只解释取舍、不代填。

## Q5. [开发] 「最近一次错误摘要」（FR6.3）的来源与截断策略？

- A.（推荐）**会话内内存环形缓冲**：新开一个窄接口，只在明确位置记录 `{ at, surface, message }`，**不落盘**（插件重载即清空）；输出前做单行化 + 300 字符截断 + 路径/凭据脱敏；脱敏后为空则整项省略。
- B. 从 `logger` 的日志环（`logger.ts` 已有 `maxLogs = 1000`）里捞最后一条 `error`。
- C. 不提供该字段（从白名单里去掉）。

[Answer]: A. 专用环形缓冲，不落盘

**为什么不用 B**：日志是**为开发者写的**，里面会有绝对路径、vault 路径、provider 端点等；而 `logger` 没有任何脱敏层。把日志内容搬进一个会被公开发布的字段，等于把「日志里恰好有什么」变成对外暴露面——这正好是 FR6.3 与 FR6.8 要防的。另起一条**为公开而设计**的通路，比事后过滤既有日志可靠。
**为什么不选 C**：错误摘要是 issue 可定位性的关键（模板里 console output 一栏没有它就基本空白），去掉会让 FR6.3 的白名单名不副实。
**否决代价**：改 B 需要先给 `logger` 加脱敏层，改动面反而更大。

## Q6. [开发] 是否采纳 token 混淆（构建期分段/编码、运行期拼接）？

- A.（推荐）**不采纳**。只做三项**确定性**守卫：CI 追踪文件守卫（BR6.1）、`.gitignore` 补 `.env`（FR4.2）、发布 preflight（FR4.2）。
- B. 采纳混淆，降低自动化爬取命中率。

[Answer]: A. 不采纳

**理由**：其一，A1 已核验不成立（token 不进 git、不进 secret scanning 的扫描范围），混淆失去最直接的动机；其二，FR4.7 已确认非对称加密在本场景不成立，混淆只是把「一行代码」变成「一小时逆向」，不改变安全边界，属于「为看起来更安全而引入复杂度」——FR4.7 明令不得为这个理由引入；其三，混淆会让源码里的 token 呈现方式与运行期不一致，反而给 FR6.8「bundle 中 token 字面量只出现在预期注入点」这条测试制造麻烦。
**否决代价**：改 B 需在 `esbuild.config.mjs` 加一段注入插件，并同步放宽 FR6.8 的静态检查口径。

## Q7. [架构] `risk: 'write'` 的两个消费方如何保证都被拿到？

`risk` 在本仓只有两处消费方：`needsApproval()`（`permission-service.ts:109`）与 `inferToolExecutionMode()`（`pi-tool-adapter.ts:24`，`write`/`plugin-control` → `sequential`）。

- A.（推荐）两个工具声明 `risk: 'write'`，并把「`write` ⇒ `sequential`」写成**显式契约**（在 functional-spec 的决策表里列出，并补一条测试锁定 `inferToolExecutionMode('create_github_issue', { risk: 'write' }) === 'sequential'`），而不是当作顺带得到的副作用。
- B. 只依赖 `executionMode: 'sequential'` 显式声明，`risk` 只按审批需要选。

[Answer]: A. 声明 `risk: 'write'` 并显式锁定串行

**理由**：串行执行在这里不是性能选项，而是**正确性要求**——并发提交同一份草稿会产生重复 issue。把它写在测试里，将来有人重构 `inferToolExecutionMode` 的默认分支时会被立刻拦下；不写，它就是一条谁都不知道为什么存在的隐式依赖（`inferToolExecutionMode` 的兜底分支恰好也返回 `sequential`，所以破坏它甚至不会立刻暴露）。
**补充**：`executionMode` 也显式写为 `'sequential'`，形成双保险——两者都是本工具的正确性所需，不是冗余。

## Q8. [开发] 类型分类用 labels 还是标题前缀？

PRD FR3.10 说「按 A3 的实测结论决定是否保留标题类型前缀」。

- A.（推荐）**只用 `labels`**：`bug` → `["bug"]`、`enhancement` → `["enhancement"]`，取值与 `.github/ISSUE_TEMPLATE/*.yml` 的 `labels:` 同源，纳入 FR3.5 的同源校验测试；不使用 `[Bug]` / `[Feature]` 标题前缀。
- B. 两者都用。
- C. 只用标题前缀。

[Answer]: A. 只用 labels

**理由**：本功能的 token 是仓库所有者自己的 PAT，A4 的「非协作者标签被静默丢弃」在本场景不成立，标签会正常生效——为不存在的情况加前缀属于 FR3.10 里那个「兜底分类信号」的过度实现。而标题前缀会污染 issue 列表（GitHub 已用标签做了同一件事），且它一旦成为分类依据，就变成第二处需要与模板同源的契约。
**收窄风险**：同源测试同时锁定「label 取值 == 模板 `labels:` 字段」，模板改标签时测试失败。若开发阶段实测发现标签确实被丢弃，回退到标题前缀是一次局部改动，记入 runbook。

## Q9. [开发] 发布 preflight 要不要顺带做一次凭据探活？

FR4.2 只要求「secret 为空时构建失败」。

- A.（推荐）**做**：preflight 在非空校验之后，用内置 token 发一次 `GET /repos/yinfi/baizer`，非 2xx 即阻断发布。
- B. 只做非空校验（严格照 FR4.2）。

[Answer]: A. 做探活

**理由**：B 方案下最贵的失败模式恰恰探活能挡住——「secret 里是一个已撤销/已过期的 token」时，非空校验通过、构建成功、Release 发布，而**所有用户**拿到的是一个必然 401 的版本，且现象是静默的（用户只会觉得反馈按钮不好使）。这个代价（一轮发布 + 用户升级）与一次 GET 完全不成比例。GitHub API 不可用导致发布失败，也是可接受的结果：**不要在无法验证凭据的情况下发布一个内置凭据的版本**。
**边界**：只验「凭据可用」，不验「权限范围恰好是 Issues: write」——后者需要一次真实写入才能确证，不适合放在发布门禁里，留给轮换 runbook 的人工步骤。
**否决代价**：改回 B 只需删掉 preflight 里那一步；代价是重新接受「发布了一个凭据已死的版本」这个失败模式。

## Q10. [架构] 缺少上游 `units-generation` / `domain-design` / `contract-design` 怎么处理？

- A.（推荐）按阶段说明执行：**不臆造缺失产物**，以 `requirements.md` 为唯一规范输入、现有代码结构为既成领域设计；产物落在 `construction/functional-design/`；把「本次未产出组件目录与单元分解」作为流程缺口显式回报编排层。
- B. 顺带补出 `components.md` / `unit-of-work.md` / `contract-summary.md`，让链路自洽。

[Answer]: A. 不臆造，缺口显式回报

**理由**：B 会让本阶段的产物依赖于我自己刚编出来的上游输入，等于把「未经验证的分解」伪装成「已验证的前置」——这正是阶段说明明令禁止的。而且单元分解的粒度会直接影响后续 delivery-planning 的排期，不该由本阶段顺手决定。
**回报内容**：本功能是一个**单单元**特性（一个插件内的自洽切片，无跨服务边界），`components.md` / `unit-of-work.md` 缺失不影响本阶段产物的正确性；但若编排层希望保留完整的 AI-DLC 链路，应在下一棒之前补 `domain-design` + `units-generation`（工作量很小，本阶段的实体/规则可直接作为其输入）。

## Q11. [开发] 暂存草稿队列的上限取多少、超限怎么办？

- A.（推荐）**未提交草稿上限 20**；达上限时**拒绝创建新草稿**并提示用户清理，提供清理入口；成功提交的草稿不计入上限（提交后即可裁剪）。
- B. 无上限。
- C. 超限时静默丢弃最旧的。

[Answer]: A. 上限 20，达上限拒绝新建并提示清理

**理由**：B 会让 `data.json` 无界增长（草稿含用户输入的长文本）。C 直接违反 FR5.6「超出时提示用户清理，而非静默丢弃最旧的」——被丢掉的可能是用户唯一一次认真写的报障内容。
**取 20 的依据**：单个用户在同一版本周期内累积 20 份未提交草稿已属异常，此时正确的动作是提醒他处理，而不是继续囤积。数值本身是策略常量，可在设置里展示当前占用（不提供可配置项，避免 YAGNI）。

## Q12. [开发] `chatStream` 已有 8 个位置参数，`isolatedContext` 与 `forcedSkillName` 怎么加？

- A.（推荐）末尾新增**一个可选 options 对象** `turnOptions?: ChatTurnOptions`，同时承载 `isolatedContext` 与 `forcedSkillName`；**不重构**既有的 8 个位置参数。
- B. 继续加第 9、第 10 个位置参数。
- C. 借机把 `chatStream`/`chat` 重构成单一 options 对象。

[Answer]: A. 末尾加一个 options 对象

**理由**：B 显然不可读。C 是更干净的方向，但它会触及 `chat`/`chatStream` 的全部调用方（UI、selection-menu、测试 mock），属于**本次需求之外的重构**——PRD 约束是「复用既有会话机制」，不是「顺手重构会话入口」。A 让本次新增的两个开关有明确的归属点，且将来若要转 C，收敛点是同一个对象。
**否决代价**：改 C 需一并改所有调用点与测试 mock，diff 会盖过本功能本身的改动。

## Consolidated Summary Confirmation

- Q1：上下文隔离走**会话级显式开关**（`turnOptions.isolatedContext`），在 `prepareTurn` 内同时跳过记忆注入与剔除环境上下文
- Q2：可编辑预览通过扩展 `ChangePreview`（新增 `external-publish` kind）落地，编辑值写回已持久化的 `request.args`
- Q3：反馈会话**不写入**长期记忆（对称隔离，可否决）
- Q4：**不加**联系方式字段，只在警告文案里讲清取舍
- Q5：错误摘要走专用内存环形缓冲，不落盘，单行 ≤300 字符并脱敏
- Q6：**不采纳** token 混淆，只做三项确定性守卫
- Q7：两个工具声明 `risk: 'write'`，并把「write ⇒ sequential」写成测试锁定的显式契约
- Q8：类型只用 `labels` 表达，纳入模板同源校验，不用标题前缀
- Q9：发布 preflight 在非空校验后追加一次凭据探活（可否决）
- Q10：不臆造缺失的上游产物，缺口显式回报编排层
- Q11：未提交草稿上限 20，达上限拒绝新建并提示清理
- Q12：`chatStream` 末尾新增一个可选 options 对象，不重构既有位置参数

Does this all look correct before I generate the artifact?

- Looks correct
- Request changes

[Answer]: Looks correct（本阶段无未决的阻塞性分歧。其中 **Q3 / Q9 / Q12** 是架构师推导结论，**BR8.2（功能默认开启）** 与 **BR9.2（preflight 探活）** 沿用/扩展自 PRD 的推导项——这五项 PRD 与编排层均可否决，否决后的改动范围见各条「否决代价」）
