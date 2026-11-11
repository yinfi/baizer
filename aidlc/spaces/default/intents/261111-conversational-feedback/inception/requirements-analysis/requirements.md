# 需求分析 —— 对话式反馈：与智能体澄清后提交 GitHub Issue

> **状态：已定稿**（2026-11-11，Q2 由 D 改为 B 后重新定稿）。
> Q1–Q8 的作答与两次变更留痕见 `requirements-analysis-questions.md`。
> 本文按 Q2=B（token 由发布方在构建期注入插件，用户零配置，接受 token 随发行包公开）整体重写，
> 上一版「Q2=D 零凭据」的推导已全部回滚。

## 意图分析

**用户想达成什么**：把「用户遇到问题 → 自己组织语言 → 自己判断该报给谁 → 自己去 GitHub 建 issue」这条目前完全在插件之外、且大多数用户不会走完的链路，收敛成插件内的一次对话。用户只需要用自己的话把遇到的问题讲出来，智能体负责把它问清楚、补成一份结构完整的 issue，并在用户确认后由插件**直接提交**到 GitHub。

要解决的不是「缺一个反馈按钮」，而是**反馈的漏斗损耗**：用户愿意反馈但懒得写清复现步骤、不知道该报给哪个仓库、不确定是不是已知问题，最终选择沉默。因此本需求的价值判据是**反馈的完成率**，而不是入口的数量。

**关键结论（Q2=B 定下的根本形态）**：

> **插件内置一个发布方持有的 GitHub token，用户在插件里不做任何凭据配置，插件直接把 issue 提交到 `yinfi/baizer`。**
> 代价是：token 随每个发行包分发给所有用户，等于公开；所有 issue 都会以发布方账号发出；
> 一旦被滥用，止损要等一轮「轮换 + 重新构建 + 用户升级」，没有即时开关。**用户已知悉并接受这三条代价。**

由此产生三条必须显式承接的后果，构成本次新增需求的来源：

1. **凭据注入契约**：token 从哪来、怎么进 bundle、怎么不进 git、怎么轮换 → `FR4.2` / `FR4.6` / `FR4.7` / `NFR7`
2. **自读风险**：token 在 bundle 里，于是「让模型读到 bundle」等价于「泄漏 token」→ `FR6.7`
3. **审批约束**：建 issue 不可撤销且对外公开，而 `needsApproval()` 对 `network` 免批 → `FR3.7`

**其余四项已定死的结论**：

1. **入口**（Q1=A）：Workbench（`ShellView`）头部新增反馈图标按钮 + 命令面板命令，点击**新开一个专用反馈 tab**。不复用普通对话 tab（会污染用户正在进行的对话），也不另造独立弹窗（要重造流式渲染/工具时间线/审批卡片，违反 DRY）。
2. **模型链路**：复用**会话型** `ModelService.chatStream` → pi `agentLoop`（`conversationId` = 该 tab id），通过新增内置技能 `feedback` 做强制激活。
3. **上下文隔离**（Q8=A）：反馈会话是干净会话，不注入长期记忆召回，也不注入当前笔记/反链等环境上下文。
4. **LLM 不可用**（Q3=A）：不做表单兜底，只给明确提示。

## 现有形态盘点（本需求的落地依据）

以下均为本次 `multica repo checkout` 后逐文件核实的现状，不是假设。

| 面 | 现状 | 对本需求的意义 |
|---|---|---|
| 插件形态 | Obsidian 插件 `baizer` v1.7.2，`manifest.json` `isDesktopOnly: false` | 全部改动必须移动端可用，禁 `child_process` |
| 模型链路 | 唯一入口 `ModelService`。两条路径：会话型 `chat`/`chatStream` → pi `agentLoop`（带工具/历史/审批/steering）；无状态 `generate` → pi `completeSimple` | 澄清对话走前者 |
| 强制激活技能 | `BaseChatRuntime.prepareTurn` 接受 `forcedSkillName`；`ModelService.executeSlashSkillCommand` 已用此参数。`chatStream` 当前**未透出**该参数 | 反馈会话需要把 `feedback` 技能钉在整段会话上，需小幅扩展该参数透传 |
| 记忆注入 | `BaseChatRuntime.prepareTurn` 在 `memoryManager` 存在时**无条件**注入 `recallForPrompt` 召回结果与 Mental Model 块 | Q8=A 要求反馈会话跳过这两项，需新增一条「跳过记忆注入」通路 |
| 技能注册 | `main.ts` 中 `skillRegistry.registerBuiltinFromMd(<SKILL.md 导入>, executor)`，现有 7 个内置技能，渐进披露（系统提示只放清单，模型用 `read_skill` 拉全文） | 新增 `src/skills/builtin/feedback/`，注册成本很低 |
| 工具注册 | `ToolRegistry.register(tool)`，工具声明 `risk: read/write/plugin-control/network/unknown` | 新工具按各自风险声明 |
| `risk` 的实际消费方 | 只有两处：`permission-service.ts:109` 的 `needsApproval()`（`write`/`plugin-control` 在 `confirmExecutions` 开时需批）；`pi-tool-adapter.ts:24`（`write`/`plugin-control` → **强制 sequential 执行**） | 声明 `risk: 'write'` 可同时拿到「审批卡片」与「串行执行」两个既有机制 |
| 审批机制 | 工具返回 `buildApprovalResponse(...)` → 审批卡片 → 用户确认 → `executeApprovedAction` 走 `requestId` 登记的 in-flight 去重与重试（`approval-execution.ts`） | FR3.7 复用这一整套，不另造确认 UI |
| 网络通路 | 统一用 Obsidian `requestUrl`（`model-catalog-service`、`video-transcription`、`web-clipper`、`skill-generator` 均如此），无 `fetch` 直连；`model-catalog-service` 已有「超时 + 取消」包装的 `requestUrl` 变体可参考 | GitHub API 走同一条路，不引入新 HTTP 依赖 |
| 会话/多 tab | Workbench = `ShellView`，`TabManager` 管多 tab，每 tab 一个 `conversationId`，会话 JSONL 落 vault | 反馈会话天然与日常对话隔离 |
| 头部入口 | `ShellView.createHeaderActions()` 现只有两个按钮：历史（`search` 图标）、设置（`settings` 图标），用 `createHeaderActionButton()` 统一构造 | 反馈按钮直接复用该工厂方法 |
| 已有「反馈」 | `MessageRenderer` 的 👍/👎 只作用于插件内部（归档知识库 / 写长期记忆 + 当场重答），与 GitHub 无关 | Q7=B：保持现状，本需求不碰这两条链路 |
| Issue 模板 | `.github/ISSUE_TEMPLATE/bug_report.yml`（`labels: ["bug"]`）、`feature_request.yml`（`labels: ["enhancement"]`）、`config.yml`（安全漏洞指向 Security Advisory） | 模板字段即 issue 正文的字段契约 |
| 构建 | `esbuild.config.mjs` 输出 `dist/main.js`（单文件）；已有环境变量先例 `process.env.BAIZER_METAFILE`（`:603`）；`bundle-size` 硬限 5 MB | 凭据注入走 `define`，需确认不破坏体积守卫 |
| 发布 | `.github/workflows/release.yml`：tag 触发 → `npm ci` → `npm run build` → `npm test` → eslint → 校验 tag 与 `manifest.json` 版本一致 → `softprops/action-gh-release` 发布 `dist/main.js` + `manifest.json` + `styles.css`。**当前无任何 `secrets` 引用** | 凭据注入需在此接线 repo secret，并新增 preflight 校验 |
| `.gitignore` | 含 `main.js`、`dist/`、`node_modules/`；**未见 `.env`** | 需补 `.env`（FR4.2） |
| 设置 | `src/mcp/types.ts` 的 `PluginSettings` + `DEFAULT_SETTINGS`；UI 在 `src/settings.ts`，声明式分区（现有 11 个） | 新增 `feedback` 分区 |
| 持久化 | `plugin.saveData()` / `loadData()`（`data.json`） | 草稿与重试队列走同一机制 |
| 国际化 | `src/i18n/zh.ts` 的 `t()`，`Locale = 'auto' \| 'en' \| 'zh'` | 新增文案需入 i18n |
| 测试 | `test/run-tests.ts` 注册，`npm test`；`test/bundle-size.test.ts` 守护体积 | 模板同源校验、读隔离、错误分类等测试放这里 |

## 来源

- `[desc]` 用户初始描述（`project-description.json`）：「增加一个反馈功能……用户在使用过程中遇到的问题，可以通过**对话**的方式进行反馈；由**智能体**与用户讨论，把问题沟通、澄清清楚；讨论清楚之后，将问题**提交 issue 到 GitHub**。」
- `[scope]` 工作流选定范围：`feature`（新功能，含设计/架构/开发/测试全链路）
- `[Q1]`–`[Q8]` 作答（见 `requirements-analysis-questions.md`）：Q1=A、**Q2=B**、Q3=A、Q4=A、Q5=A、Q6=A、Q7=B、Q8=A
- `[Q2-rev1]` 第一次变更：Q2 由 D 改为「需要 Token」，用户明确「如果没有 token，整个功能就失效，不能使用就行」→ 上一版的零凭据推导全部作废
- `[Q2-rev2]` 第二次变更：用户提出「用我自己的 git 账号 token 写到代码逻辑里面来提交，不让用户填权限」，并追问「能否通过非对称方式实现对 token 的加密」。经确认非对称加密在本场景不成立（插件必须在用户机器上持有明文 token 才能发请求；私钥随包分发等于没加密，私钥留在服务端则等于中转服务），用户在 A（中转服务）/ B（token 进插件）/ C（Device Flow）三项中选定 **B**
- 本仓代码核实：见上表所列各文件与行号
- 本仓文档：`CLAUDE.md`、`CONTEXT.md`（Tool/Skill 之分、Force-activation、Approval、权限正交性）、`docs/architecture/skills.md`、`docs/architecture/permissions.md`

## 功能性需求

### FR1：反馈入口（Q1=A）

**FR1.1** 在 Workbench（`ShellView`）头部新增一个反馈入口按钮，与现有「历史」「设置」按钮并列，复用 `createHeaderActionButton()` 工厂方法，带 `aria-label` 与 `title`，键盘可达。

**FR1.2** 注册 Obsidian 命令面板命令（`baizer:feedback`），使用户在**任意界面**（笔记编辑中、Guardian 使用中）都能发起反馈，不必先打开 Workbench。

**FR1.3** 触发入口后，新开一个**专用于反馈的 Workbench tab**，并立即激活该 tab。该 tab 在标签栏上有可区分的标识（标题/图标），用户能一眼分辨它不是一个普通对话。

**FR1.4** 反馈 tab 内为一条**完整的对话**：用户可以多轮补充、纠正、追问，智能体的回复照常流式渲染，与普通对话的交互体验一致。

**FR1.5** 反馈 tab 可被关闭（沿用 `TabManager` 既有语义）；关闭前若存在未提交的草稿，按 FR5.7 处理，不得静默丢弃用户已输入的内容。

### FR2：澄清对话

**FR2.1** 反馈会话复用**会话型**链路 `ModelService.chatStream`，`conversationId` 即该 tab 的 id，从而天然复用：多轮历史（`SessionStore`）、流式事件渲染、工具调用时间线、审批卡片、steering、跨重启恢复。

**FR2.2** 反馈会话的**每一轮**都以 `feedback` 技能为强制激活技能（`prepareTurn` 的 `forcedSkillName`），不依赖用户输入 slash 命令。当前 `chatStream`/`chat` 未透出该参数，需要小幅扩展透传（形态由设计阶段决定）。

**FR2.3** 新增内置技能 `src/skills/builtin/feedback/SKILL.md`，并在 `main.ts` 中按现有 7 个内置技能的同一方式注册。该 SKILL.md 承载三件事：澄清话术与提问策略、issue 必填字段清单、正文渲染规则。

**FR2.4** 澄清策略要求：智能体在**最少轮次**内问清「问题类型（缺陷/需求）、现象、期望行为、复现步骤、影响范围（哪个界面/哪个功能）、是否已尝试绕过」，且**能从对话或已有信息推断的不得重复追问**。用户明确说「直接提交」「不用再问了」时，智能体必须立即停止追问，用已有信息生成草稿并进入确认流程。

**FR2.5** 澄清过程中，智能体可调用 `search_github_issues`（见 FR3.1）检查是否已有相同问题，并据此调整提问（例如「这个看起来和 #112 是同一个问题，你是这个意思吗？」）。

**FR2.6** `feedback` 技能声明的工具子集为：`search_github_issues` / `get_plugin_diagnostics` / `create_github_issue` / `add_issue_comment`（外加始终可用的 `read_skill`）。**刻意不包含任何 vault 读工具**——从能力上就没有读取用户笔记的路径。

**FR2.7（Q8=A）** 反馈会话是**干净会话**，必须同时隔离两类上下文注入：
- **环境上下文**：不注入当前笔记、反链等 ambient context
- **长期记忆**：不注入 `recallForPrompt` 召回结果与 Mental Model 块

理由：反馈正文会在公开仓库发布，用户个人偏好/笔记内容的任何泄漏都不可逆；隔离比事后过滤可靠。当前 `prepareTurn` 在 `memoryManager` 存在时无条件注入这两项，因此需要一条明确的「跳过记忆注入」通路（形态由设计阶段决定）。**该通路必须是反馈会话专属开关，不得改动普通对话的记忆行为。**

**FR2.8** 反馈会话产生的对话记录按既有会话持久化机制落 vault，用户重开该 tab 可继续未完成的反馈；已提交的反馈会话应有终态标识。

### FR3：提交 GitHub Issue

**FR3.1** 新增原子工具 `search_github_issues`（`risk: 'network'`，`executionMode: 'parallel'`）。调用 GitHub 搜索接口（`GET /search/issues?q=repo:yinfi/baizer is:issue ...`），入参为关键词/错误签名与是否包含已关闭 issue，返回候选 issue 的编号、标题、状态、链接。请求携带内置 token，因此享有鉴权配额（远高于未鉴权的分钟级限制）。

**FR3.2** 新增原子工具 `create_github_issue`（**`risk: 'write'`**）。入参为标题、正文、类型（bug/enhancement），返回新建 issue 的编号与链接。**它是真实的 GitHub API 写入**（`POST /repos/yinfi/baizer/issues`）。

> **为什么是 `risk: 'write'` 而不是 `'network'`**：`risk` 在本仓只有两处消费方——`needsApproval()` 与 `pi-tool-adapter.ts:24` 的执行模式判定。声明 `write` 可同时拿到「审批卡片」与「强制 sequential 执行」（后者防止并发提交产生重复 issue），两者都是本工具需要的。工具**不调用**任何 vault 写入权限检查（`checkWriteScope`/`checkFileCapability`），因此不会误触发 vault 权限语义。

**FR3.2a** 新增原子工具 `get_plugin_diagnostics`（`risk: 'read'`），返回 FR6.3 定义的诊断信息白名单字段。它是 `feedback` 技能工具子集中唯一接触运行环境的工具，且**只读固定字段**，不接受任意路径/查询参数——从工具签名上就杜绝读到用户笔记的可能。

**FR3.2b** 新增原子工具 `add_issue_comment`（**`risk: 'write'`**）。入参为 issue 编号与评论正文，用于 FR3.6 的「追加评论到已有 issue」分支（Q5=A）。与 `create_github_issue` 同样经过 FR3.7 的显式确认——追加评论同样是不可撤销的对外公开写操作。

**FR3.3（Q4=A）** 目标仓库**硬编码为 `yinfi/baizer`**，不提供任何配置项。设置页只展示该地址（只读），让用户知道反馈会去向何处。

**FR3.4（模板等价）** GitHub 的 ISSUE_TEMPLATE 只作用于 Web 表单，**REST API 建 issue 不会自动套用模板**。因此 `create_github_issue` 必须由插件把字段渲染成等价的 Markdown 正文，字段结构以本仓模板为准：
- 缺陷类正文须覆盖：What happened / Steps to reproduce / Baizer version / Obsidian version / Platform / Provider / Where it happened / Console output（无则显式写「无」）
- 需求类正文须覆盖：The problem / What you have in mind / How you handle it today / Which part of Baizer
- 类型判定（bug vs enhancement）由澄清结果决定，不由用户在 UI 上手选

**FR3.5（模板同源校验）** 新增自动化测试，断言插件本地的字段清单与 `.github/ISSUE_TEMPLATE/*.yml` 的字段集合一致；仓库模板增删字段时该测试必须失败，从而暴露漂移。这是防止「模板改了、插件没跟上」的唯一可靠手段。

**FR3.6（去重，Q5=A）** 生成草稿前必须先经 `search_github_issues` 检索；命中相似 issue 时**展示候选列表**，让用户选择：
- **追加评论到已有 issue** → 智能体生成评论草稿（措辞从「新问题」调整为「补充信息」），经 FR3.7 确认后由 `add_issue_comment` 提交
- **仍然新建** → 走 FR3.2

智能体不替用户判断是不是同一个问题。

**FR3.7（提交前显式确认 —— Q2=B 的硬约束）** 建 issue 与追加评论都是**不可撤销的对外公开写操作**，而 `needsApproval()` 对 `network` 免批、对 `write` 的判定又受 `confirmExecutions` 开关影响。因此要求：

- `create_github_issue` 与 `add_issue_comment` 在未获用户确认时**必须**返回 `buildApprovalResponse(...)`，向用户展示**将公开的完整标题与正文（或完整评论正文）**，复用现有审批卡片与 `executeApprovedAction` 的 `requestId` 去重机制。
- **该确认不受 `confirmExecutions` 设置关闭的影响**，即无条件走审批路径。理由：`confirmExecutions` 的语义是「是否要拦下会改动你 vault 的写入」，而本动作的后果是**在公开仓库留下不可撤销的公开记录**，性质不同——用户的既有设置不构成对这一动作的授权。
- 这是一处**有意偏离** `needsApproval()` 默认语义的设计，需在设计阶段确认它只作用于这两个工具，不波及其他工具。
- 审批卡片上需明确告知：内容将公开、将以发布方账号发出、创建后无法由插件撤回。

**FR3.8（幂等）** 同一份草稿的重复提交（用户连点、网络重试、队列重放）不得产生第二条 issue。需要为每份草稿生成稳定的去重键并在提交前校验；`executeApprovedAction` 的 `requestId` 登记表已提供一层 in-flight 去重，草稿去重键是第二层（覆盖跨会话重放）。

**FR3.9** 提交成功后，在对话中回显 issue 编号与可点击链接，并将该反馈会话置为终态。

**FR3.10（标签兜底）** 非协作者创建 issue 时 `labels` 会被静默丢弃（`[assumption]` A3）。本功能以发布方 token 提交，**若该 token 属于仓库协作者则标签正常生效**；但仍需按 A3 的实测结论决定是否保留标题类型前缀（`[Bug]` / `[Feature]`）作为不依赖标签的兜底分类信号。

**FR3.11（安全漏洞不走此通道）** 对齐 `.github/ISSUE_TEMPLATE/config.yml`，澄清过程中一旦识别为安全漏洞，智能体必须改为引导用户走 `SECURITY.md` / GitHub Security Advisory 私密上报，**不得**通过本功能提交公开 issue。

### FR4：凭据与配置

**FR4.1** 在 `src/settings.ts` 新增 `feedback` 分区（含 `title`/`description`/`keywords`，与现有 11 个分区同构），承载：
- 功能开关（FR4.4）
- 目标仓库地址的**只读展示**（`https://github.com/yinfi/baizer`）
- 凭据状态的**只读展示**（「已内置」/「未配置」——**不显示 token 内容、不提供输入框**）
- 「测试连接」动作（FR4.3）

**FR4.2（凭据注入契约）**

- token **只能**经构建期环境变量注入（`BAIZER_FEEDBACK_TOKEN`），由 `esbuild.config.mjs` 的 `define` 把它变成 bundle 内的常量。构建脚本已有环境变量先例：`process.env.BAIZER_METAFILE`（`esbuild.config.mjs:603`）。
- **绝不进 git 源码**：仓库中不得出现 token 字面量、不得出现在任何提交历史中。
- **`.gitignore` 必须补 `.env`**（当前未见该项），本地开发凭据走 `.env`。
- **CI 接线**：`release.yml` 的 Build 步骤需 `env: BAIZER_FEEDBACK_TOKEN: ${{ secrets.BAIZER_FEEDBACK_TOKEN }}`。该 workflow 当前**无任何 secrets 引用**，需一并接入。
- **缺失时的行为必须明确、且不得静默**：
  - 发布路径：`release.yml` 新增 preflight 步骤，secret 为空时**构建失败**，不得静默发布一个反馈功能不可用的版本
  - 本地路径：`npm run build` 允许通过（不阻塞贡献者），但构建输出必须给出明确警告
  - 运行时：token 为空时反馈功能给出「未配置」的明确提示，不呈现一个必然失败的表单
- **token 绝不进入日志、错误信息、诊断信息、草稿内容或任何用户可见输出**（见 FR6.8）。

**FR4.3（测试连接）** 提供「测试连接」动作，验证三件事：内置 token 有效、目标仓库可达、该仓库 Issues 已开启。失败时必须指出是哪一项失败及原因（401 / 403 / 404 / 网络）。测试结果中**不得回显 token**。

**FR4.4（Q2=B 推导，可否决）** 功能**默认开启**。理由：用户零配置（不需要填任何凭据），且 FR3.7 的显式确认已在每次对外写入前拦住用户——不存在「静默对外发帖」的风险。默认开启才能解决本需求要处理的发现性问题。原「默认关闭」的理由（需要用户提供凭据）在 Q2=B 下不成立。**此项为推导结论，用户可否决改回默认关闭。**

**FR4.5（已定稿，Q2=B）** 凭据形态：**发布方持有的 fine-grained PAT，仅授权 `yinfi/baizer`、仅勾 `Issues: write`**，由构建期注入插件，用户在插件内零配置。接受 token 随发行包公开。

**FR4.6（凭据轮换流程）** 必须定义一条可执行的轮换 runbook，覆盖「怀疑泄漏」与「定期主动轮换」两种触发：

1. 在 GitHub 撤销旧 PAT，签发新 PAT（fine-grained、仅 `yinfi/baizer`、仅 `Issues: write`）
2. 更新 repo secret `BAIZER_FEEDBACK_TOKEN`
3. bump 版本号，重新构建并发布（走 `release.yml`）
4. 在 CHANGELOG 与发布说明中写明本次为凭据轮换，提示用户升级

**必须写明固有代价：轮换即断服。** 旧 token 一旦撤销，所有未升级用户插件里内置的旧 token 立即失效（表现为 401），他们的反馈功能中断直到升级完成。因此轮换**不是无损操作**，不能当作日常动作随手做。这正是 Q2=B 相对「中转服务」与「Device Flow」的核心代价（用户已知悉并接受）。

**FR4.7（token 在 bundle 中的呈现 —— 诚实定性）** token 会以字符串形式存在于 `dist/main.js`，**任何用户都能读到，这是 Q2=B 的既定前提，不是缺陷**。可以做的是提高自动化爬取的成本（例如构建期分段/编码、运行期拼接），**但必须明确这既不是加密也不是安全边界**：上一轮已确认非对称加密在本场景不成立——插件必须在用户机器上持有明文 token 才能发出 HTTPS 请求，而能执行该请求的客户端就能被改造成替别人执行。因此：

- 不得在代码注释、文档、设置页 UI 或发布说明中把这类处理描述为「加密」「安全保护」或「无法被提取」
- 若采纳混淆手段，其收益（降低被自动化扫描的命中率）与代价（多一层构建复杂度）需在设计阶段一并评估，不得为「看起来更安全」而引入

### FR5：失败与降级

**FR5.1（路径总览）** 澄清对话与 GitHub 提交是两个会独立失效的依赖，失败处理按此分层：

| 依赖状态 | 行为 |
|---|---|
| 全部正常 | 澄清 → 草稿预览 → 显式确认 → 提交成功 → 回显编号与链接 |
| 检索失败或触限 | 跳过去重并明示 → 其余流程不变（FR5.4） |
| 提交遇到限流 | 按 `Retry-After` 退避重试（FR5.4） |
| 提交遇到网络失败 | 落重试队列，提示已暂存，提供重试入口（FR5.3） |
| 提交遇到鉴权/权限错误 | 分类提示，**且必须能让发布方察觉**（FR5.5） |
| **LLM 不可用** | 对话式澄清无法进行 → 明确提示，**无替代路径**（FR5.2，Q3=A） |

**FR5.2（已定稿，Q3=A）** LLM 不可用时**不做**静态表单兜底。反馈 tab 必须给出**明确、可操作的提示**，说明当前无法进行对话式反馈及原因（模型未配置 / 网络不可达 / 请求失败），并指出用户可以稍后重试。**不得**呈现一个卡住不动的输入框或静默失败——用户必须能区分「我的问题没被接受」和「功能当前不可用」。用户输入的内容在此时不得被丢弃（按 FR5.7 保留）。

**FR5.3（草稿暂存与提交重试队列）** 草稿落本地持久化（`plugin.saveData`），记录 `{ title, body, type, createdAt, status, dedupKey }`；提交失败时进入**重试队列**：
- 提示「已暂存，可稍后重试」，并提供手动重试入口；不得静默失败
- 插件重启后队列仍可读取并重试
- 重试受 FR3.8 的幂等键约束，不产生重复 issue
- 用户可查看、重试、删除暂存项

**FR5.4（限流与退避）** GitHub API 返回 403/429 且带 `Retry-After` 时，按该值退避重试，重试次数有上限（含抖动，避免多用户同时重试形成同步冲击）；超限转为暂存并明确告知用户「已被限流，稍后重试」。**不得**无限重试。检索接口（FR3.1）触限时按 FR5.1 跳过去重，不做退避循环——避免在用户等待澄清结果时叠加不可预期的延迟。

**FR5.5（错误分类）** 不同失败必须给出不同的、可操作的提示：
- `401` → 内置凭据已失效（通常意味着发布方已轮换但用户未升级），提示用户升级插件
- `403` → 权限不足（token 缺少 `Issues: write`）或触发限流（后者走 FR5.4）
- `404` → 目标仓库不存在／Issues 已关闭
- `422` → 提交内容被仓库规则拒绝（例如必填字段校验），回显仓库的具体报错
- 网络层异常（超时、DNS、TLS）→ 归入 FR5.3 的重试队列

**FR5.6（队列生命周期）** 暂存项需设数量上限（超出时提示用户清理，而非静默丢弃最旧的）；含用户输入内容，删除后不得残留；成功提交后从队列移除。

**FR5.7（关闭未提交会话）** 用户关闭带有未提交草稿的反馈 tab 时，必须保留草稿而非静默丢弃；用户重新进入时能看到并继续。

### FR6：隐私与安全

**FR6.1（提交前全文预览）** 显式确认（FR3.7）必须展示将要公开的**全部内容**（标题 + 正文全文 + 类型，或完整评论正文），且用户可在预览中**编辑**。这是内容透明化的实质，不是走形式的勾选框。

**FR6.2（公开可见警告）** 明确告知用户三件事，缺一不可：
1. 内容将出现在**公开仓库**，任何人都能看到
2. **所有 issue 都会以发布方账号发出**，不会显示提交者的身份——因此若用户希望被追问，需要在正文里留下联系方式，而**留下联系方式即等于公开它**（两者需在同一个提示里讲清，由用户自行取舍）
3. 创建后**无法由插件撤回**

**FR6.3（不主动采集 vault 内容）** 诊断信息只包含固定字段：插件版本、Obsidian 版本、操作系统/平台、当前 provider 类型、最近一次错误摘要。**不含**笔记内容、文件路径、vault 名称、API Key、内置 token、对话历史全文。该白名单由 `get_plugin_diagnostics` 的工具签名强制（FR3.2a），不是靠提示词约束。

**FR6.4（privacyMode 联动）** 当设置中 `privacyMode` 为开启时，诊断信息**默认不附带**（覆盖 Q6=A 的默认值），用户需在预览中逐项显式勾选。此外 `feedback` 技能必须在提示词层面被告知不得把笔记/记忆内容写进 issue 正文，除非用户在本轮明确要求。

> Q8=A 已把长期记忆与环境上下文的注入整体关掉（FR2.7），残余风险面很小；保留本条是为覆盖「用户自己在对话里粘贴了笔记内容」这一类情况。

**FR6.5（不信任外部输入）** 从 GitHub 返回的内容（已有 issue 标题/正文、API 错误信息）在渲染进对话时按不可信内容处理，不得被当作指令执行（对齐 `corner-checklist.md` 的「AI and agent output → Untrusted content steering the model」）。

**FR6.6（用户输入的健壮性）** 用户可能在反馈里粘贴极长文本、含 Markdown/HTML/控制字符的内容。这些内容在渲染为 issue 正文、经 API 提交时必须保持原样且不破坏布局，不因特殊字符截断或损坏。

**FR6.7（插件目录读隔离 —— Q2=B 的新增硬需求）**

**背景**：token 随 bundle 分发，`dist/main.js` 被用户安装到 `<vault>/.obsidian/plugins/baizer/main.js`。因此「让模型读到该文件」等价于「泄漏 token」。攻击链路：笔记/网页中的提示注入 → 诱导模型读取 bundle → 用 `network` 类工具（`save_webpage`/`web_search`，**免批**）把内容外传。

**代码现状核实**（本次逐文件确认，与编排层描述略有出入，以本条为准）：

| 读能力工具 | 路径解析方式 | 现状能否读到 `.obsidian/` |
|---|---|---|
| `read_note` | `metadataCache.getFirstLinkpathDest(path, '')` | 不能——走 vault 索引，点目录不在索引内 |
| `read_file` | `vault.getAbstractFileByPath(path)` + `instanceof TFile` 守卫 | 不能——同上 |
| `search_vault` / `open_file` | `vault.getFiles()` | 不能——同上 |
| `read_skill` | `vault.adapter.read(resolved.filePath)`，路径由 `skillRegistry.resolveForRead(name)` 解析 | **API 能读点目录**，但路径被 registry 约束，不接受模型提供的任意路径 |
| `plugin-ctrl` 四工具 | `adapter.read` / `adapter.exists` 读 `.obsidian/plugins/*` | **能**，但受 `allowPluginControl` 门控（默认 false） |

> 编排层描述的机制（`read_note` 走 `getAbstractFileByPath`）与代码不符，实际是 `metadataCache.getFirstLinkpathDest`。但「没有显式路径限制」这一结论成立——只是限制是**隐式**的。

**问题是：这些防护没有一条是显式的、被测试锁定的。**

1. 「vault API 不索引点目录」是 Obsidian 的实现细节。代码库自己在 `skill-generator.ts:192`（「vault API 不索引 .obsidian 目录」）与 `read-skill.ts:7`（「Obsidian 的 metadataCache / getAbstractFileByPath 看不到点目录」）的注释里承认了这一点——它是被观察到的行为，不是我们拥有的契约。
2. `read_skill` 与 `skill-generator` 已经证明 `vault.adapter.read()` 能读点目录，**能力在代码库里现成存在**。
3. 写侧已有显式守卫：`vault-ops.ts:567` 的 `isObsidianConfigPath(app, path)` 在 `create_file` 等写入工具里拒绝 `.obsidian`。**读侧没有对应的守卫**——这个不对称正是要补的地方。
4. `plugin-watcher.getEnabledPluginIds()` 显式排除了 `PLUGIN_ID`，所以 skill-generator 目前不会读自己的 `main.js`；但这是**唯一**挡住它的一道过滤，一次重构就可能丢掉。而 `extractSyntaxHints` 会把 `main.js` 前 50KB 里被引号包裹的标识符抽出来写进生成的 `SKILL.md`（模型可经 `read_skill` 读到）——这条通道是真实存在的，即便当前的抽取正则恰好不匹配 GitHub token 的字符集（`github_pat_*`/`ghp_*` 含大写与下划线，不满足 `[a-z][a-z0-9-]{2,29}`），也不构成设计上的保护。

**要求：**

**FR6.7.1** 所有 vault 读能力工具（`read_note`、`read_file`、`search_vault`、`open_file`、`list_notes` 等）必须**显式拒绝** `<configDir>` 前缀路径，与写侧的 `isObsidianConfigPath` 对称。**不得**依赖「vault API 恰好不索引点目录」这一实现细节。

**FR6.7.2** 插件自身的 bundle 路径（`<configDir>/plugins/<PLUGIN_ID>/`）必须在**读取、列举、搜索**三条路径上都被排除；排除判定基于 `manifest.json` 的 `id` 而非硬编码字符串，以免改名后失效。

**FR6.7.3** `read_skill` 的路径解析必须保持在 `skillRegistry` 的约束内（不接受模型提供的任意路径）；需补测试锁定「模型传入 `../`、绝对路径、`<configDir>` 前缀时均被拒绝」。

**FR6.7.4** `plugin-watcher.getEnabledPluginIds()` 对 `PLUGIN_ID` 的排除必须补测试锁定；`extractSyntaxHints` 抽取的内容在写入 `SKILL.md` 前必须过滤掉疑似凭据的字符串。

**FR6.7.5** 上述四条必须有自动化测试，纳入 `test/run-tests.ts`。这些是**显式契约**，不是「Obsidian 恰好如此」。

**FR6.7.6（需实测确认）** 设计阶段必须实测 `.obsidian/` 在各读能力工具下的实际可达性，并把实测结果与 FR6.7.1–FR6.7.4 的实现对齐。**实测结论无论「可达」还是「不可达」，FR6.7.1–FR6.7.5 都要做**——「不可达」只是当前的事实，「显式拒绝」才是我们能守住的契约。

**FR6.8（凭据不落入任何可外传的载体）** 内置 token 不得出现在：日志（`logger.*` 的任何级别）、错误信息与堆栈、`get_plugin_diagnostics` 的返回、草稿内容、issue 正文、设置页 UI、测试快照与 fixture、构建产物之外的任何仓库文件。需有一条测试或静态检查锁定「bundle 中 token 字面量只出现在预期的注入点」。设置页展示凭据状态时只显示「已内置」/「未配置」。

## 非功能性需求

**NFR1（移动端兼容）** 全部改动必须同时运行于桌面端与移动端（`manifest.json` `isDesktopOnly: false`）。不得引入 `child_process` 等 Node-only API。

**NFR2（包体）** `main.js` 产出仍须小于 5 MB，由现有 `test/bundle-size.test.ts` 继续守护。**凭据注入的实现方式不得显著改变产物体积**（`define` 注入的字符串常量对体积的影响应为常数级）；需确认注入方式不破坏 `bundle-size.test.ts` 的现有断言（该测试若读取构建产物或依赖构建流程，注入时机需与之对齐）。不引入新的 HTTP 客户端依赖——GitHub 交互用 `requestUrl` 手写最小请求。

**NFR3（可测试性）** 新工具须可脱离 Obsidian 运行时单测：沿用现有 `web-search`/`web-clipper` 的 `deps` 注入模式（`requestUrl`/`wait` 可替换，`model-catalog-service` 的「超时 + 取消」包装可复用）。需要覆盖：
- 草稿渲染：模板字段齐全、字段缺失、超长文本、特殊字符（`&`/`#`/换行/emoji）
- 去重检索：命中、无命中、触限降级
- 错误分类映射：401 / 403 / 404 / 422 / 网络异常各自落到正确分支
- 幂等键：重复提交不产生第二条
- 退避：`Retry-After` 解析、上限、抖动
- 队列：读写、上限、删除后无残留、重启后仍可读
- 模板同源校验（FR3.5）
- 读隔离（FR6.7.5）
- 凭据不泄漏（FR6.8）

**NFR4（国际化）** 全部新增用户可见文案走 `t()` 并补 `zh`/`en` 两份，不硬编码中文字符串。

**NFR5（可访问性）** 新增的头部按钮与审批卡片交互必须键盘可达、带 `aria-label`，状态不只靠颜色表达（对齐现有 `createHeaderActionButton` 与审批卡片的做法）。

**NFR6（不拖慢既有链路）** 新增技能与工具不得增加常规对话的每轮提示词体积：`feedback` 技能靠渐进披露（系统提示只增一行清单），新工具仅注册不注入系统提示。不得使 Guardian 快/深路径或普通对话的首 token 延迟产生可感知退化。

**NFR7（构建可复现性与凭据隔离）** 在给定相同的 `BAIZER_FEEDBACK_TOKEN` 与相同源码下，构建产物必须可复现；token 未设置时**发布路径必须失败**（FR4.2），本地路径允许通过但需警告。仓库的任何提交历史中不得出现 token（需确认 `.gitignore` 补 `.env` 后，历史中亦无残留）。

**NFR8（读隔离契约的测试锁定）** FR6.7 的四条守卫必须有测试锁定，且测试须在**不依赖 Obsidian 实际行为**的前提下断言「显式拒绝」——即断言守卫函数本身的判定，而不是断言「`getFiles()` 恰好没返回点目录文件」。这样即便 Obsidian 的实现变化，测试仍能守住契约。

## 约束

- **凭据来源唯一**：token 只能来自构建期环境变量，不得有任何运行期凭据输入路径（FR4.2）。
- **不接受非对称加密等「看起来更安全」的方案**：已在对话中确认不成立；不得为实现该类方案增加复杂度（FR4.7）。
- **目标仓库与凭据权限最小化**：`yinfi/baizer` 硬编码；PAT 仅 `Issues: write`。
- **复用既有网络通路**：只用 Obsidian `requestUrl`，与 `model-catalog-service`/`video-transcription`/`web-clipper` 保持一致。
- **复用既有审批机制**：不另造确认 UI；复用审批卡片与 `executeApprovedAction`（FR3.7）。
- **复用既有会话机制**：不新建独立的消息存储或流式渲染实现。
- **技能与工具的分工**：`feedback` 是 Skill（只提供行为指令），四个工具负责执行。UI 动作（渲染预览卡片、展示审批）归 UI 层，不放进工具。
- **模板字段契约来自仓库文件**：`.github/ISSUE_TEMPLATE/*.yml` 是唯一事实来源，插件侧字段清单必须与其同源可校验。
- **读隔离必须显式**：不得以「Obsidian 恰好不索引点目录」作为安全依据（FR6.7）。

## 假设

- **[assumption]** **A1（最高优先级，可能推翻 Q2=B）**：GitHub 的 secret scanning 会自动检测公开仓库中的 GitHub 格式 token 并可能自动撤销。`dist/main.js` 作为 Release 资产公开发布，若其中含明文 `github_pat_*`/`ghp_*` 字符串，存在**被 GitHub 自动撤销**的风险——一旦发生，token 会在无人干预的情况下失效，现象是「昨天还好、今天所有用户全部 401」，极难定位。**验证方式**：用一个测试 token 走一遍完整发布流程，观察是否被检测/撤销。**归属：设计阶段开始前必须前置验证**——若成立，Q2=B 需要调整（例如换用不具备可检测格式的凭据载体，或回到中转服务 / Device Flow）。**这是本次唯一可能推翻 Q2=B 的技术风险。**
- **[assumption]** A2：REST API `POST /repos/{owner}/{repo}/issues` **不会**套用仓库的 ISSUE_TEMPLATE（模板是 Web 表单特性）。这决定了 FR3.4 必须由插件本地渲染正文。**验证方式**：建一条测试 issue，比对正文结构。**归属**：开发阶段。
- **[assumption]** A3：目标仓库 `yinfi/baizer` 的 Issues 保持开启。**归属**：开发阶段。
- **[assumption]** A4：非协作者创建 issue 时 `labels` 会被**静默丢弃**（GitHub 文档：仅具 push 权限者可设置标签）。本功能以发布方 token 提交，若该 token 属于协作者则不受此限——**需实测确认该 token 是否具 push 权限**，据此决定 FR3.10 的标题前缀是否保留。**归属**：开发阶段。
- **[assumption]** A5：`.obsidian/` 目录在当前 Obsidian 版本下不被 `vault.getFiles()` / `getAbstractFileByPath()` / `metadataCache` 索引，但**被 `vault.adapter.read()` 可达**（代码库自身注释与 `read-skill.ts`/`skill-generator.ts` 的实现已佐证）。FR6.7 不依赖该结论成立，但实测结果会影响实现的取舍。**归属**：设计阶段（FR6.7.6）。
- **[assumption]** A6：用户在公开仓库留下的 issue 会以发布方账号显示，不显示提交者身份。这是 FR6.2 第 2 条警告文案的事实基础。**归属**：开发阶段实测确认。
- **[assumption]** A7：本阶段只确定「模板字段必须等价」这一行为要求，正文的具体措辞、字段顺序、模板版本如何随仓库演进，留给 Functional Design 阶段设计。
- **[assumption]** A8：`chatStream` 透出 `forcedSkillName`、`BaseChatRuntime` 增加「跳过记忆注入」通路、以及 `define` 注入 token 的具体写法，形态留给设计阶段决定；本阶段只要求 FR2.2 / FR2.7 / FR4.2 三项行为成立。

## 范围外

- **不做中转服务**：Q2=B 已排除「token 留在服务端」的方案（即上一轮选项 A）。若 A1 验证结论推翻了 Q2=B，需重新决策，不在本阶段预设。
- **不做 OAuth Device Flow**：Q2=B 已排除需要用户授权的方案（选项 C）。
- **不做 token 的加密或密钥托管**：已确认在本场景不成立（FR4.7）。
- **不做崩溃自动上报（telemetry）**：本功能的每一次对外写入都由用户在审批卡片上显式确认。
- **不做反馈的统计分析、看板、趋势**。
- **不做 issue 状态回写**：不把 GitHub 上 issue 的进展同步回插件、不做插件内 issue 列表。
- **不做多仓库路由**：目标仓库硬编码（Q4=A）。
- **不做目标仓库的配置项**（Q4=A 的直接结果）。
- **不替换或改造既有的 👍/👎**（Q7=B）。
- **不把反馈提交到 Multica 或其他平台**。
- **不做安全漏洞的公开上报路径**：按 FR3.11 引导至私密通道。
- **不做 LLM 不可用时的表单兜底**（Q3=A）。
- **不做「用户身份标识」字段**：所有 issue 以发布方账号发出，插件不采集、不上报用户身份；联系方式由用户在正文里自行决定是否留下（FR6.2）。

## 开放问题

- **[A1 衍生]** secret scanning 的实测结论若为「会被撤销」，Q2=B 需要重新决策。这是**唯一可能推翻已锁定方案的风险**，且必须在设计阶段开始前验证，否则设计可能白做。
- **[FR3.7 衍生]** 「确认不受 `confirmExecutions` 影响」是一处有意偏离 `needsApproval()` 默认语义的设计，需在设计阶段确认实现方式不波及其他工具，且用户在关闭 `confirmExecutions` 后仍能理解为何这里还要确认。
- **[FR4.7 衍生]** 是否采纳混淆手段（分段/编码）需在有 A1 结论后一并评估：若 A1 成立（会被自动撤销），混淆的意义大幅上升；若不成立，KISS 原则倾向于不做。
- **[FR6.3 衍生]** 诊断信息「最近一次错误摘要」的来源与截断策略需要在设计阶段明确——错误信息可能包含文件路径或凭据片段，与 FR6.3、FR6.8 同时存在张力。
- **[FR6.2 衍生]** 「以发布方账号发出」意味着无法从 issue 追问提交者。是否需要引导用户留下联系方式、以及如何在不破坏隐私的前提下做到，需在设计阶段与 FR6.2 的警告文案一起定。
- **[FR4.6 衍生]** 轮换 runbook 是否需要配套的自动化（例如发布前校验 token 有效性），还是纯人工流程，留给设计阶段判断。

## 需求追溯矩阵

| Req ID | 摘要 | 优先级 | 状态 | Design Ref | Unit Ref | Test Ref |
|--------|------|--------|------|------------|----------|----------|
| FR1.1 | ShellView 头部反馈入口 | Must | 已定稿 | — | — | — |
| FR1.2 | 命令面板命令 `baizer:feedback` | Must | 已定稿 | — | — | — |
| FR1.3 | 专用反馈 tab | Must | 已定稿 | — | — | — |
| FR1.4 | 反馈 tab 内多轮对话 | Must | 已定稿 | — | — | — |
| FR1.5 | 关闭 tab 不丢草稿 | Must | 已定稿 | — | — | — |
| FR2.1 | 复用 `chatStream` 会话型链路 | Must | 已定稿 | — | — | — |
| FR2.2 | 每轮强制激活 `feedback` 技能 | Must | 已定稿 | — | — | — |
| FR2.3 | 新增内置技能 `feedback` | Must | 已定稿 | — | — | — |
| FR2.4 | 最少轮次澄清 + 可跳过追问 | Must | 已定稿 | — | — | — |
| FR2.5 | 澄清中检索已有 issue | Should | 已定稿 | — | — | — |
| FR2.6 | 工具子集不含 vault 读能力 | Must | 已定稿 | — | — | — |
| FR2.7 | 干净会话（Q8=A，双隔离） | Must | 已定稿 | — | — | — |
| FR2.8 | 会话持久化 + 终态标识 | Should | 已定稿 | — | — | — |
| FR3.1 | 工具 `search_github_issues`（鉴权） | Must | 已定稿 | — | — | — |
| FR3.2 | 工具 `create_github_issue`（risk: write，真实写入） | Must | 已定稿 | — | — | — |
| FR3.2a | 工具 `get_plugin_diagnostics`（只读白名单） | Must | 已定稿 | — | — | — |
| FR3.2b | 工具 `add_issue_comment`（risk: write） | Must | 已定稿 | — | — | — |
| FR3.3 | 目标仓库硬编码 `yinfi/baizer`（Q4=A） | Must | 已定稿 | — | — | — |
| FR3.4 | 模板字段等价的正文渲染 | Must | 已定稿 | — | — | — |
| FR3.5 | 模板同源校验测试 | Must | 已定稿 | — | — | — |
| FR3.6 | 去重检索 + 候选选择（Q5=A，含追加评论） | Must | 已定稿 | — | — | — |
| FR3.7 | **提交前显式确认，不受 `confirmExecutions` 影响** | Must | 已定稿 | — | — | — |
| FR3.8 | 提交幂等（双层去重） | Must | 已定稿 | — | — | — |
| FR3.9 | 成功回显编号与链接 | Must | 已定稿 | — | — | — |
| FR3.10 | 标签策略（依 A4 实测结论） | Should | 已定稿 | — | — | — |
| FR3.11 | 安全漏洞改走私密通道 | Must | 已定稿 | — | — | — |
| FR4.1 | 设置页 `feedback` 分区（无 token 输入框） | Must | 已定稿 | — | — | — |
| FR4.2 | **凭据注入契约**（构建期 env、不进 git、缺失即失败） | Must | 已定稿 | — | — | — |
| FR4.3 | 「测试连接」（不回显 token） | Should | 已定稿 | — | — | — |
| FR4.4 | 功能默认开启（Q2=B 推导，可否决） | Must | 已定稿 | — | — | — |
| FR4.5 | 凭据形态：fine-grained PAT，仅 `Issues: write`（Q2=B） | Must | **已定稿** | — | — | — |
| FR4.6 | **轮换流程 + 「轮换即断服」代价说明** | Must | 已定稿 | — | — | — |
| FR4.7 | token 呈现方式的诚实定性（非加密、非安全边界） | Must | 已定稿 | — | — | — |
| FR5.1 | 降级路径总览 | Must | 已定稿 | — | — | — |
| FR5.2 | LLM 不可用：明确提示，无兜底（Q3=A） | Must | **已定稿** | — | — | — |
| FR5.3 | 草稿暂存 + 提交重试队列 | Must | 已定稿 | — | — | — |
| FR5.4 | `Retry-After` 退避（有上限、含抖动） | Must | 已定稿 | — | — | — |
| FR5.5 | 错误分类 401/403/404/422/网络 | Must | 已定稿 | — | — | — |
| FR5.6 | 队列生命周期管理 | Should | 已定稿 | — | — | — |
| FR5.7 | 关闭会话保留草稿 | Must | 已定稿 | — | — | — |
| FR6.1 | 提交前全文预览（可编辑） | Must | 已定稿 | — | — | — |
| FR6.2 | 公开可见警告（含「以发布方账号发出」） | Must | 已定稿 | — | — | — |
| FR6.3 | 诊断信息字段白名单（工具签名强制） | Must | 已定稿 | — | — | — |
| FR6.4 | privacyMode 联动 | Must | 已定稿 | — | — | — |
| FR6.5 | 外部内容按不可信处理 | Must | 已定稿 | — | — | — |
| FR6.6 | 特殊字符/超长文本健壮性 | Should | 已定稿 | — | — | — |
| FR6.7 | **插件目录读隔离（Q2=B 新增，含 6 个子条）** | Must | 已定稿 | — | — | — |
| FR6.8 | 凭据不落入任何可外传载体 | Must | 已定稿 | — | — | — |
| NFR1 | 移动端兼容 | Must | 已定稿 | — | — | — |
| NFR2 | 包体 < 5 MB（注入方式不破坏体积守卫） | Must | 已定稿 | — | — | — |
| NFR3 | 工具可单测（deps 注入） | Must | 已定稿 | — | — | — |
| NFR4 | 国际化 | Must | 已定稿 | — | — | — |
| NFR5 | 可访问性 | Should | 已定稿 | — | — | — |
| NFR6 | 不拖慢既有链路 | Must | 已定稿 | — | — | — |
| NFR7 | 构建可复现性 + 凭据隔离（缺失即失败） | Must | 已定稿 | — | — | — |
| NFR8 | 读隔离契约的测试锁定（不依赖 Obsidian 行为） | Must | 已定稿 | — | — | — |

> Design Ref / Unit Ref / Test Ref 留空是有意的：本阶段只产出需求，列留空即代表「尚未设计／尚未分配／尚未覆盖」的缺口，由后续阶段逐格填上。
