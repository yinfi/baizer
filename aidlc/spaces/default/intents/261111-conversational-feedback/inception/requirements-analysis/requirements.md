# 需求分析 —— 对话式反馈：与智能体澄清后提交 GitHub Issue

## 意图分析

**用户想达成什么**：把「用户遇到问题 → 自己组织语言 → 自己判断该报给谁 → 自己去 GitHub 建 issue」这条目前完全在插件之外、且大多数用户不会走完的链路，收敛成插件内的一次对话。用户只需要用自己的话把遇到的问题讲出来，智能体负责把它问清楚、补成一份结构完整的 issue，并在用户确认后提交到 GitHub。

要解决的不是「缺一个反馈按钮」，而是**反馈的漏斗损耗**：用户愿意反馈但懒得写清复现步骤、不知道该报给哪个仓库、不确定是不是已知问题，最终选择沉默。因此本需求的价值判据是**反馈的完成率**，而不是入口的数量。

**关键结论（本阶段定死的四件事）**：

1. **入口**：Workbench（`ShellView`）头部新增反馈图标按钮，点击**新开一个专用反馈会话 tab**；另注册命令面板命令，保证用户在任意界面都能触发。不复用普通对话 tab，也不另造独立弹窗——前者会污染用户正在进行的对话，后者要重造流式渲染/工具时间线/审批卡片，违反 DRY。
2. **模型链路**：复用**会话型** `ModelService.chatStream` → pi `agentLoop`（`conversationId` = 该 tab id），通过新增内置技能 `feedback` 做强制激活。不用无状态 `ModelService.generate`：澄清是多轮对话，且需要调用工具（检索已有 issue、读取诊断信息），无状态一次性生成做不到。
3. **提交通道**：新增两个 `risk: 'network'` 原子工具 `search_github_issues` / `create_github_issue`，走 Obsidian `requestUrl`（免 CORS、移动端可用，与 `web-clipper`/`video-transcription` 同一条既有网络通路），默认目标仓库 `yinfi/baizer`。GitHub 的 ISSUE_TEMPLATE 只作用于 Web 表单，**REST API 建 issue 不会自动套用模板**，所以模板的字段结构必须由插件自己在本地渲染成等价的 Markdown 正文，并用测试锁死「插件本地字段清单 == 仓库模板字段」。
4. **降级**：三层降级——① 有 Token 且在线 → 自动提交；② 无 Token 或 GitHub 不可达 → 草稿落本地 outbox + 浏览器预填 `new issue` 页面；③ LLM 本身不可用 → 对话式澄清根本走不下去，是否补一个静态表单兜底，**待用户拍板**（见 Q3）。

## 现有形态盘点（本需求的落地依据）

以下均为本次 `multica repo checkout` 后逐文件核实的现状，不是假设。

| 面 | 现状 | 对本需求的意义 |
|---|---|---|
| 插件形态 | Obsidian 插件 `baizer` v1.7.2，`manifest.json` `isDesktopOnly: false` | 全部改动必须移动端可用，禁 `child_process` |
| 模型链路 | 唯一入口 `ModelService`。两条路径：会话型 `chat`/`chatStream` → pi `agentLoop`（带工具/历史/审批/steering）；无状态 `generate` → pi `completeSimple` | 澄清对话走前者 |
| 强制激活技能 | `BaseChatRuntime.prepareTurn` 接受 `forcedSkillName`；`ModelService.executeSlashSkillCommand` 已用此参数。`chatStream` 当前**未透出**该参数 | 反馈会话需要把 `feedback` 技能钉在整段会话上，需小幅扩展该参数透传 |
| 技能注册 | `main.ts` 中 `skillRegistry.registerBuiltinFromMd(<SKILL.md 导入>, executor)`，现有 7 个内置技能（`src/skills/builtin/*/SKILL.md`），渐进披露（系统提示只放清单，模型用 `read_skill` 拉全文） | 新增 `src/skills/builtin/feedback/`，注册成本很低 |
| 工具注册 | `ToolRegistry.register(tool)`，工具声明 `risk: read/write/plugin-control/network/unknown` | 两个新工具均为 `network` |
| 审批模型 | `needsApproval(risk, settings)` 只对 `write` / `plugin-control` 在 `confirmExecutions` 开时返回 true；**`network` 免批** | 建 issue 是不可撤销的对外公开动作，却不会自动弹审批 → 必须显式补人工确认（FR3.7） |
| 网络通路 | 统一用 Obsidian `requestUrl`（`model-catalog-service`、`video-transcription`、`web-clipper`、`skill-generator` 均如此），无 `fetch` 直连 | GitHub API 走同一条路，不引入新 HTTP 依赖 |
| 会话/多 tab | Workbench = `ShellView`，`TabManager` 管多 tab，每 tab 一个 `conversationId`，会话 JSONL 落 vault（`HarnessSessionManager` + `VaultSessionFileSystem`） | 反馈会话天然与日常对话隔离 |
| 头部入口 | `ShellView.createHeaderActions()` 现只有两个按钮：历史（`search` 图标）、设置（`settings` 图标），用 `createHeaderActionButton(container, label, icon, cls, handler)` 统一构造 | 反馈按钮直接复用该工厂方法 |
| 已有「反馈」 | `MessageRenderer` 在 AI 消息操作栏渲染 👍/👎。👍 → `recordPositiveFeedback` 走 file-back 归档知识库；👎 → 内联输入原因 → `retainLesson` 写长期记忆 + 当场重答。**两者都只作用于插件内部，与 GitHub 无关** | 命名需与本需求区分；👎 是否接入见 Q7 |
| Issue 模板 | `.github/ISSUE_TEMPLATE/bug_report.yml`（`labels: ["bug"]`，必填：what-happened / repro / plugin-version / obsidian-version / platform / provider / surface）、`feature_request.yml`（`labels: ["enhancement"]`，必填：problem / surface）、`config.yml`（安全漏洞指向 Security Advisory，不走公开 issue） | 模板字段即 issue 正文的字段契约 |
| 设置 | `src/mcp/types.ts` 的 `PluginSettings` + `DEFAULT_SETTINGS`；UI 在 `src/settings.ts`，声明式分区（现有 11 个分区，`{ id, title, description, keywords }`） | 新增 `feedback` 分区 |
| 持久化 | `plugin.saveData()` / `loadData()`（`data.json`），provider `apiKey` 即存于此 | Token 与 outbox 走同一机制 |
| 国际化 | `src/i18n/zh.ts` 的 `t()`，`Locale = 'auto' \| 'en' \| 'zh'` | 新增文案需入 i18n |
| 测试 | `test/run-tests.ts` 注册，`npm test`；CI 见 `.github/workflows/ci.yml`；`test/bundle-size.test.ts` 守护 `main.js` < 5 MB | 模板同源校验测试放这里 |

## 来源

- `[desc]` 用户初始描述（`project-description.json`）：「增加一个反馈功能……用户在使用过程中遇到的问题，可以通过**对话**的方式进行反馈；由**智能体**与用户讨论，把问题沟通、澄清清楚；讨论清楚之后，将问题**提交 issue 到 GitHub**。」
- `[scope]` 工作流选定范围：`feature`（新功能，含设计/架构/开发/测试全链路）
- 本仓代码核实：`manifest.json`、`package.json`、`src/services/model-service.ts`（`chat`/`chatStream`/`generate`/`executeSlashSkillCommand`）、`src/runtime/base-chat-runtime.ts`（`prepareTurn` 的 `forcedSkillName`/记忆注入/上下文注入）、`src/runtime/runtime-types.ts`、`src/skills/tool-registry.ts`、`src/skills/types.ts`、`src/skills/builtin/web-search/executor.ts`（网络工具样板）、`src/permissions/permission-service.ts`（`needsApproval`）、`src/ui/shell-view.ts`（`createHeaderActions`）、`src/ui/tabs/*`、`src/ui/renderers/message-renderer.ts`（👍/👎）、`src/ui/chat-controller.ts`（`recordPositiveFeedback`/`recordNegativeFeedback`）、`src/mcp/types.ts`、`src/settings.ts`、`src/i18n/zh.ts`、`.github/ISSUE_TEMPLATE/*.yml`、`.github/workflows/ci.yml`
- 本仓文档：`CLAUDE.md`（架构分层、两条 LLM 路径、移动端约束）、`CONTEXT.md`（Tool/Skill 之分、Conversation/Session、Force-activation、Approval、权限正交性）、`docs/architecture/skills.md`
- 待确认项：`requirements-analysis-questions.md` 的 Q1–Q8（**尚无 `[Answer]:`，需用户拍板**）

## 功能性需求

### FR1：反馈入口

**FR1.1** 在 Workbench（`ShellView`）头部新增一个反馈入口按钮，与现有「历史」「设置」按钮并列，复用 `createHeaderActionButton()` 工厂方法，带 `aria-label` 与 `title`，键盘可达。

**FR1.2** 注册 Obsidian 命令面板命令（`baizer:feedback`），使用户在**任意界面**（笔记编辑中、Guardian 使用中）都能发起反馈，不必先打开 Workbench。

**FR1.3** 触发入口后，新开一个**专用于反馈的 Workbench tab**，并立即激活该 tab。该 tab 在标签栏上有可区分的标识（标题/图标），用户能一眼分辨它不是一个普通对话。

**FR1.4** 反馈 tab 内为一条**完整的对话**：用户可以多轮补充、纠正、追问，智能体的回复照常流式渲染，与普通对话的交互体验一致。

**FR1.5** 反馈 tab 可被关闭（沿用 `TabManager` 既有语义）；关闭前若存在未提交的草稿，按 FR5.6 处理，不得静默丢弃用户已输入的内容。

### FR2：澄清对话

**FR2.1** 反馈会话复用**会话型**链路 `ModelService.chatStream`，`conversationId` 即该 tab 的 id，从而天然复用：多轮历史（`SessionStore`）、流式事件渲染、工具调用时间线、审批卡片、steering、跨重启恢复。

**FR2.2** 反馈会话的**每一轮**都以 `feedback` 技能为强制激活技能（`prepareTurn` 的 `forcedSkillName`），不依赖用户输入 slash 命令。当前 `chatStream`/`chat` 未透出该参数，需要小幅扩展透传（设计阶段定具体形态）。

**FR2.3** 新增内置技能 `src/skills/builtin/feedback/SKILL.md`，并在 `main.ts` 中按现有 7 个内置技能的同一方式注册。该 SKILL.md 承载三件事：澄清话术与提问策略、issue 必填字段清单、正文渲染规则。

**FR2.4** 澄清策略要求：智能体在**最少轮次**内问清「问题类型（缺陷/需求）、现象、期望行为、复现步骤、影响范围（哪个界面/哪个功能）、是否已尝试绕过」，且**能从对话或已有信息推断的不得重复追问**。用户明确说「直接提交」「不用再问了」时，智能体必须立即停止追问，用已有信息生成草稿并进入确认流程。

**FR2.5** 澄清过程中，智能体可调用 `search_github_issues` 检索是否已有相同问题，并据此调整提问（例如「这个看起来和 #112 是同一个问题，你是这个意思吗？」）。

**FR2.6** 澄清过程中智能体可调用只读的诊断信息工具 `get_plugin_diagnostics`（见 FR3.2a）获取环境信息（插件版本、Obsidian 版本、平台、当前 provider 类型、最近一次错误摘要），**但不得主动读取用户笔记内容**（见 FR6）。`feedback` 技能声明的工具子集只含 `search_github_issues` / `create_github_issue` / `get_plugin_diagnostics`（外加始终可用的 `read_skill`），从能力上就没有读取 vault 的路径。

**FR2.7** 反馈会话的上下文隔离：不注入当前笔记与反链等环境上下文（`ambient context`），避免把用户笔记内容无意带进一份将公开的 issue。是否复用长期记忆召回见 Q8。

**FR2.8** 反馈会话产生的对话记录按既有会话持久化机制落 vault，用户重开该 tab 可继续未完成的反馈；但**已提交**的反馈会话应有终态标识，避免用户误以为还能继续改。

### FR3：提交 GitHub Issue

**FR3.1** 新增原子工具 `search_github_issues`（`risk: 'network'`，`executionMode: 'parallel'`），入参至少含关键词/错误签名与是否包含已关闭 issue，返回候选 issue 的编号、标题、状态、链接。

**FR3.2** 新增原子工具 `create_github_issue`（`risk: 'network'`），入参为标题、正文、类型（bug/enhancement）、可选标签，返回新建 issue 的编号与链接。

**FR3.2a** 新增原子工具 `get_plugin_diagnostics`（`risk: 'read'`），返回 FR6.3 定义的诊断信息白名单字段。它是 `feedback` 技能的工具子集中唯一允许接触运行环境的工具，且**只读固定字段**，不接受任意路径/查询参数——从工具签名上就杜绝读到用户笔记的可能。

**FR3.3** 目标仓库默认为本仓 `yinfi/baizer`。是否允许用户在设置页改成自己的 `owner/repo` 见 Q4。

**FR3.4** **模板等价**：由于 REST API 不套用 ISSUE_TEMPLATE，`create_github_issue` 必须由插件把字段渲染成等价的 Markdown 正文。字段结构以本仓 `.github/ISSUE_TEMPLATE/bug_report.yml` 与 `feature_request.yml` 为准：
- 缺陷类正文须覆盖：What happened / Steps to reproduce / Baizer version / Obsidian version / Platform / Provider / Where it happened / Console output（无则显式写「无」）
- 需求类正文须覆盖：The problem / What you have in mind / How you handle it today / Which part of Baizer
- 类型判定（bug vs enhancement）由澄清结果决定，不由用户在 UI 上手选

**FR3.5** **模板同源校验**：新增自动化测试，断言插件本地的字段清单与 `.github/ISSUE_TEMPLATE/*.yml` 的字段集合一致；仓库模板增删字段时该测试必须失败，从而暴露漂移。这是防止「模板改了、插件没跟上」的唯一可靠手段。

**FR3.6** **去重**：`create_github_issue` 执行前必须先经 `search_github_issues` 检索；命中相似 issue 时的具体行为见 Q5。

**FR3.7** **提交前人工确认（必须）**：因为 `needsApproval` 对 `network` 风险免批，建 issue 这个不可撤销的对外公开动作**不会**被现有审批机制拦住。因此 `create_github_issue` 必须自带一次显式人工确认：向用户展示**将要公开的完整标题、正文、类型**，用户明确确认后才发出请求。实现形态（复用现有审批卡片 / 工具内确认 / 专用预览面板）留给设计阶段，但该行为不可省略。

**FR3.8** **幂等**：同一份草稿的重复提交（用户连点、网络重试、outbox 重放）不得产生第二条 issue。需要为每份草稿生成稳定的去重键并在提交前校验。

**FR3.9** 提交成功后，在对话中回显 issue 编号与可点击链接，并将该反馈会话置为终态。

**FR3.10** **标签兜底**：非协作者调用 API 建 issue 时 `labels` 会被静默丢弃（`[assumption]` A3）。因此标题需带类型前缀（`[Bug]` / `[Feature]`）作为不依赖标签权限的分类信号。

**FR3.11** **安全漏洞不走此通道**：对齐 `.github/ISSUE_TEMPLATE/config.yml`，澄清过程中一旦识别为安全漏洞，智能体必须改为引导用户走 `SECURITY.md` / GitHub Security Advisory 私密上报，**不得**通过本功能提交公开 issue。

### FR4：鉴权与配置

**FR4.1** 在 `src/settings.ts` 新增 `feedback` 分区（含 `title`/`description`/`keywords`，与现有 11 个分区同构），承载：功能开关、GitHub Token、目标仓库、连接测试。

**FR4.2** GitHub Token 的存储与处理**与 provider `apiKey` 同等对待**：存于 `data.json`、UI 掩码显示、可清除、**任何日志与错误信息中不得出现明文**、不写入 outbox、不随诊断信息附带。

**FR4.3** 提供「测试连接」动作，验证三件事：Token 有效、目标仓库可达、该仓库 Issues 已开启。失败时必须指出是哪一项失败及原因。

**FR4.4** 功能默认**关闭**。理由：本功能需要用户提供 GitHub 凭据（或在无凭据模式下改变提交路径），且会产生对外的公开内容，静默启用不符合「对外动作先确认」的原则。用户需在设置页显式开启。

**FR4.5** 鉴权方式的具体形态（用户自建 fine-grained PAT / classic PAT / OAuth Device Flow / 完全不要 Token 只做浏览器预填）见 Q2。

### FR5：失败与降级

降级分两层，因为「澄清对话」与「提交 issue」是两个可独立失效的依赖。

**FR5.1（L1：LLM 可用，GitHub 不可用）** 澄清对话照常走完，草稿生成后不自动提交，转为：
- 提供「复制到剪贴板」（生成完整 Markdown 正文）
- 提供「在浏览器中打开预填的 Issue 页面」（`https://github.com/<owner>/<repo>/issues/new?title=...&body=...`）
两条路径都保留用户手动完成提交的能力。

**FR5.2（L2：LLM 不可用）** 此时对话式澄清无法进行。是否提供一个**静态表单 Modal**（直接填标题/描述/复现步骤，跳过智能体澄清）作为兜底，使离线用户至少能留下反馈——见 Q3。若不采纳，必须给出明确的用户可见提示，说明当前不可用及原因，而不是一个卡住不动的输入框。

**FR5.3（网络失败/离线）** 草稿落本地 outbox 持久化（`plugin.saveData`），提示「已暂存，联网后可重试」，并提供手动重试入口；不得静默失败。outbox 需有容量上限与过期策略（见 FR5.6）。

**FR5.4（限流）** GitHub API 返回 403/429 且带 `Retry-After` 时，按该值退避重试，重试次数有上限；超限转为暂存并明确告知用户「已被限流，稍后重试」。**不得**无限重试。

**FR5.5（错误分类）** 不同失败必须给出不同的、可操作的提示：
- `401` → Token 无效或已过期，指引到设置页重新填写
- `403` → Token 权限不足（缺少 Issues 写权限），说明需要的最小权限
- `404` → 仓库不存在／是私有的／Issues 已关闭
- `422` → 提交内容被仓库规则拒绝（例如必填字段校验），回显仓库的具体报错
- 网络层异常（超时、DNS、TLS）→ 归入 FR5.3 的离线降级

**FR5.6（outbox 生命周期）** 暂存的草稿需在插件重启后仍可读取并重试；用户可查看、重试、删除暂存草稿；需设容量上限（超出时提示用户清理而非静默丢弃最旧的）；草稿含用户输入内容，删除后不得残留。

**FR5.7（关闭未提交会话）** 用户关闭带有未提交草稿的反馈 tab 时，必须保留草稿（落 outbox 或保留会话）而非静默丢弃；用户重新进入时能看到并继续。

### FR6：隐私与安全

**FR6.1（提交前预览）** 提交前用户必须能看到**将要公开的全部内容**（标题 + 正文全文 + 类型），这是 FR3.7 人工确认的实质内容，不是走形式的勾选框。

**FR6.2（公开可见警告）** 明确告知用户：内容将提交到**公开仓库**，任何人都能看到，并会显示其 GitHub 用户名。用户在设置页填入的 Token 属于敏感凭据，此警告需在首次提交时出现。

**FR6.3（不主动采集 vault 内容）** 诊断信息只包含固定字段：插件版本、Obsidian 版本、操作系统/平台、当前 provider 类型、最近一次错误摘要。**不含**笔记内容、文件路径、vault 名称、API Key、对话历史全文。

**FR6.4（privacyMode 联动）** 当设置中 `privacyMode` 为开启时，禁止自动附带任何 vault 相关上下文；`feedback` 技能必须在提示词层面被告知不得把笔记/记忆内容写进 issue 正文，除非用户在本轮明确要求。

**FR6.5（不信任外部输入）** 从 GitHub 返回的内容（已有 issue 标题/正文、API 错误信息）在渲染进对话时按不可信内容处理，不得被当作指令执行（对齐 `corner-checklist.md` 的「AI and agent output → Untrusted content steering the model」）。

**FR6.6（用户输入的健壮性）** 用户可能在反馈里粘贴极长文本、含 Markdown/HTML/控制字符的内容。这些内容在渲染为 issue 正文时必须保持原样且不破坏布局，不因特殊字符截断或损坏。

## 非功能性需求

**NFR1（移动端兼容）** 全部改动必须同时运行于桌面端与移动端（`manifest.json` `isDesktopOnly: false`）。不得引入 `child_process` 等 Node-only API。特别地：Token 存储不得依赖桌面端专属的密钥链。

**NFR2（包体）** `main.js` 产出仍须小于 5 MB，由现有 `test/bundle-size.test.ts` 继续守护。不引入新的 HTTP/GraphQL 客户端依赖——GitHub 交互用 `requestUrl` 手写最小请求。

**NFR3（可测试性）** 两个新工具须可脱离 Obsidian 运行时单测：沿用现有 `web-search`/`web-clipper` 的 `deps` 注入模式（`requestUrl`/`wait` 可替换）。需要覆盖：模板渲染（含字段缺失、超长文本、特殊字符）、去重检索、错误分类映射、幂等键、outbox 读写与上限、模板同源校验（FR3.5）。

**NFR4（国际化）** 全部新增用户可见文案走 `t()` 并补 `zh`/`en` 两份，不硬编码中文字符串。

**NFR5（可访问性）** 新增的头部按钮、确认面板、表单必须键盘可达、带 `aria-label`，状态不只靠颜色表达（对齐现有 `createHeaderActionButton` 的做法）。

**NFR6（不拖慢既有链路）** 新增技能与工具不得增加常规对话的每轮提示词体积：`feedback` 技能靠渐进披露（系统提示只增一行清单），两个新工具仅注册不注入系统提示。不得使 Guardian 快/深路径或普通对话的首 token 延迟产生可感知退化。

**NFR7（密钥安全）** 禁止硬编码任何密钥、Token、仓库凭据。Token 只从设置读取，错误路径不得回显明文。

## 约束

- **无后端**：不得为 GitHub 交互引入服务端代理或中转服务，全部请求从插件客户端直发。
- **复用既有网络通路**：只用 Obsidian `requestUrl`，与 `model-catalog-service`/`video-transcription`/`web-clipper` 保持一致。
- **复用既有权限与审批模型**：新工具声明 `risk`，不改动 `needsApproval` 的既有语义（不为了本需求把 `network` 改成需批，否则会波及其他网络工具）。
- **复用既有会话机制**：不新建独立的消息存储或流式渲染实现。
- **技能与工具的分工**：`feedback` 是 Skill（只提供行为指令），`search_github_issues`/`create_github_issue` 是 Tool（真正执行）。不得把网络调用写进 SKILL.md 或让技能直接执行任何动作。
- **模板字段契约来自仓库文件**：`.github/ISSUE_TEMPLATE/*.yml` 是唯一事实来源，插件侧字段清单必须与其同源可校验。

## 假设

- **[assumption]** A1：GitHub REST API `POST /repos/{owner}/{repo}/issues` **不会**套用仓库的 ISSUE_TEMPLATE（模板是 Web 表单特性，`?template=` 仅浏览器生效）。这决定了 FR3.4 必须由插件本地渲染正文。**验证方式**：实现阶段建一条测试 issue，比对正文结构。**归属**：开发阶段。
- **[assumption]** A2：目标仓库 `yinfi/baizer` 的 Issues 保持开启，且未设置禁止非协作者建 issue 的规则。若不成立，FR5.5 的 404/403 分支即为用户实际路径，需在设置页「测试连接」中提前暴露。**归属**：开发阶段。
- **[assumption]** A3：非协作者调用 API 建 issue 时传入的 `labels` 会被**静默丢弃**（GitHub 文档：仅具 push 权限者可设置标签）。这决定了 FR3.10 的标题前缀兜底。**验证方式**：用非协作者 Token 建一条 issue，检查标签是否生效。**归属**：开发阶段。
- **[assumption]** A4：用户在公开仓库建 issue 时会公开自己的 GitHub 用户名。这是 FR6.2 警告文案的事实基础，属于平台固有行为而非本功能引入，但必须在提交前告知。
- **[assumption]** A5：本阶段只确定「模板字段必须等价」这一行为要求，正文的具体措辞、字段顺序、模板版本如何随仓库演进，留给 Functional Design 阶段设计；本阶段不预设实现细节。
- **[assumption]** A6：`chatStream` 透出 `forcedSkillName` 的具体形态（新增可选参数 / 新增 `GenerationSource` 取值 / 其他）留给设计阶段决定；本阶段只要求「反馈会话每轮都强制激活 `feedback` 技能」这一行为。

## 范围外

- **不做崩溃自动上报（telemetry / 无感上报）**：本功能的每一次提交都由用户主动发起并确认，不存在后台自动提交路径。
- **不做反馈的统计分析、看板、趋势**。
- **不做 issue 状态回写**：不把 GitHub 上 issue 的进展同步回插件、不做插件内 issue 列表、不做 issue 评论的双向同步。
- **不做多仓库路由**：不按问题类型自动分发到不同仓库（是否可配置单一目标仓库见 Q4）。
- **不替换或改造既有的 👍/👎**：现有 `recordPositiveFeedback`（file-back 归档）与 `recordNegativeFeedback`（写记忆 + 当场重答）语义保持不变；是否**额外**接入反馈流程见 Q7。
- **不把反馈提交到 Multica 或其他平台**：目标通道只有 GitHub。
- **不做安全漏洞的公开上报路径**：按 FR3.11 引导至私密通道。
- **不包含 GitHub OAuth App 的注册与维护**：是否采用 Device Flow 见 Q2；若采纳，OAuth App 的注册归属需在设置阶段一并确认。

## 开放问题

- **[Q2 衍生]** 若采纳 OAuth Device Flow，需额外确认：由谁注册并持有该 OAuth App 的 `client_id`、用户撤销授权后的行为、以及 Token 过期/刷新的处理。
- **[Q3 衍生]** 若采纳静态表单兜底，表单字段与模板字段的对应关系需在 Functional Design 阶段与 FR3.4 的渲染规则统一设计，避免出现两套字段定义。
- **[Q5 衍生]** 若采纳「追加评论到已有 issue」，该动作同样是不可撤销的对外公开写操作，必须与 FR3.7 一样经过人工确认。
- **[Q6 衍生]** 诊断信息「最近一次错误摘要」的来源与截断策略需要在设计阶段明确——错误信息可能包含文件路径，与 FR6.3 存在张力。
- **[Q8 衍生]** 若反馈会话复用长期记忆召回，记忆内容进入提示词后可能被模型写入公开 issue，与 FR6.4 存在张力；需在设计中给出约束手段。

## 需求追溯矩阵

| Req ID | 摘要 | 优先级 | 状态 | Design Ref | Unit Ref | Test Ref |
|--------|------|--------|------|------------|----------|----------|
| FR1.1 | ShellView 头部反馈入口 | Must | 待评审 | — | — | — |
| FR1.2 | 命令面板命令 `baizer:feedback` | Must | 待评审 | — | — | — |
| FR1.3 | 专用反馈 tab | Must | 待评审 | — | — | — |
| FR1.4 | 反馈 tab 内多轮对话 | Must | 待评审 | — | — | — |
| FR1.5 | 关闭 tab 不丢草稿 | Must | 待评审 | — | — | — |
| FR2.1 | 复用 `chatStream` 会话型链路 | Must | 待评审 | — | — | — |
| FR2.2 | 每轮强制激活 `feedback` 技能 | Must | 待评审 | — | — | — |
| FR2.3 | 新增内置技能 `feedback` | Must | 待评审 | — | — | — |
| FR2.4 | 最少轮次澄清 + 可跳过追问 | Must | 待评审 | — | — | — |
| FR2.5 | 澄清中检索已有 issue | Should | 待评审 | — | — | — |
| FR2.6 | 只读诊断信息工具 | Should | 待评审 | — | — | — |
| FR2.7 | 不注入环境上下文 | Must | 待评审 | — | — | — |
| FR2.8 | 会话持久化 + 终态标识 | Should | 待评审 | — | — | — |
| FR3.1 | 工具 `search_github_issues` | Must | 待评审 | — | — | — |
| FR3.2 | 工具 `create_github_issue` | Must | 待评审 | — | — | — |
| FR3.2a | 工具 `get_plugin_diagnostics`（只读白名单） | Must | 待评审 | — | — | — |
| FR3.3 | 默认目标仓库 `yinfi/baizer` | Must | 待评审 | — | — | — |
| FR3.4 | 模板字段等价的正文渲染 | Must | 待评审 | — | — | — |
| FR3.5 | 模板同源校验测试 | Must | 待评审 | — | — | — |
| FR3.6 | 提交前去重检索 | Must | 待评审 | — | — | — |
| FR3.7 | 提交前人工确认（不可省） | Must | 待评审 | — | — | — |
| FR3.8 | 提交幂等 | Must | 待评审 | — | — | — |
| FR3.9 | 成功回显编号与链接 | Must | 待评审 | — | — | — |
| FR3.10 | 标题类型前缀兜底 | Should | 待评审 | — | — | — |
| FR3.11 | 安全漏洞改走私密通道 | Must | 待评审 | — | — | — |
| FR4.1 | 设置页 `feedback` 分区 | Must | 待评审 | — | — | — |
| FR4.2 | Token 与 apiKey 同等保密待遇 | Must | 待评审 | — | — | — |
| FR4.3 | 「测试连接」动作 | Should | 待评审 | — | — | — |
| FR4.4 | 功能默认关闭 | Must | 待评审 | — | — | — |
| FR4.5 | 鉴权方式选定 | Must | **待用户拍板（Q2）** | — | — | — |
| FR5.1 | L1 降级：草稿 + 浏览器预填 | Must | 待评审 | — | — | — |
| FR5.2 | L2 降级：LLM 不可用时的行为 | Must | **待用户拍板（Q3）** | — | — | — |
| FR5.3 | outbox 暂存 + 重试 | Must | 待评审 | — | — | — |
| FR5.4 | 限流退避（有上限） | Must | 待评审 | — | — | — |
| FR5.5 | 错误分类提示 | Must | 待评审 | — | — | — |
| FR5.6 | outbox 生命周期管理 | Should | 待评审 | — | — | — |
| FR5.7 | 关闭会话保留草稿 | Must | 待评审 | — | — | — |
| FR6.1 | 提交前全文预览 | Must | 待评审 | — | — | — |
| FR6.2 | 公开可见警告 | Must | 待评审 | — | — | — |
| FR6.3 | 诊断信息字段白名单 | Must | 待评审 | — | — | — |
| FR6.4 | privacyMode 联动 | Must | 待评审 | — | — | — |
| FR6.5 | 外部内容按不可信处理 | Must | 待评审 | — | — | — |
| FR6.6 | 特殊字符/超长文本健壮性 | Should | 待评审 | — | — | — |
| NFR1 | 移动端兼容 | Must | 待评审 | — | — | — |
| NFR2 | 包体 < 5 MB | Must | 待评审 | — | — | — |
| NFR3 | 工具可单测（deps 注入） | Must | 待评审 | — | — | — |
| NFR4 | 国际化 | Must | 待评审 | — | — | — |
| NFR5 | 可访问性 | Should | 待评审 | — | — | — |
| NFR6 | 不拖慢既有链路 | Must | 待评审 | — | — | — |
| NFR7 | 无硬编码密钥 | Must | 待评审 | — | — | — |

> Design Ref / Unit Ref / Test Ref 留空是有意的：本阶段只产出需求，列留空即代表「尚未设计／尚未分配／尚未覆盖」的缺口，由后续阶段逐格填上。
