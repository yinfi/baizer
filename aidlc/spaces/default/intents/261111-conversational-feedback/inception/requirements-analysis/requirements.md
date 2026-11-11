# 需求分析 —— 对话式反馈：与智能体澄清后提交 GitHub Issue

> **状态：已定稿**（2026-11-11）。Q1–Q8 八项取舍已由用户作答并锁定，`requirements-analysis-questions.md` 保留决策留痕。
> 本文已按 Q2=D（零凭据）成体系改写：所有依赖 GitHub Token 的路径已删除或重写，不留失效需求。

## 意图分析

**用户想达成什么**：把「用户遇到问题 → 自己组织语言 → 自己判断该报给谁 → 自己去 GitHub 建 issue」这条目前完全在插件之外、且大多数用户不会走完的链路，收敛成插件内的一次对话。用户只需要用自己的话把遇到的问题讲出来，智能体负责把它问清楚、补成一份结构完整的 issue 草稿，再一步跳到 GitHub 的提交页。

要解决的不是「缺一个反馈按钮」，而是**反馈的漏斗损耗**：用户愿意反馈但懒得写清复现步骤、不知道该报给哪个仓库、不确定是不是已知问题，最终选择沉默。因此本需求的价值判据是**反馈的完成率**，而不是入口的数量。

**关键结论（Q2=D 定下的根本形态）**：

> **本功能不持有任何 GitHub 凭据，不具备任何 GitHub 写入能力。**
> 插件能做的全部是：澄清 → 生成结构完整的草稿 → 把草稿送进用户的浏览器（URL 预填或剪贴板）→ 用户自己点 Submit。
> 「提交」这个动作发生在插件之外，由用户完成。

这一条决定了本文的绝大部分形态，也是理解后续所有降级设计的前提。它的好处是零凭据、零权限、零长期维护负担、移动端最稳；代价是三处必须显式承接的后果：

1. **「追加评论到已有 issue」无法自动执行**（GitHub 不支持 URL 预填评论正文）→ `FR3.13`
2. **正文受 URL 长度上限约束**，超限必须降级为剪贴板 → `FR3.12`
3. **插件无法感知提交结果**，因此拿不到 issue 编号与链接 → `FR3.8`

**其余三项已定死的结论**：

1. **入口**：Workbench（`ShellView`）头部新增反馈图标按钮 + 命令面板命令，点击**新开一个专用反馈 tab**（Q1=A）。不复用普通对话 tab（会污染用户正在进行的对话），也不另造独立弹窗（要重造流式渲染/工具时间线/审批卡片，违反 DRY）。
2. **模型链路**：复用**会话型** `ModelService.chatStream` → pi `agentLoop`（`conversationId` = 该 tab id），通过新增内置技能 `feedback` 做强制激活（Q8=A：干净会话，不注入长期记忆与环境上下文）。不用无状态 `generate`：澄清是多轮且需要调工具。
3. **降级**：LLM 不可用时**不做**表单兜底，只给明确提示（Q3=A）。

## 现有形态盘点（本需求的落地依据）

以下均为本次 `multica repo checkout` 后逐文件核实的现状，不是假设。

| 面 | 现状 | 对本需求的意义 |
|---|---|---|
| 插件形态 | Obsidian 插件 `baizer` v1.7.2，`manifest.json` `isDesktopOnly: false` | 全部改动必须移动端可用，禁 `child_process` |
| 模型链路 | 唯一入口 `ModelService`。两条路径：会话型 `chat`/`chatStream` → pi `agentLoop`（带工具/历史/审批/steering）；无状态 `generate` → pi `completeSimple` | 澄清对话走前者 |
| 强制激活技能 | `BaseChatRuntime.prepareTurn` 接受 `forcedSkillName`；`ModelService.executeSlashSkillCommand` 已用此参数。`chatStream` 当前**未透出**该参数 | 反馈会话需要把 `feedback` 技能钉在整段会话上，需小幅扩展该参数透传 |
| 技能注册 | `main.ts` 中 `skillRegistry.registerBuiltinFromMd(<SKILL.md 导入>, executor)`，现有 7 个内置技能（`src/skills/builtin/*/SKILL.md`），渐进披露（系统提示只放清单，模型用 `read_skill` 拉全文） | 新增 `src/skills/builtin/feedback/`，注册成本很低 |
| 工具注册 | `ToolRegistry.register(tool)`，工具声明 `risk: read/write/plugin-control/network/unknown` | 新工具按各自风险声明 |
| 审批模型 | `needsApproval(risk, settings)` 只对 `write` / `plugin-control` 在 `confirmExecutions` 开时返回 true；`network` 免批 | Q2=D 下插件无写入能力，审批模型不再是安全边界（安全边界转移到了浏览器端 GitHub 的 Submit 按钮），本需求不改动该函数 |
| 网络通路 | 统一用 Obsidian `requestUrl`（`model-catalog-service`、`video-transcription`、`web-clipper`、`skill-generator` 均如此），无 `fetch` 直连 | 去重检索走同一条路，不引入新 HTTP 依赖 |
| 会话/多 tab | Workbench = `ShellView`，`TabManager` 管多 tab，每 tab 一个 `conversationId`，会话 JSONL 落 vault（`HarnessSessionManager` + `VaultSessionFileSystem`） | 反馈会话天然与日常对话隔离 |
| 头部入口 | `ShellView.createHeaderActions()` 现只有两个按钮：历史（`search` 图标）、设置（`settings` 图标），用 `createHeaderActionButton(container, label, icon, cls, handler)` 统一构造 | 反馈按钮直接复用该工厂方法 |
| 已有「反馈」 | `MessageRenderer` 在 AI 消息操作栏渲染 👍/👎。👍 → `recordPositiveFeedback` 走 file-back 归档知识库；👎 → 内联输入原因 → `retainLesson` 写长期记忆 + 当场重答。**两者都只作用于插件内部，与 GitHub 无关** | Q7=B：保持现状，两条链路解耦，本需求不碰它们 |
| Issue 模板 | `.github/ISSUE_TEMPLATE/bug_report.yml`（`labels: ["bug"]`，必填：what-happened / repro / plugin-version / obsidian-version / platform / provider / surface）、`feature_request.yml`（`labels: ["enhancement"]`，必填：problem / surface）、`config.yml`（安全漏洞指向 Security Advisory，不走公开 issue） | 模板字段即 issue 正文的字段契约 |
| 设置 | `src/mcp/types.ts` 的 `PluginSettings` + `DEFAULT_SETTINGS`；UI 在 `src/settings.ts`，声明式分区（现有 11 个分区，`{ id, title, description, keywords }`） | 新增 `feedback` 分区（内容比原计划小得多） |
| 持久化 | `plugin.saveData()` / `loadData()`（`data.json`） | 草稿暂存走同一机制 |
| 国际化 | `src/i18n/zh.ts` 的 `t()`，`Locale = 'auto' \| 'en' \| 'zh'` | 新增文案需入 i18n |
| 测试 | `test/run-tests.ts` 注册，`npm test`；CI 见 `.github/workflows/ci.yml`；`test/bundle-size.test.ts` 守护 `main.js` < 5 MB | 模板同源校验、URL 长度边界测试放这里 |

## 来源

- `[desc]` 用户初始描述（`project-description.json`）：「增加一个反馈功能……用户在使用过程中遇到的问题，可以通过**对话**的方式进行反馈；由**智能体**与用户讨论，把问题沟通、澄清清楚；讨论清楚之后，将问题**提交 issue 到 GitHub**。」
- `[scope]` 工作流选定范围：`feature`（新功能，含设计/架构/开发/测试全链路）
- `[Q1]`–`[Q8]` Requirements Analysis 澄清问题的作答（见 `requirements-analysis-questions.md`）：Q1=A、Q2=D、Q3=A、Q4=A、Q5=A、Q6=A、Q7=B、Q8=A
- 本仓代码核实：`manifest.json`、`package.json`、`src/services/model-service.ts`（`chat`/`chatStream`/`generate`/`executeSlashSkillCommand`）、`src/runtime/base-chat-runtime.ts`（`prepareTurn` 的 `forcedSkillName`/记忆注入/上下文注入）、`src/runtime/runtime-types.ts`、`src/skills/tool-registry.ts`、`src/skills/types.ts`、`src/skills/builtin/web-search/executor.ts`（网络工具样板）、`src/permissions/permission-service.ts`（`needsApproval`）、`src/ui/shell-view.ts`（`createHeaderActions`）、`src/ui/tabs/*`、`src/ui/renderers/message-renderer.ts`（👍/👎）、`src/ui/chat-controller.ts`（`recordPositiveFeedback`/`recordNegativeFeedback`）、`src/mcp/types.ts`、`src/settings.ts`、`src/i18n/zh.ts`、`.github/ISSUE_TEMPLATE/*.yml`、`.github/workflows/ci.yml`
- 本仓文档：`CLAUDE.md`（架构分层、两条 LLM 路径、移动端约束）、`CONTEXT.md`（Tool/Skill 之分、Conversation/Session、Force-activation、Approval、权限正交性）、`docs/architecture/skills.md`

## 功能性需求

### FR1：反馈入口（Q1=A）

**FR1.1** 在 Workbench（`ShellView`）头部新增一个反馈入口按钮，与现有「历史」「设置」按钮并列，复用 `createHeaderActionButton()` 工厂方法，带 `aria-label` 与 `title`，键盘可达。

**FR1.2** 注册 Obsidian 命令面板命令（`baizer:feedback`），使用户在**任意界面**（笔记编辑中、Guardian 使用中）都能发起反馈，不必先打开 Workbench。

**FR1.3** 触发入口后，新开一个**专用于反馈的 Workbench tab**，并立即激活该 tab。该 tab 在标签栏上有可区分的标识（标题/图标），用户能一眼分辨它不是一个普通对话。

**FR1.4** 反馈 tab 内为一条**完整的对话**：用户可以多轮补充、纠正、追问，智能体的回复照常流式渲染，与普通对话的交互体验一致。

**FR1.5** 反馈 tab 可被关闭（沿用 `TabManager` 既有语义）；关闭前若存在未完成的草稿，按 FR5.7 处理，不得静默丢弃用户已输入的内容。

### FR2：澄清对话

**FR2.1** 反馈会话复用**会话型**链路 `ModelService.chatStream`，`conversationId` 即该 tab 的 id，从而天然复用：多轮历史（`SessionStore`）、流式事件渲染、工具调用时间线、steering、跨重启恢复。

**FR2.2** 反馈会话的**每一轮**都以 `feedback` 技能为强制激活技能（`prepareTurn` 的 `forcedSkillName`），不依赖用户输入 slash 命令。当前 `chatStream`/`chat` 未透出该参数，需要小幅扩展透传（形态由设计阶段决定）。

**FR2.3** 新增内置技能 `src/skills/builtin/feedback/SKILL.md`，并在 `main.ts` 中按现有 7 个内置技能的同一方式注册。该 SKILL.md 承载三件事：澄清话术与提问策略、issue 必填字段清单、正文渲染规则。

**FR2.4** 澄清策略要求：智能体在**最少轮次**内问清「问题类型（缺陷/需求）、现象、期望行为、复现步骤、影响范围（哪个界面/哪个功能）、是否已尝试绕过」，且**能从对话或已有信息推断的不得重复追问**。用户明确说「直接提交」「不用再问了」时，智能体必须立即停止追问，用已有信息生成草稿并进入预览流程。

**FR2.5** 澄清过程中，智能体可调用 `search_github_issues`（未鉴权公开检索，见 FR3.1）检查是否已有相同问题，并据此调整提问（例如「这个看起来和 #112 是同一个问题，你是这个意思吗？」）。

**FR2.6** 澄清过程中智能体可调用只读工具 `get_plugin_diagnostics`（见 FR3.2a）获取环境信息，**但不得读取用户笔记内容**（见 FR6.3）。`feedback` 技能声明的工具子集只含 `search_github_issues` / `get_plugin_diagnostics` / `prepare_github_issue_draft`（外加始终可用的 `read_skill`），从能力上就没有读取 vault 的路径。

**FR2.7（Q8=A）** 反馈会话是**干净会话**，必须同时隔离两类上下文注入：
- **环境上下文**：不注入当前笔记、反链等 ambient context
- **长期记忆**：不注入 `recallForPrompt` 召回结果与 Mental Model 块

理由：反馈正文最终会在公开仓库发布，用户个人偏好/笔记内容的任何泄漏都不可逆；隔离比事后过滤可靠。当前 `BaseChatRuntime.prepareTurn` 在 `memoryManager` 存在时**无条件**注入这两项，因此需要一条明确的「跳过记忆注入」通路（形态由设计阶段决定）。

**FR2.8** 反馈会话产生的对话记录按既有会话持久化机制落 vault，用户重开该 tab 可继续未完成的反馈。会话终态由用户手动标记（见 FR3.8），因为插件无法感知浏览器端的提交结果。

### FR3：草稿生成与提交

**FR3.1** 新增原子工具 `search_github_issues`（`risk: 'network'`，`executionMode: 'parallel'`）。**未鉴权**调用 GitHub 公开搜索接口（`GET https://api.github.com/search/issues?q=repo:yinfi/baizer is:issue ...`），入参为关键词/错误签名与是否包含已关闭 issue，返回候选 issue 的编号、标题、状态、链接。

> 未鉴权搜索的速率上限显著低于鉴权调用（分钟级而非小时级配额），但本功能的检索是**人-paced**（一次反馈会话一次检索），正常使用不会触限。触限时的行为见 FR5.4。

**FR3.2** 新增原子工具 `prepare_github_issue_draft`（`risk: 'read'`）。**它是纯函数式的：不发起网络请求、不打开浏览器、不写任何存储**，只把澄清结果渲染成草稿并返回结构化结果：

```
{ title, body, type, targetUrl, urlLength, exceedsUrlLimit, needsClipboard, fieldWarnings }
```

**打开浏览器、复制剪贴板属于 UI 动作，不放在工具里**——这既符合 `docs/architecture/skills.md` 对工具「不做 shell/UI 关切」的定位，也让草稿渲染与长度判定可以脱离 Obsidian 运行时单测（NFR3）。

**FR3.2a** 新增原子工具 `get_plugin_diagnostics`（`risk: 'read'`），返回 FR6.3 定义的诊断信息白名单字段。它是 `feedback` 技能工具子集中唯一接触运行环境的工具，且**只读固定字段**，不接受任意路径/查询参数——从工具签名上就杜绝读到用户笔记的可能。

**FR3.3（Q4=A）** 目标仓库**硬编码为 `yinfi/baizer`**，不提供任何配置项。设置页只展示该地址（只读），让用户知道反馈会去向何处。

**FR3.4（模板等价）** **REST API 与 `?template=` 都不会替我们套用模板**：本功能走的是 `?body=` 预填，GitHub 会直接采用该正文，仓库的 ISSUE_TEMPLATE 不参与。因此 `prepare_github_issue_draft` 必须把字段渲染成等价的 Markdown 正文，字段结构以本仓模板为准：
- 缺陷类正文须覆盖：What happened / Steps to reproduce / Baizer version / Obsidian version / Platform / Provider / Where it happened / Console output（无则显式写「无」）
- 需求类正文须覆盖：The problem / What you have in mind / How you handle it today / Which part of Baizer
- 类型判定（bug vs enhancement）由澄清结果决定，不由用户在 UI 上手选

**FR3.5（模板同源校验）** 新增自动化测试，断言插件本地的字段清单与 `.github/ISSUE_TEMPLATE/*.yml` 的字段集合一致；仓库模板增删字段时该测试必须失败，从而暴露漂移。这是防止「模板改了、插件没跟上」的唯一可靠手段。

**FR3.6（去重，Q5=A）** 生成草稿前必须先经 `search_github_issues` 检索；命中相似 issue 时**展示候选列表**，让用户选择「追加评论到已有 issue」（见 FR3.13）或「仍然新建」。智能体不替用户判断是不是同一个问题。

**FR3.7（提交前预览）** 草稿生成后，在反馈会话中渲染一张**草稿预览卡片**，展示将要送去 GitHub 的**完整标题、正文全文、类型**，并满足：
- 用户可以在预览中**编辑**标题与正文（FR3.7 的编辑结果即为最终送出的内容）
- 用户可以在预览中**逐项取消诊断信息**（Q6=A：默认附带，可取消）
- 明确显示**目标地址**（`https://github.com/yinfi/baizer/issues/new`）
- 明确告知**下一步的实质**：将打开浏览器页面，**需要你自己点 Submit 才会真正创建 issue**

> 与上一版的关键差异：Q2=D 下插件没有写入能力，「人工确认」不再是一道防止误提交的审批闸门，而是**在把内容送去一个公开页面之前的透明化与可编辑环节**。真正的确认动作是浏览器里 GitHub 自己的 Submit 按钮，这是结构性保证，不依赖插件实现。

**FR3.8（提交结果不可感知 —— 由 Q2=D 推导）** 插件无法读取浏览器端的提交结果，因此：
- **不得**声称「已提交成功」，也不得展示任何自动获取的 issue 编号或链接
- 提供用户手动动作「我已在 GitHub 完成提交」，可选让用户回填 issue 链接
- 手动标记后，该反馈会话置为终态；未标记的会话保持「待提交」状态，重开时可继续
- 若用户在 GitHub 页面放弃了提交，会话保持待提交状态即可，插件不做任何「提交失败」推断

**FR3.9（两条送出路径）** 草稿预览卡片必须同时提供两条路径，且**始终**两条都可用：
- **「在浏览器中打开提交页」** —— 打开 `targetUrl`（含 `?title=` 与 `?body=` 预填）
- **「复制到剪贴板」** —— 复制渲染好的 Markdown 正文（标题单独复制或随正文一并给出）

两条路径都可用是有意设计：用户可能希望先在 GitHub 页面上编辑，也可能希望粘进一个已有 issue。不得因为 URL 路径可用就隐藏剪贴板按钮。

**FR3.10（标签兜底）** 非协作者在 GitHub 上创建 issue 时 `labels` 会被静默丢弃（`[assumption]` A3），URL 的 `?labels=` 参数同样不可靠。因此标题需带类型前缀（`[Bug]` / `[Feature]`）作为不依赖标签权限的分类信号。

**FR3.11（安全漏洞不走此通道）** 对齐 `.github/ISSUE_TEMPLATE/config.yml`，澄清过程中一旦识别为安全漏洞，智能体必须改为引导用户走 `SECURITY.md` / GitHub Security Advisory 私密上报，**不得**生成公开 issue 草稿。

**FR3.12（URL 长度阈值与降级 —— 由 Q2=D + Q6=A 推导）**

`?body=` 预填受 URL 长度上限约束，Q6=A 默认附带诊断信息会让正文变长、更容易触限。要求：

- **判定方式**：必须按**最终 URL 的实际字符数**判定，**不得**用「正文字符数」估算。percent-encoding 的膨胀率随内容而变——ASCII 约 1.1×，而**中文约 9×**（1 个汉字 = 3 个 UTF-8 字节 = 9 个 URL 字符）。以正文长度估算会严重低估。
- **阈值**：设一个保守常量 `T`，默认 **6000 字符**（覆盖移动端 WebView 与各浏览器地址栏的差异）。该常量需在实现阶段用真机实测校准（NFR8），并为其边界写测试。
- **超限时的用户可见行为**（必须明确，不得静默降级）：
  1. 卡片上以一行说明告知用户：「正文较长，无法通过链接预填，已改为复制到剪贴板」
  2. **标题仍然预填**（标题短，几乎不会触限），打开 `issues/new?title=...` 而**不带** `body=`，把用户的输入成本降到最低
  3. 正文自动复制到剪贴板，并给出粘贴提示
  4. 用户仍可手动编辑正文缩短后重试 URL 路径
- **必须显式承认的现实**：对中文用户而言，`T=6000` 折算下来正文容量约 600 余汉字，**剪贴板降级不是边角路径，而是常见路径**。因此剪贴板路径必须与 URL 路径同等对待——同样的提示质量、同样的可测试性、同样在卡片上可见，不能当成兜底彩蛋。

**FR3.13（零凭据下的「追加评论到已有 issue」—— 由 Q2=D 推导，可被用户否决）**

Q5=A 选定的「追加评论到已有 issue」，在 Q2=D 的零凭据前提下**无法由插件自动执行**：GitHub 不支持用 URL 预填评论正文，插件也没有任何写入 API 的能力。落成如下可实现形态：

- 智能体为已有 issue 生成一段**评论草稿**（复用同一套澄清结果，措辞调整为「补充信息」而非「新问题」）
- 用户选择该分支后，插件：**复制评论草稿到剪贴板** + **打开该 issue 的页面**（`https://github.com/yinfi/baizer/issues/<n>`）
- 用户在 issue 页面手动粘贴并点 Comment
- 同样按 FR3.8 处理：插件不感知结果，提供「我已在 GitHub 完成评论」的手动标记

> **这是本次答案里唯一需要推导的地方，用户可否决。** 若用户希望「追加评论」由插件自动完成，Q2 必须回到需要 Token 的方案（A/B/C）。按当前推导结果，插件的角色退化为「把草稿备好、把页面打开」。

### FR4：配置（无鉴权）

**FR4.1** 在 `src/settings.ts` 新增 `feedback` 分区（含 `title`/`description`/`keywords`，与现有 11 个分区同构）。因 Q2=D 与 Q4=A 收窄了配置面，该分区只承载两项：
- 功能开关（FR4.4）
- 目标仓库地址的**只读展示**（`https://github.com/yinfi/baizer`），让用户知道反馈去向

**FR4.2（由 Q2=D 推导）** 本功能**不采集、不存储、不请求任何 GitHub 凭据**。这不是一句声明，而是可验证的产品属性：设置页没有 Token 输入框、`data.json` 不新增任何凭据字段、代码中不存在任何携带 `Authorization` 头的请求。相应地，上一版中「Token 与 provider apiKey 同等保密待遇」的要求已不适用，删除。

**FR4.3（删除，说明理由）** 上一版的「测试连接」动作已**删除**。理由：零凭据下没有「连接」可测，而目标仓库可达性（仓库改名/归档/Issues 关闭）会由浏览器端 GitHub 自己的页面直接暴露，不需要插件多花一次请求去预检——预检反而引入一个新的失败模式（离线时预检失败却并非真的不可用）。**替代措施**：草稿预览卡片必须显示目标地址（FR3.7），让用户在打开前就能看到它指向哪里。

**FR4.4（Q2=D 推导，原为默认关闭）** 功能**默认开启**。原定「默认关闭」的理由是「需要用户提供 GitHub 凭据，静默启用不符合对外动作先确认的原则」；零凭据下该理由不再成立——本功能不索取任何凭据、不发起任何写入、每一次对外动作都要用户在浏览器里亲手点 Submit，因此不存在「静默对外提交」的风险。默认开启也让功能可被发现，这正是本需求要解决的问题。**此项为推导结论，用户可否决改回默认关闭。**

**FR4.5（已定稿，Q2=D）** 鉴权方式：**不使用任何 GitHub 凭据**。全部写路径（新建 issue、追加评论）由用户在浏览器中手动完成；插件只负责生成草稿、预填 URL 与复制剪贴板。

### FR5：失败与降级

**FR5.1（路径总览）** 澄清对话与「把草稿送出去」是两个会独立失效的依赖，失败处理按此分层：

| 依赖状态 | 行为 |
|---|---|
| LLM 可用、网络正常、正文未超限 | 草稿预览 → 打开 URL 预填页 → 用户在 GitHub 点 Submit |
| LLM 可用、正文超限 | 草稿预览 → 标题预填 + 正文剪贴板 → 用户粘贴后 Submit（FR3.12） |
| LLM 可用、检索失败或触限 | 跳过去重并明示 → 其余流程不变（FR5.4） |
| LLM 可用、浏览器无法打开 | 降级为剪贴板 + 显示完整 URL（FR5.8） |
| **LLM 不可用** | 对话式澄清无法进行 → 明确提示，**无替代路径**（FR5.2，Q3=A） |

**FR5.2（已定稿，Q3=A）** LLM 不可用时**不做**静态表单兜底。反馈 tab 必须给出**明确、可操作的提示**，说明当前无法进行对话式反馈及原因（模型未配置 / 网络不可达 / 请求失败），并指出用户可以稍后重试。**不得**呈现一个卡住不动的输入框或静默失败——用户必须能区分「我的问题没被接受」和「功能当前不可用」。用户输入的内容在此时不得被丢弃（按 FR5.7 保留）。

**FR5.3（草稿暂存）** 草稿暂存于本地（`plugin.saveData`），记录 `{ title, body, type, createdAt, status }`。

> **与上一版的关键差异**：上一版把 outbox 设计成「提交失败后的重试队列」，在 Q2=D 下已不成立——插件没有提交动作，也就没有需要重试的提交。草稿暂存的唯一目的是**不丢失用户已经产生的输入**（用户写了一半天、LLM 挂了、tab 被关了、浏览器没打开成功），以及让用户随时回来把草稿重新送出去。因此不存在退避重试、不存在自动重放。

**FR5.4（检索失败与触限）** `search_github_issues` 因网络失败或未鉴权速率限制（403/429）不可用时：
- **跳过**去重步骤，继续生成草稿（去重是增益，不是前置门）
- 在会话中**明确告知**「未能检索已有 issue（原因）」，让用户知道去重这一步没跑
- **不**做退避重试循环：一次失败即降级，避免在用户等待澄清结果时叠加不可预期的延迟

**FR5.5（错误分类）** Q2=D 下插件不再与 GitHub 的写入接口交互，上一版的 401/403(权限)/404/422 分类随之失效，删除。保留并需要区分的是：
- 检索接口 403/429（未鉴权速率限制）→ 按 FR5.4 跳过去重
- 检索网络层异常（超时、DNS、TLS）→ 按 FR5.4 跳过去重
- 浏览器打开失败或被拦截 → 按 FR5.8 降级
- 正文超限 → 按 FR3.12 降级
- 用户在浏览器里看到 404 / Issues 已关闭 → 这是 GitHub 自己给出的清晰信号，插件侧只需在预览卡片上显示目标地址（FR3.7）即可让用户事先知情；不做额外预检（FR4.3）

**FR5.6（草稿生命周期）** 暂存的草稿需在插件重启后仍可读取；用户可查看、重新打开提交页、复制、删除；需设数量上限（超出时提示用户清理，而非静默丢弃最旧的）；草稿含用户输入内容，删除后不得残留。

**FR5.7（关闭未提交会话）** 用户关闭带有未完成草稿的反馈 tab 时，必须保留草稿（落 FR5.3 的暂存）而非静默丢弃；用户重新进入时能看到并继续。

**FR5.8（浏览器打开失败的降级）** 当无法打开浏览器页面（移动端 WebView 限制、弹窗被拦截、系统未注册默认浏览器）时：自动复制正文到剪贴板，并在会话中显示**完整可点击的目标 URL**，让用户手动打开。此时必须明确告知降级已发生，不得静默。

### FR6：隐私与安全

**FR6.1（提交前全文预览）** 草稿预览卡片必须展示将要送出的**全部内容**（标题 + 正文全文 + 类型），且用户可编辑（FR3.7）。这是内容透明化的实质，不是走形式的勾选框。

**FR6.2（公开可见警告）** 明确告知用户两件事，缺一不可：
1. 内容将出现在**公开仓库**，任何人都能看到，并会显示其 GitHub 用户名
2. **需要用户自己在 GitHub 页面点 Submit** 才会真正创建 issue；插件不会、也无法代为提交

**FR6.3（不主动采集 vault 内容）** 诊断信息只包含固定字段：插件版本、Obsidian 版本、操作系统/平台、当前 provider 类型、最近一次错误摘要。**不含**笔记内容、文件路径、vault 名称、API Key、对话历史全文。该白名单由 `get_plugin_diagnostics` 的工具签名强制（FR3.2a），不是靠提示词约束。

**FR6.4（privacyMode 联动）** 当设置中 `privacyMode` 为开启时，诊断信息**默认不附带**（覆盖 Q6=A 的默认值），用户需在预览中逐项显式勾选。此外 `feedback` 技能必须在提示词层面被告知不得把笔记/记忆内容写进 issue 正文，除非用户在本轮明确要求。

> Q8=A 已经把长期记忆与环境上下文的注入整体关掉（FR2.7），因此本条的残余风险面已经很小；保留它是为了覆盖「用户自己在对话里粘贴了笔记内容」这一类情况。

**FR6.5（不信任外部输入）** 从 GitHub 返回的内容（已有 issue 标题/正文、API 错误信息）在渲染进对话时按不可信内容处理，不得被当作指令执行（对齐 `corner-checklist.md` 的「AI and agent output → Untrusted content steering the model」）。

**FR6.6（用户输入的健壮性）** 用户可能在反馈里粘贴极长文本、含 Markdown/HTML/控制字符的内容。这些内容在渲染为 issue 正文、拼进 URL、写入剪贴板时必须保持原样且不破坏布局，不因特殊字符截断或损坏。特别地：拼 URL 时必须正确 percent-encode（含 `&`、`#`、`+`、换行），否则正文会被截断或篡改。

## 非功能性需求

**NFR1（移动端兼容）** 全部改动必须同时运行于桌面端与移动端（`manifest.json` `isDesktopOnly: false`）。不得引入 `child_process` 等 Node-only API。特别地：剪贴板写入与「打开外部 URL」两条路径都必须有移动端可用的实现——这是 Q2=D 下的**主路径**，不是可选优化。

**NFR2（包体）** `main.js` 产出仍须小于 5 MB，由现有 `test/bundle-size.test.ts` 继续守护。不引入新的 HTTP 客户端依赖——检索用 `requestUrl` 手写最小请求。

**NFR3（可测试性）** 新工具须可脱离 Obsidian 运行时单测：沿用现有 `web-search`/`web-clipper` 的 `deps` 注入模式（`requestUrl`/`wait` 可替换）。需要覆盖：
- 草稿渲染：模板字段齐全、字段缺失、超长文本、特殊字符（`&`/`#`/换行/emoji）
- URL 长度判定：ASCII / 中文 / 混合内容的膨胀差异，以及恰好落在阈值上下边界的用例（FR3.12）
- 去重检索：命中、无命中、触限降级（FR5.4）
- 草稿暂存：读写、上限、删除后无残留
- 模板同源校验（FR3.5）

**NFR4（国际化）** 全部新增用户可见文案走 `t()` 并补 `zh`/`en` 两份，不硬编码中文字符串。

**NFR5（可访问性）** 新增的头部按钮、草稿预览卡片、卡片上的动作按钮必须键盘可达、带 `aria-label`，状态不只靠颜色表达（对齐现有 `createHeaderActionButton` 的做法）。

**NFR6（不拖慢既有链路）** 新增技能与工具不得增加常规对话的每轮提示词体积：`feedback` 技能靠渐进披露（系统提示只增一行清单），新工具仅注册不注入系统提示。不得使 Guardian 快/深路径或普通对话的首 token 延迟产生可感知退化。

**NFR7（无凭据、无密钥）** 本功能不引入任何凭据、密钥或令牌；禁止硬编码任何敏感信息。这是一条可验证的属性，不只是原则（FR4.2）。

**NFR8（URL 长度阈值的实测校准）** FR3.12 的阈值常量 `T` 与「中文约 9×」的膨胀率都必须在实现阶段**用真机实测**校准（桌面端 Chrome/Electron + 移动端 iOS/Android WebView），不得仅凭估算写死。校准结果需记录在代码注释或设计文档中，并为其边界补测试。这是 Q2=D 下最容易被想当然对待、却直接决定中文用户主路径的一个参数。

## 约束

- **无后端、无凭据**：不得为 GitHub 交互引入服务端代理、中转服务或任何形式的令牌（Q2=D）。
- **插件不具备 GitHub 写入能力**：任何「自动提交 issue」「自动追加评论」的实现都超出本需求的既定范围；若用户后续要求，需先推翻 Q2=D。
- **复用既有网络通路**：只用 Obsidian `requestUrl`，与 `model-catalog-service`/`video-transcription`/`web-clipper` 保持一致。
- **不改动审批模型**：`needsApproval` 的既有语义保持不变（Q2=D 下安全边界在浏览器端，插件侧无需新增审批闸门）。
- **复用既有会话机制**：不新建独立的消息存储或流式渲染实现。
- **技能与工具的分工**：`feedback` 是 Skill（只提供行为指令），三个工具负责执行；**UI 动作（打开浏览器、写剪贴板）归 UI 层，不放进工具**（FR3.2）。
- **模板字段契约来自仓库文件**：`.github/ISSUE_TEMPLATE/*.yml` 是唯一事实来源，插件侧字段清单必须与其同源可校验。

## 假设

- **[assumption]** A1：`https://github.com/<owner>/<repo>/issues/new?title=...&body=...` 会采用 URL 中的正文，且**不会**套用仓库的 ISSUE_TEMPLATE。这决定了 FR3.4 必须由插件本地渲染正文。**验证方式**：实现阶段用一条中文正文的草稿实测，比对 GitHub 页面上出现的正文。**归属**：开发阶段。
- **[assumption]** A2：目标仓库 `yinfi/baizer` 的 Issues 保持开启，且未设置禁止非协作者建 issue 的规则。若不成立，用户在浏览器里会直接看到 GitHub 的提示（FR5.5）。**归属**：开发阶段。
- **[assumption]** A3：非协作者创建 issue 时 `labels` 会被**静默丢弃**（GitHub 文档：仅具 push 权限者可设置标签），URL 的 `?labels=` 同样不可靠。这决定了 FR3.10 的标题前缀兜底。**验证方式**：用非协作者账号建一条 issue，检查标签是否生效。**归属**：开发阶段。
- **[assumption]** A4：用户在公开仓库建 issue 时会公开自己的 GitHub 用户名。这是 FR6.2 警告文案的事实基础，属于平台固有行为而非本功能引入，但必须在提交前告知。
- **[assumption]** A5：GitHub 公开搜索接口在未鉴权下可用，其速率限制对本功能的人-paced 使用量足够。**验证方式**：实现阶段实测连续检索的触限行为，并确认 FR5.4 的降级路径确实生效。**归属**：开发阶段。
- **[assumption]** A6：本阶段只确定「模板字段必须等价」这一行为要求，正文的具体措辞、字段顺序、模板版本如何随仓库演进，留给 Functional Design 阶段设计；本阶段不预设实现细节。
- **[assumption]** A7：`chatStream` 透出 `forcedSkillName`、以及 `BaseChatRuntime` 增加「跳过记忆注入」通路的具体形态（新增可选参数 / 新增请求字段 / 其他）留给设计阶段决定；本阶段只要求 FR2.2 与 FR2.7 两项行为成立。

## 范围外

- **不做任何形式的 GitHub 写入**：不自动建 issue、不自动追加评论、不自动打标签（这是 Q2=D 的直接结果，见 FR3.13）。
- **不做崩溃自动上报（telemetry / 无感上报）**：本功能的每一次对外动作都由用户主动发起并在浏览器中亲手确认，不存在后台自动提交路径。
- **不做反馈的统计分析、看板、趋势**。
- **不做 issue 状态回写**：不把 GitHub 上 issue 的进展同步回插件、不做插件内 issue 列表、不做 issue 评论的双向同步。插件也无法感知提交结果（FR3.8）。
- **不做多仓库路由**：目标仓库硬编码（Q4=A）。
- **不做目标仓库的配置项与「测试连接」**（Q4=A 与 FR4.3 的直接结果）。
- **不替换或改造既有的 👍/👎**（Q7=B）：现有 `recordPositiveFeedback`（file-back 归档）与 `recordNegativeFeedback`（写记忆 + 当场重答）语义保持不变，本需求不碰这两条链路。
- **不把反馈提交到 Multica 或其他平台**：目标通道只有 GitHub。
- **不做安全漏洞的公开上报路径**：按 FR3.11 引导至私密通道。
- **不做 OAuth App 的注册与维护**：Q2=D 已排除需要 client_id 的方案。
- **不做 LLM 不可用时的表单兜底**（Q3=A）。

## 开放问题

- **[Q3 衍生]** Q3=A 意味着「模型挂了就完全无法反馈」。这是用户的明确选择，但值得在设计阶段确认提示文案足够清楚，避免用户误以为是插件的 bug。若后续发现该缺口影响面大，可单独提一个 intent 补表单兜底。
- **[FR3.13 衍生]** 「追加评论」的手动降级形态是否被用户接受，是本次唯一需要推导的地方；若被否决，Q2 需回到 A/B/C，本文的 FR3.8/FR3.12/FR3.13/FR4 需再次改写。
- **[FR6.3 衍生]** 诊断信息「最近一次错误摘要」的来源与截断策略需要在设计阶段明确——错误信息可能包含文件路径，与 FR6.3 的「不含文件路径」存在张力。
- **[FR3.12 衍生]** 阈值 `T` 与膨胀率的实测校准（NFR8）可能得出比 6000 更保守的值，从而让剪贴板成为绝大多数中文反馈的实际路径。若真如此，设计阶段应重新评估是否把剪贴板提升为默认路径、URL 预填降为优化——这是一个需要在有实测数据后再定的产品判断。
- **[FR2.7 衍生]** 「跳过记忆注入」是一条新增通路，需在设计阶段确认它不会影响普通对话的记忆行为（应为反馈会话专属开关，而非全局改动）。

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
| FR2.8 | 会话持久化 + 用户手动终态 | Should | 已定稿 | — | — | — |
| FR3.1 | 工具 `search_github_issues`（未鉴权） | Must | 已定稿 | — | — | — |
| FR3.2 | 工具 `prepare_github_issue_draft`（纯函数） | Must | 已定稿 | — | — | — |
| FR3.2a | 工具 `get_plugin_diagnostics`（只读白名单） | Must | 已定稿 | — | — | — |
| FR3.3 | 目标仓库硬编码 `yinfi/baizer`（Q4=A） | Must | 已定稿 | — | — | — |
| FR3.4 | 模板字段等价的正文渲染 | Must | 已定稿 | — | — | — |
| FR3.5 | 模板同源校验测试 | Must | 已定稿 | — | — | — |
| FR3.6 | 生成草稿前去重检索（Q5=A） | Must | 已定稿 | — | — | — |
| FR3.7 | 草稿预览卡片（可编辑、可取消诊断项） | Must | 已定稿 | — | — | — |
| FR3.8 | 提交结果不可感知 + 用户手动标记 | Must | 已定稿 | — | — | — |
| FR3.9 | 两条送出路径（URL / 剪贴板）始终并存 | Must | 已定稿 | — | — | — |
| FR3.10 | 标题类型前缀兜底 | Should | 已定稿 | — | — | — |
| FR3.11 | 安全漏洞改走私密通道 | Must | 已定稿 | — | — | — |
| FR3.12 | URL 长度阈值与降级（Q2=D 推导） | Must | 已定稿 | — | — | — |
| FR3.13 | 零凭据下的「追加评论」手动形态（Q2=D 推导，可否决） | Must | 已定稿 | — | — | — |
| FR4.1 | 设置页 `feedback` 分区（开关 + 只读地址） | Must | 已定稿 | — | — | — |
| FR4.2 | 不采集/不存储任何凭据（Q2=D 推导） | Must | 已定稿 | — | — | — |
| FR4.3 | ~~「测试连接」动作~~ **已删除**（无凭据可测） | — | 已删除 | — | — | — |
| FR4.4 | 功能默认开启（Q2=D 推导，可否决） | Must | 已定稿 | — | — | — |
| FR4.5 | 不使用任何 GitHub 凭据（Q2=D） | Must | **已定稿** | — | — | — |
| FR5.1 | 降级路径总览 | Must | 已定稿 | — | — | — |
| FR5.2 | LLM 不可用：明确提示，无兜底（Q3=A） | Must | **已定稿** | — | — | — |
| FR5.3 | 草稿暂存（非重试队列，Q2=D 改写） | Must | 已定稿 | — | — | — |
| FR5.4 | 检索失败/触限：跳过去重并明示 | Must | 已定稿 | — | — | — |
| FR5.5 | 错误分类（已删除 Token 相关分支） | Must | 已定稿 | — | — | — |
| FR5.6 | 草稿生命周期管理 | Should | 已定稿 | — | — | — |
| FR5.7 | 关闭会话保留草稿 | Must | 已定稿 | — | — | — |
| FR5.8 | 浏览器打开失败 → 剪贴板 + 显示 URL | Must | 已定稿 | — | — | — |
| FR6.1 | 提交前全文预览（可编辑） | Must | 已定稿 | — | — | — |
| FR6.2 | 公开可见警告 + 「需你自己点 Submit」 | Must | 已定稿 | — | — | — |
| FR6.3 | 诊断信息字段白名单（工具签名强制） | Must | 已定稿 | — | — | — |
| FR6.4 | privacyMode 联动 | Must | 已定稿 | — | — | — |
| FR6.5 | 外部内容按不可信处理 | Must | 已定稿 | — | — | — |
| FR6.6 | 特殊字符/超长文本健壮性（含 URL encode） | Must | 已定稿 | — | — | — |
| NFR1 | 移动端兼容（剪贴板/开外链为主路径） | Must | 已定稿 | — | — | — |
| NFR2 | 包体 < 5 MB | Must | 已定稿 | — | — | — |
| NFR3 | 工具可单测（deps 注入） | Must | 已定稿 | — | — | — |
| NFR4 | 国际化 | Must | 已定稿 | — | — | — |
| NFR5 | 可访问性 | Should | 已定稿 | — | — | — |
| NFR6 | 不拖慢既有链路 | Must | 已定稿 | — | — | — |
| NFR7 | 无凭据、无密钥 | Must | 已定稿 | — | — | — |
| NFR8 | URL 长度阈值实测校准 | Must | 已定稿 | — | — | — |

> Design Ref / Unit Ref / Test Ref 留空是有意的：本阶段只产出需求，列留空即代表「尚未设计／尚未分配／尚未覆盖」的缺口，由后续阶段逐格填上。
