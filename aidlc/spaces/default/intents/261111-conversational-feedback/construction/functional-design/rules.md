# 业务规则 —— 对话式反馈：与智能体澄清后提交 GitHub Issue

## 范围与来源

来源：`requirements.md` FR1–FR6 / NFR1–NFR8；`entities.md` 的实体与值对象定义；`functional-design-questions.md` 的 12 项回答。

规则按关注点分九组：会话与上下文隔离（BR1）、澄清（BR2）、载荷与模板同源（BR3）、提交前确认与幂等（BR4）、失败与降级（BR5）、凭据与读隔离（BR6）、诊断与外部输入（BR7）、设置（BR8）、凭据轮换（BR9）。

```yaml
rules:
  - id: BR1.1
    statement: >
      四个反馈工具（search_github_issues / get_plugin_diagnostics /
      create_github_issue / add_issue_comment）声明
      visibility = 'feedback-session'，**只在反馈会话的工具集里出现**；反馈会话
      内部再以 feedback 技能声明的子集收窄（子集 = 这四个 + 元能力 read_skill），
      该子集刻意不含任何 vault 读工具——反馈会话从能力上就没有读取用户笔记的路径。
      「反馈会话工具收窄」与「工具全局可见」是两件事，不可互相替代：前者约束
      反馈会话内给什么，后者约束非反馈会话里能不能看到。
      **技能解析不到（不存在或被用户禁用）是一条独立的、fail-closed 的分支**：
      此时工具集**不得**退回全量，只能是四个反馈工具 ∪ {read_skill}，且本轮不
      发起模型调用。
    category: constraint
    applies_to: 反馈会话（kind = feedback 的会话）, ToolRegistry
    trigger: 每一轮组装工具集时（prepareTurn / getTools）
    logic: >
      IF 本轮的会话不是反馈会话
      THEN 工具集不含这四个工具（模型看不到它们，而不是「看得到但被拒」）；
           检索类 search_github_issues 的免批边界即由此确定——它只可能在反馈
           会话内被调用
           AND 走既有技能解析路径，行为不变
      ELSE IF 会话是反馈会话 且 activateSkill("feedback") 解析成功
      THEN 工具集 = 该技能声明的 tools ∪ {read_skill}
      ELSE （会话是反馈会话 但 activateSkill("feedback") 返回 null：技能不存在，
            或被用户在设置里禁用——内置技能在设置页有逐项开关，写的是
            settings.disabledSkills）
      THEN 工具集 = 四个反馈工具 ∪ {read_skill}，**绝不退回全量工具集**
           AND 本轮不发起模型调用，在反馈 tab 内给出明确提示
               「反馈功能当前不可用：feedback 技能已被禁用」并指向设置页的启用入口
           （不发起调用的理由：SKILL.md 承载着若干提示词层的安全规则——不主动
             索要联系方式、安全漏洞改道、不把笔记内容写进正文。带着工具却没有
             这些指令跑一轮，等于把安全规则换成了「模型自己看着办」。）
    violation_behaviour: >
      两条通路都会打穿 FR2.7 的隔离承诺：其一，若四个工具对每个会话可见，它们会在
      普通对话、Guardian、选区菜单、知识编译等路径上被调用，而工作流 3 依赖的澄清
      字段、诊断快照、去重选择在这些上下文里都不存在，FeedbackDraft.sourceConversationId
      也会指向一个非反馈会话；其二，若技能解析不到时退回全量工具集，反馈会话会拿到
      全部 vault 读工具，模型可读用户笔记并把这些内容写进一条公开发布的 issue——
      而触发条件只是用户在设置页点一下禁用开关，且**完全静默**
    source: FR2.2, FR2.6

  - id: BR1.2
    statement: >
      反馈会话是干净会话：既不注入长期记忆召回与 Mental Model 块，也不注入
      当前笔记/反链等环境上下文。该隔离由会话级的显式开关驱动，只对声明为
      反馈会话的会话生效，普通对话的上下文与记忆行为一字不改。
      「哪些会话是反馈会话」由 BR1.6 的 kind 标记唯一决定，不靠 UI 调用点自觉。
      开关必须在 `ChatTurnRequest` 与 `PreparedChatTurn` **两处**都存在——
      BR1.3 的 retain 短路发生在 `HarnessChatRuntime` 里，它拿到的是
      `PreparedChatTurn`；只在请求侧加字段会在透传链上断掉一环。
    category: policy
    applies_to: 反馈会话
    trigger: 反馈会话的每一轮准备（prepareTurn）
    logic: >
      IF 本轮请求的 isolatedContext 为真
      THEN 跳过 memoryManager.ready() / recallForPrompt() / getMentalModelBlock()，
           memoryContext 与 mentalModelBlock 均为空
           AND 从 contextItems 中剔除环境上下文项（active-note: / backlinks: 前缀），
               且不附加环境上下文的定性说明
      ELSE 保持既有行为（memoryManager 存在时无条件注入这两项）
    violation_behaviour: 隔离漏掉任一侧，用户个人偏好或笔记内容都可能经提示词进入公开 issue；而这类泄漏不可逆
    source: FR2.7, Q1

  - id: BR1.3
    statement: >
      反馈会话不写入长期记忆：不调用 retainCompletedTurn，反馈对话内容不进
      Hindsight。即反馈会话对记忆系统既不读也不写。
    category: policy
    applies_to: 反馈会话
    trigger: 反馈会话一轮完成
    logic: >
      IF 本轮属于反馈会话 THEN 跳过 retainCompletedTurn ELSE 保持既有行为
    violation_behaviour: 写入会让一次性的报障对话污染后续普通对话的召回，并使反馈内容经记忆回流到不受 BR1.2 约束的链路
    source: FR2.7 衍生, Q3（可否决）

  - id: BR1.4
    statement: >
      关闭带有未提交草稿的反馈 tab 不得丢弃用户已输入的内容：会话记录按既有
      会话持久化机制落 vault，草稿记录落在插件数据里，重新打开该 tab 时两者
      都可恢复并继续。
    category: policy
    applies_to: 反馈会话, FeedbackDraft
    trigger: 用户关闭反馈 tab（或插件重启）
    logic: >
      IF 该会话存在 status ∈ {draft, awaiting_confirmation, failed} 的草稿
      THEN 保留草稿记录与会话记录，不做任何删除或截断
           AND 用户重新进入时能看到草稿与未完成的对话
      ELSE 按既有 tab 关闭语义处理
    violation_behaviour: 静默丢弃用户唯一一次认真写的报障内容
    source: FR1.5, FR5.7

  - id: BR1.5
    statement: >
      LLM 不可用时给出明确、可区分的提示（模型未配置 / 网络不可达 / 请求失败），
      指出可稍后重试，且不呈现一个必然失败的输入框。用户已输入的内容不得丢弃。
      本功能不做静态表单兜底。
    category: policy
    applies_to: 反馈会话
    trigger: 反馈会话的模型调用失败或模型未配置
    logic: >
      IF 模型不可用
      THEN 在反馈 tab 内显示明确原因与可操作提示
           AND 保留用户已输入内容（BR1.4）
           AND 不展示任何替代表单
    violation_behaviour: 呈现卡住不动的输入框或静默失败，使用户无法区分「我的问题没被接受」与「功能当前不可用」
    source: FR5.2, Q3=A

  - id: BR1.6
    statement: >
      「这个会话是反馈会话」这一个事实由会话记录上的 kind 字段承载
      （TabData / ConversationSnapshot 的 kind: 'chat' | 'feedback'，缺失即
      'chat'）。它随会话快照一起持久化与恢复，不另建登记表；BR1.1 的工具可见
      范围、BR1.2 的隔离开关、tab 上的反馈标识都从这一个事实派生。此外工具
      执行期有一道兜底：ToolContext 携带 conversationId，写入工具在草稿的
      sourceConversationId 与它不一致（或它缺失）时拒绝执行。
    category: constraint
    applies_to: TabData, ConversationSnapshot, TabBarItem, ToolContext
    trigger: 创建 / 保存 / 恢复反馈 tab；工具执行时
    logic: >
      写入点：ConversationController.saveActiveTab 把 tab.kind 写进 snapshot
      恢复点：createTabData(snapshot) 把 snapshot.kind 还原到 TabData；
              TabBarItem 由 shell 在构建时填入该字段
      执行期兜底：IF ctx.conversationId 缺失，或同 dedupKey 的草稿其
              sourceConversationId ≠ ctx.conversationId
              THEN 拒绝，不发起网络请求
    violation_behaviour: 若只靠内存里的 tab 集合，重启后恢复的反馈会话不再是反馈会话——工具集变回全量（BR1.2 的隔离随之失效），用户也无法继续未完成的反馈
    source: FR2.8, FR5.7

  - id: BR2.1
    statement: >
      澄清遵循最少轮次原则：能从对话或已有信息推断的字段不得重复追问；用户
      明确表示「直接提交」「不用再问了」时，立即停止追问，用已有信息生成草稿
      并进入确认流程。必问字段为问题类型、现象、期望行为、复现步骤、影响范围、
      是否已尝试绕过，且仅在该字段无法从已有信息推断时追问。
    category: policy
    applies_to: 反馈会话
    trigger: 智能体准备下一轮提问前
    logic: >
      IF 某个必问字段已能从对话历史、用户描述或诊断信息推断
      THEN 不得就该字段提问，直接采用推断值
      IF 用户表达「直接提交」/「不用再问了」/等价措辞
      THEN 立即停止追问，用已有信息生成草稿并进入 BR4.1 的确认流程
    violation_behaviour: 把澄清变成审讯，用户在中途放弃——本功能要解决的正是「用户懒得写清复现步骤」，多问一轮就多一分流失
    source: FR2.4

  - id: BR2.2
    statement: >
      生成草稿前必须先经 search_github_issues 检索是否已有相同问题。命中候选时
      必须向用户展示候选列表，由用户在「追加评论到已有 issue」与「仍然新建」
      之间选择。智能体不得替用户判定两个问题是否同一个。
    category: policy
    applies_to: 反馈会话, FeedbackDraft
    trigger: 智能体即将生成草稿
    logic: >
      IF 检索返回候选
      THEN 展示候选（编号/标题/状态/链接）并等待用户选择
           IF 用户选择追加评论 THEN 生成 kind = issue_comment 的草稿
           IF 用户选择仍新建   THEN 生成 kind = new_issue 的草稿
      ELSE 直接生成 kind = new_issue 的草稿
    violation_behaviour: 替用户判定同一性会导致「用户的补充信息被塞进一个不相关的 issue」或「重复 issue」，两者都比多问一句更贵
    source: FR2.5, FR3.6, Q5=A

  - id: BR2.3
    statement: >
      澄清过程中一旦识别为安全漏洞，不得经本功能提交公开 issue，改为引导用户
      走 SECURITY.md / GitHub Security Advisory 私密上报，并给出私密上报入口。
    category: policy
    applies_to: 反馈会话
    trigger: 澄清过程中识别出安全漏洞特征
    logic: >
      IF 问题被识别为安全漏洞
      THEN 不调用 create_github_issue / add_issue_comment
           AND 向用户说明本通道会公开、给出私密上报入口
      ELSE 正常流程
    violation_behaviour: 把漏洞细节公开在一个所有用户都能看到的 issue 里，且无法撤回
    source: FR3.11

  - id: BR3.1
    statement: >
      issue 正文必须由插件本地按仓库模板字段渲染成等价 Markdown——GitHub 的
      ISSUE_TEMPLATE 只作用于 Web 表单，REST 写入不会自动套用模板。缺陷类正文
      须覆盖 What happened / Steps to reproduce / Baizer version / Obsidian
      version / Platform / Provider / Where it happened / Console output
      （缺失项显式写「无」）；需求类正文须覆盖 The problem / What you have in
      mind / How you handle it today / Which part of Baizer。
    category: calculation
    applies_to: IssuePayload 渲染
    trigger: 首次调用 create_github_issue（未获确认的那一次）
    logic: >
      IF 类型为 bug
      THEN 按缺陷类字段清单与小节顺序渲染
      ELSE IF 类型为 enhancement
      THEN 按需求类字段清单与小节顺序渲染
      渲染是确定性的：同一组澄清字段 + 同一份诊断信息 ⇒ 逐字节相同的正文
    violation_behaviour: 渲染出的正文缺少模板字段，issue 变成一句「XX 不好使」，无法定位
    source: FR3.4

  - id: BR3.2
    statement: >
      插件侧的字段清单、dropdown 选项取值与 label 取值必须与
      .github/ISSUE_TEMPLATE/*.yml 同源，并由自动化测试锁定：仓库模板增删字段、
      增删 dropdown 选项或改标签时，该测试必须失败。**只比对字段 id 不比对选项
      取值等于没锁**——dropdown 的合法取值就是模板的全部信息量，写错一个选项
      不会被 id 比对发现。
    category: constraint
    applies_to: 正文渲染实现, label 映射, provider 映射表
    trigger: 运行测试套件
    logic: >
      FOR EACH 模板文件
        IF 模板可填字段的 id 集合 ≠ 插件字段清单
           或 模板 dropdown 的选项取值集合 ≠ 插件映射表的值域
           或 模板 labels ≠ 插件 label 映射
        THEN 测试失败
      另断言映射表对 providerType 的每个枚举值有且仅有一条规则（穷尽性）
    violation_behaviour: 模板改了、插件没跟上，issue 结构静默漂移且无人察觉；只比 id 时连选项写错都发现不了
    source: FR3.5, FR3.10

  - id: BR3.3
    statement: >
      标题单行化：写入标题的换行折叠为空格。正文逐字节保真：不做 Markdown
      转义、不折叠换行、不因 & / # / emoji / 控制字符等特殊字符截断或损坏。
    category: validation
    applies_to: IssuePayload
    trigger: 渲染与提交时
    logic: >
      IF 字段是 title THEN 换行替换为单个空格
      IF 字段是 body   THEN 原样传输（经 JSON 编码，不做任何内容层改写）
    violation_behaviour: 正文被截断或转义破坏，用户看到的内容与发布的内容不一致——而这是不可撤销的
    source: FR6.6

  - id: BR3.4
    statement: >
      类型只用 labels 表达（bug → ["bug"]，enhancement → ["enhancement"]），
      不使用 [Bug] / [Feature] 标题前缀。
    category: policy
    applies_to: IssuePayload, FeedbackDraft
    trigger: 渲染 label 时
    logic: >
      IF type = bug THEN labels = ["bug"]
      IF type = enhancement THEN labels = ["enhancement"]
      标题不加类型前缀
    violation_behaviour: 标题前缀污染 issue 列表，且成为第二处需要与模板同源的契约
    source: FR3.10, Q8（A4 在本场景不成立：token 属仓库所有者）

  - id: BR4.1
    statement: >
      create_github_issue 与 add_issue_comment 在未获用户确认时必须返回审批
      响应，且该确认**不受 confirmExecutions 设置关闭的影响**，无条件走审批路径。
      实现位于这两个工具内部：它们不调用 needsApproval()，因此 needsApproval()
      的语义与所有其他工具的行为都不变。
    category: authorization
    applies_to: create_github_issue, add_issue_comment
    trigger: 工具被调用且 args.approved 不为真
    logic: >
      IF args.approved 为真 THEN 进入提交执行（BR4.4）
      ELSE 返回 approval_required 响应，携带完整 IssuePayload 与 requestId
           （不看 confirmExecutions 的值）
    violation_behaviour: 若改为复用 needsApproval()，则用户关闭 confirmExecutions 后会在公开仓库留下未经确认的不可撤销记录——该设置授权的是「改动你自己的 vault」，不是「以你的名义公开发帖」
    source: FR3.7

  - id: BR4.2
    statement: >
      审批卡片必须展示将要公开的全部字节（标题 + 正文全文 + 类型；追加评论时为
      完整评论正文），且标题与正文可在卡片上就地编辑。编辑值写回审批请求的 args
      （随消息快照持久化），执行时以 args 为唯一来源——卡片展示的字节与提交的
      字节必须同源。
    category: constraint
    applies_to: 审批卡片（external-publish 预览）
    trigger: 渲染审批卡片 / 用户编辑 / 用户点击批准
    logic: >
      IF 预览类型为 external-publish
      THEN 渲染标题（new_issue）与正文为可编辑控件
           AND 用户编辑即写回 request.args.title / request.args.body
           AND 批准时以 request.args 的当前值执行
      ELSE 渲染路径与行为完全不变（只读）
    violation_behaviour: 若允许提交路径重新渲染正文，用户在卡片上的编辑会被静默覆盖——用户以为他发的是自己改过的版本，实际发的是模型渲染的版本
    source: FR6.1

  - id: BR4.3
    statement: >
      审批卡片必须同时告知三件事，缺一不可：内容将出现在公开仓库、任何人都能
      看到；所有 issue 都以发布方账号发出、不显示提交者身份，因此若希望被追问
      需在正文里留下联系方式，而留下联系方式即等于公开它；创建后无法由插件撤回。
    category: policy
    applies_to: 审批卡片
    trigger: 渲染审批卡片
    logic: >
      IF 预览类型为 external-publish
      THEN 卡片上同时呈现上述三条
      AND 因本确认不受 confirmExecutions 影响（BR4.1），文案须解释「即使你已关闭执行确认，本操作仍需确认」的理由
    violation_behaviour: 用户在不理解「以发布方账号发出」的情况下提交，事后无法从 issue 追问提交者；或在不理解「留下即公开」的情况下写入联系方式
    source: FR6.2

  - id: BR4.4
    statement: >
      提交幂等分三层，全部落在**真实提交路径**上（`performApprovedAction` →
      `toolRegistry.execute`，该路径不读 risk / executionMode，所以保护必须在
      工具内部实现）：
      ① requestId 层——同一张审批卡重复点击由 ApprovalExecutionRegistry 去重；
      ② dedupKey 跨卡片层——同内容的第二次渲染不新建草稿，而是复用 dedupKey
      匹配到的既有草稿并返回同一份载荷，因此不存在两张内容相同的卡片；
      ③ 提交前的同步原子认领——在发出任何 await 之前把草稿从非 submitting 置为
      submitting，已有 submitting / submitted 则立即拒绝。
      **③ 的成立前提必须写死，否则它形同虚设**：草稿集合必须是**进程内共享的
      同一份内存对象**（插件单实例，草稿存储以模块级/插件级单例持有，不是每次
      执行都重新读盘），且「读 status → 判 → 写 status」必须在**同一个同步块**内
      完成——一旦中间插入任何 `await`（例如先 `await loadDrafts()`），两次并发
      批准就又都能通过，窗口原样打开。
      **③ 是冗余层，不是主保障**：② 已保证同 dedupKey 至多存在一张卡片，③ 只是
      再挡一次「同一张草稿被同时批准两次」的极端交错。不得把 ③ 当作主要并发保护
      来陈述——它的作用面严格小于 ②。
    category: constraint
    applies_to: FeedbackDraft, 提交执行, 渲染
    trigger: 渲染草稿时 / 提交执行前
    logic: >
      渲染时（工作流 3 步骤 2c）：按 dedupKey 匹配已有草稿
        IF 命中且 status = submitted
        THEN 直接回显既有结果，不进入确认流程、不新建
        IF 命中且 status ∈ {draft, awaiting_confirmation, submitting}
        THEN 复用该草稿（更新其载荷），不新建
        ELSE 新建草稿
      提交时（工作流 4 步骤 3a）：
        IF 同 dedupKey 且 status = submitted THEN 拒绝，回显既有结果
        IF 同 dedupKey 且 status = submitting THEN 拒绝（并发提交）
        ELSE 在同一个同步块内（此前不得有任何 await）把 status 置为 submitting，
             之后才允许发起网络请求
    violation_behaviour: 用户连点、网络重试或队列重放产生重复 issue，污染仓库且无法批量撤回；若把保护寄望于「write ⇒ 串行执行」，那条链路根本不在提交路径上，等于没有保护；若 ③ 的读—判—写之间插入了 await，它挡不住任何东西，却会让人以为并发已被处理
    source: FR3.8, FR3.6

  - id: BR4.5
    statement: >
      只有拿到 GitHub API 的成功响应（HTTP 2xx 且返回编号）才允许声称提交成功、
      回显编号与链接，并把该反馈会话置为终态。插件不得在任何其他情况下声称
      「已提交」。**终态标识从草稿派生**（sourceConversationId = 该 tab id 且
      status = submitted），不在会话快照上另存一份编号/链接——两处真相会在
      「提交成功但快照未落盘」时不一致，而其中一处正是给用户看的那个。
    category: constraint
    applies_to: FeedbackDraft, 反馈会话
    trigger: 提交执行返回时 / 渲染 tab 栏时
    logic: >
      IF 响应为 2xx 且含 issue number
      THEN status = submitted，记录编号与链接，回显可点击链接
           AND tab 栏的终态标识由草稿派生（只读投影，不写快照）
      ELSE 走 BR5.1 的错误分类，不得回显任何编号，也不得置终态
    violation_behaviour: 声称成功而实际没有提交，用户以为问题已上报而不再跟进——这是本功能最坏的失败模式
    source: FR3.9, FR2.8

  - id: BR5.1
    statement: >
      失败必须分类，且每一类的用户可见提示不同、可操作：
      401 → 内置凭据已失效（通常意味着发布方已轮换但用户未升级），提示升级插件；
      403 → 权限不足（token 缺少 Issues: write）或触发限流（带 Retry-After 的走 BR5.2）；
      404 → 目标仓库不存在或 Issues 已关闭；
      422 → 提交内容被仓库规则拒绝，回显仓库返回的具体报错；
      网络层异常（超时/DNS/TLS）→ 归入暂存队列。
    category: policy
    applies_to: 提交执行
    trigger: GitHub API 返回非 2xx，或请求抛出网络层异常
    logic: >
      IF httpStatus = 401 THEN 提示「内置凭据已失效，请升级插件」
      ELSE IF httpStatus = 403 且带 Retry-After THEN 走 BR5.2
      ELSE IF httpStatus = 403 THEN 提示权限不足
      ELSE IF httpStatus = 404 THEN 提示目标仓库不可用
      ELSE IF httpStatus = 422 THEN 回显仓库的具体报错
      ELSE （网络层）落暂存队列
    violation_behaviour: 把所有失败归成一句「提交失败」，用户与发布方都无法判断该做什么
    source: FR5.5

  - id: BR5.2
    statement: >
      提交遇 403/429 且响应带 Retry-After 时，按该值退避重试，重试次数有上限
      并加入抖动（避免多用户同时重试形成同步冲击）；超限转为暂存并明确告知
      「已被限流，稍后重试」。不得无限重试。检索接口触限时不进退避循环——
      直接跳过去重并明示，避免在用户等待澄清结果时叠加不可预期延迟。
    category: policy
    applies_to: 提交执行, 去重检索
    trigger: 403/429 且带 Retry-After
    logic: >
      IF 是提交请求 且 attempts < 上限
      THEN 按 Retry-After + 抖动等待后重试，attempts 自增
      ELSE IF 是提交请求 且 attempts ≥ 上限
      THEN 转暂存队列并明确告知
      IF 是检索请求 THEN 不重试，跳过去重并明示「未做重复检查」
    violation_behaviour: 无限重试会让用户面对一个永不返回的等待；检索侧退避会让澄清结果的出现时间不可预期
    source: FR5.4

  - id: BR5.3
    statement: >
      提交失败的内容落本地暂存（草稿 status = failed），提示「已暂存，可稍后
      重试」并提供手动重试入口，不得静默失败。插件重启后仍可读取并重试；重试
      受 dedupKey 约束；用户可查看、重试、删除暂存项。
    category: policy
    applies_to: FeedbackDraft
    trigger: 提交失败（网络层、退避超限、凭据失效）
    logic: >
      IF 提交失败
      THEN status = failed，记录 lastError（已脱敏），提示用户并提供重试/删除入口
      重试：status → submitting → 按 BR4.4 校验 dedupKey → 重新提交
    violation_behaviour: 用户辛苦澄清的内容在一次网络抖动后消失
    source: FR5.3

  - id: BR5.4
    statement: >
      未提交草稿总数上限 20。达上限时拒绝创建新草稿并提示用户清理，提供清理
      入口；不得静默丢弃最旧的。成功提交的草稿不计入上限，可被裁剪。
    category: constraint
    applies_to: FeedbackDraft 集合
    trigger: 创建新草稿时
    logic: >
      IF status ∈ {draft, awaiting_confirmation, failed} 的草稿数 ≥ 20
      THEN 拒绝创建，提示用户清理，给出草稿列表入口
      ELSE 正常创建
    violation_behaviour: 无上限会让插件数据无界增长；静默丢弃最旧的会丢掉用户唯一一次认真写的报障内容
    source: FR5.6, Q11

  - id: BR5.5
    statement: >
      内置凭据缺失或为空时，反馈功能给出「未配置」的明确提示，且不呈现一个
      必然失败的确认流程。该状态必须在设置页的凭据状态上可见（只读，仅显示
      「已内置」/「未配置」）。
    category: policy
    applies_to: 反馈会话, 设置页
    trigger: 发起反馈会话或渲染设置页时
    logic: >
      IF 注入的 token 为空
      THEN 反馈会话提示「反馈功能未配置」，设置页凭据状态显示「未配置」
      ELSE 正常流程，设置页显示「已内置」
    violation_behaviour: 用户走完澄清、点下确认，才在最后一步拿到 401
    source: FR4.2, FR5.5

  - id: BR6.1
    statement: >
      token 只能经构建期环境变量（BAIZER_FEEDBACK_TOKEN）注入 bundle。仓库的
      **任何提交**中都不得出现 token 字面量；CI 与发布流水线必须扫**提交范围**
      而不是工作树——「先提交 token、再在同一 PR 里删掉」终态是干净的，但 token
      已进历史，GitHub 的 secret scanning 一样会撤销它。CI 扫本次变更范围
      （base..HEAD），发布扫全量历史；两份 workflow 调用**同一个脚本**
      （`scripts/guard-credentials.sh`），不各抄一份。正则以真实凭据格式的长度
      为准（`github_pat_` / `gh[pousr]_` 前缀后 ≥30 字符），因此低于真实长度的
      合成 fixture 永不误报，守卫不需要白名单。.gitignore 必须覆盖 .env 及其变体。
    category: constraint
    applies_to: 构建与 CI
    trigger: 每次 CI 运行、每次发布
    logic: >
      IF 本次变更范围的 diff 文本中命中凭据模式（**含被删除的行**——被删掉的
         token 说明它进过历史）
      THEN CI 失败并阻断合并
      IF 全量历史的 diff 文本中命中 THEN 发布失败
      base 不可解析（新分支的 push 事件 / 浅克隆）时退回全量历史——宁可多扫，
        不可漏扫；扫描本身出错时同样失败，不得把「读不到历史」当成「干净」
    violation_behaviour: token 一旦进入 git，GitHub 的 secret scanning 会自动撤销它，且现象是「所有用户静默 401」——无人干预也会挂，极难定位
    source: FR4.2, NFR7；编排层要求（返工后口径）

  - id: BR6.2
    statement: >
      发布路径在 token 缺失时必须构建失败（不得静默发布一个反馈功能不可用的
      版本）；本地 npm run build 允许通过但必须输出明确警告；运行时按 BR5.5
      给出「未配置」。发布前还必须做一次凭据探活（GET /repos/yinfi/baizer），
      非 2xx 即阻断发布。
    category: policy
    applies_to: release.yml, 本地构建, 运行时
    trigger: 发布流水线 / 本地构建 / 插件加载
    logic: >
      IF 发布路径 且 token 为空 THEN 构建失败
      IF 发布路径 且 探活非 2xx THEN 发布失败
      IF 本地构建 且 token 为空 THEN 构建通过 + 输出警告
      IF 运行时 且 token 为空 THEN 提示「未配置」
    violation_behaviour: 发布一个凭据已死或未配置的版本，所有用户的反馈功能静默失效，且要等下一轮发布才能修
    source: FR4.2, FR4.6 衍生, Q9（探活为设计新增，可否决）

  - id: BR6.3
    statement: >
      token 不得出现在日志（任何级别）、错误信息与堆栈、get_plugin_diagnostics
      的返回、草稿内容、issue 正文、设置页 UI、测试快照与 fixture 中。设置页
      只显示「已内置」/「未配置」。任何来自网络层的错误在进入用户可见输出前
      必须经过脱敏。
    category: constraint
    applies_to: 全部反馈相关代码路径
    trigger: 任何可能承载 token 的输出点
    logic: >
      IF 一段文本将要进入日志/错误/诊断/正文/UI
      THEN 先确认它不来自请求头或凭据读取路径；网络错误只取 status/statusText/message
    violation_behaviour: token 出现在公开 issue 正文或日志导出里，等于把凭据公开发布
    source: FR6.8

  - id: BR6.4
    statement: >
      所有 vault 读能力工具必须**显式拒绝** <configDir> 前缀路径，与写侧既有的
      isObsidianConfigPath 对称；插件自身的 bundle 目录
      （<configDir>/plugins/<PLUGIN_ID>/）必须在读取、列举、搜索三条路径上都被
      排除，且排除判定基于 manifest.json 的 id 而非硬编码字符串。
    category: constraint
    applies_to: vault 读工具（read_note / read_file / search_vault / open_file / list_notes）
    trigger: 任一读工具解析到目标路径时
    logic: >
      IF 规范化后的路径等于 configDir 或以 configDir + "/" 开头
      THEN 拒绝并返回明确的拒绝错误（不返回「文件不存在」）
      IF 路径落在 <configDir>/plugins/<PLUGIN_ID>/ 之下
      THEN 在读取、列举、搜索三条路径上都排除
    violation_behaviour: 读侧无守卫时，一条提示注入链路（网页 → 诱导模型读 bundle → 用免批的 network 类工具外传）即可泄漏内置 token；而「vault API 恰好不索引点目录」是被观察到的行为，不是我们拥有的契约
    source: FR6.7.1, FR6.7.2

  - id: BR6.5
    statement: >
      read_skill 的路径解析必须保持在 skillRegistry 的约束内——它只接受 skill
      名，不接受模型提供的任意路径；模型传入 ../、绝对路径、<configDir> 前缀时
      必须被拒绝。plugin-watcher.getEnabledPluginIds() 对 PLUGIN_ID 的排除，以及
      extractSyntaxHints 抽取内容在写入 SKILL.md 前的凭据过滤，都必须被测试锁定。
    category: constraint
    applies_to: read_skill, plugin-watcher, skill-generator
    trigger: 模型调用 read_skill / 插件扫描启用插件 / 生成派生技能
    logic: >
      IF name 不在 registry 的条目中（含含路径分隔符或 .. 的名字）THEN 返回「未找到」
      IF pluginId = PLUGIN_ID THEN 从启用插件集合中排除
      IF 抽取出的候选标识符命中凭据模式 THEN 不写入 SKILL.md
    violation_behaviour: read_skill 与 skill-generator 已证明 adapter.read 能读点目录；一旦路径约束或 PLUGIN_ID 排除被重构丢掉，模型就能经 read_skill 读到自己的 bundle
    source: FR6.7.3, FR6.7.4

  - id: BR6.6
    statement: >
      BR6.4 与 BR6.5 的守卫是**显式契约**：测试必须断言守卫函数本身的判定
      （给定一个 <configDir> 前缀路径，守卫返回拒绝），而不是断言
      「getFiles() 恰好没返回点目录文件」。这样即便 Obsidian 的实现变化，
      测试仍能守住契约。
    category: constraint
    applies_to: 测试
    trigger: 运行测试套件
    logic: >
      FOR EACH 守卫
        IF 测试断言的是「守卫拒绝了 <configDir> 路径」THEN 合格
        IF 测试断言的是「Obsidian 的某个 API 恰好没返回点目录文件」THEN 不合格
    violation_behaviour: 依赖实现细节的测试会在 Obsidian 变更时一起失效——恰好是它该起作用的时刻
    source: FR6.7.5, NFR8

  - id: BR6.7
    statement: >
      不得在任何代码注释、文档、设置页 UI 或发布说明中把 token 在 bundle 中的
      呈现方式描述为「加密」「安全保护」或「无法被提取」。本设计不采纳任何
      混淆手段（分段/编码/运行期拼接）。
    category: policy
    applies_to: 文档、注释、UI 文案
    trigger: 撰写任何涉及凭据的说明文字时
    logic: >
      IF 文本描述 token 在 bundle 中的存在
      THEN 必须按实情描述：token 随发行包公开、任何用户都能读到、这是 Q2=B 的既定前提而非缺陷
    violation_behaviour: 把「提高爬取成本」说成「加密」，会让后续维护者误以为存在一个并不存在的安全边界
    source: FR4.7, Q6

  - id: BR7.1
    statement: >
      get_plugin_diagnostics 只返回 DiagnosticsSnapshot 的固定白名单字段，不接受
      任何调用方传入的字段名、路径或查询参数。该边界由工具签名强制，不是靠
      提示词约束。
    category: constraint
    applies_to: get_plugin_diagnostics
    trigger: 工具被调用
    logic: >
      工具参数为空（或只有不改变返回集合的开关）；
      IF 请求中包含任何选择字段的参数 THEN 忽略/拒绝，不据此扩展返回集合
    violation_behaviour: 一个可传参数的诊断工具就是一条任意读取通路，模型可借它读 vault 任意路径
    source: FR3.2a, FR6.3

  - id: BR7.2
    statement: >
      错误摘要（lastErrorDigest）取会话内错误环形缓冲的最新一条，不落盘；
      输出前单行化并截断至 300 字符，把路径片段与凭据模式替换为占位符；
      脱敏后为空则整项省略。
    category: calculation
    applies_to: DiagnosticsSnapshot
    trigger: 生成诊断快照时
    logic: >
      IF 缓冲为空 THEN lastErrorDigest = null（省略该字段）
      ELSE 取最新一条 → 折叠换行为空格 → 截断 300 字符 → 替换路径与凭据模式
           IF 结果为空 THEN lastErrorDigest = null ELSE 采用结果
    violation_behaviour: 直接把原始错误文本放进公开 issue，会把本地绝对路径（乃至用户名）一并公开
    source: FR6.3 衍生, Q5

  - id: BR7.3
    statement: >
      privacyMode 开启时诊断信息默认不附带，用户在预览中逐项显式勾选才带入。
      privacyMode 关闭时诊断信息默认附带，用户可逐项取消。
    category: policy
    applies_to: IssuePayload 渲染, 审批卡片
    trigger: 渲染正文与预览时
    logic: >
      IF privacyMode 开启 THEN 诊断字段默认全部不带，逐项勾选
      ELSE 默认全部附带，逐项可取消
    violation_behaviour: 在用户已表达隐私偏好的情况下仍默认公开环境信息
    source: FR6.4, Q6=A

  - id: BR7.4
    statement: >
      来自 GitHub 的内容（候选 issue 的标题、API 错误信息）按不可信数据处理：
      只取结构化字段、单行化、长度截断、剔除控制字符；只出现在数据区，
      不得进入指令区，也不得被当作指令执行。
    category: constraint
    applies_to: search_github_issues 的返回, 错误信息渲染
    trigger: 渲染外部内容进对话时
    logic: >
      IF 文本来自 GitHub
      THEN 只映射到 IssueCandidate 的结构化字段
           AND 标注为外部数据
           AND 不解析其中任何形如指令的内容
    violation_behaviour: 一条精心构造的 issue 标题即可让模型执行攻击者指定的动作——而本功能恰好带着一个可写公开仓库的凭据
    source: FR6.5

  - id: BR8.1
    statement: >
      设置页新增 feedback 分区，包含：功能开关、目标仓库地址的只读展示、凭据
      状态的只读展示（「已内置」/「未配置」，无输入框、不回显 token）、「测试
      连接」动作、以及未提交草稿列表（可重试/删除/跳回所属会话）。
    category: policy
    applies_to: 设置页
    trigger: 渲染设置页
    logic: >
      feedback 分区必须包含上述五项；凭据相关一律只读
    violation_behaviour: 提供一个 token 输入框，会让用户以为凭据由自己提供，与 Q2=B 的既定形态相反
    source: FR4.1

  - id: BR8.2
    statement: >
      反馈功能默认开启。理由：用户零配置、每次对外写入前都有 BR4.1 的显式确认，
      不存在静默对外发帖的风险；默认关闭会重新引入本功能要解决的发现性问题。
    category: policy
    applies_to: PluginSettings
    trigger: 插件首次加载（默认设置）
    logic: >
      IF 用户未显式关闭 THEN 反馈功能可用
    violation_behaviour: 默认关闭时绝大多数用户不会去打开它，本功能等于不存在
    source: FR4.4（Q2=B 推导，可否决）

  - id: BR8.3
    statement: >
      「测试连接」验证三件事并按类报错：内置 token 有效、目标仓库可达、
      该仓库 Issues 已开启。失败时必须指出是哪一项失败及原因（401/403/404/网络），
      且结果中不得回显 token。
    category: policy
    applies_to: 设置页
    trigger: 用户点击「测试连接」
    logic: >
      发起一次经鉴权的 GET /repos/yinfi/baizer
      IF 2xx THEN 报告三项均通过
      ELSE 按 BR5.1 的分类报告失败项与原因，不回显任何凭据
    violation_behaviour: 用户与发布方都无法在提交失败前发现凭据问题
    source: FR4.3

  - id: BR9.1
    statement: >
      必须提供可执行的凭据轮换 runbook，覆盖「怀疑泄漏」与「定期主动轮换」
      两种触发：撤销旧 PAT → 签发新 PAT（fine-grained、仅 yinfi/baizer、
      仅 Issues: write）→ 更新 repo secret → bump 版本并重新发布 → 在 CHANGELOG
      与发布说明中写明本次为凭据轮换并提示升级。runbook 必须写明固有代价：
      **轮换即断服**——旧 token 一撤销，所有未升级用户的反馈功能立即中断
      直到升级完成，因此轮换不是日常动作。
    category: policy
    applies_to: 运维文档
    trigger: 凭据泄漏或定期轮换
    logic: >
      按上述五步执行；执行前明确知悉「轮换即断服」的时间窗
    violation_behaviour: 把轮换当成日常无损操作，用户会在不知情的情况下遇到功能中断
    source: FR4.6

  - id: BR9.2
    statement: >
      发布前 preflight 分两步：先校验 secret 非空（缺失即失败），再用内置
      token 发一次 GET /repos/yinfi/baizer 探活，非 2xx 即失败。探活只验
      「凭据可用」，不验「权限范围恰好是 Issues: write」——后者需要一次真实
      写入才能确证，留给轮换 runbook 的人工步骤。
    category: policy
    applies_to: release.yml
    trigger: 发布流水线
    logic: >
      IF secret 为空 THEN 失败
      IF 探活非 2xx THEN 失败
      ELSE 继续构建与发布
    violation_behaviour: 非空校验挡不住「已撤销的 token」，会发布一个所有用户都 401 的版本
    source: FR4.6 衍生, Q9（可否决）
```

## 业务规则摘要

| 规则 ID | 类别 | 一句话 |
|---|---|---|
| BR1.1 | constraint | 四个反馈工具只在反馈会话可见；会话内按技能子集收窄；**技能被禁用时 fail-closed**（只给四个工具 ∪ read_skill，绝不退回全量，且本轮不调模型） |
| BR1.2 | policy | 反馈会话是干净会话：不注入记忆召回，也剔除环境上下文；普通对话不变 |
| BR1.3 | policy | 反馈会话不写入长期记忆（对称隔离，可否决） |
| BR1.4 | policy | 关闭带未提交草稿的 tab 不丢内容，会话与草稿都可恢复 |
| BR1.5 | policy | LLM 不可用时给明确可区分的提示，不做表单兜底，不丢用户输入 |
| BR1.6 | constraint | 会话 kind 标记是「是否反馈会话」的唯一事实来源；写入点/恢复点/执行期兜底写死 |
| BR2.1 | policy | 最少轮次澄清；能推断的不追问；用户说「直接提交」即停止追问 |
| BR2.2 | policy | 生成草稿前必须先检索去重；候选由用户选择，智能体不替用户判定同一性 |
| BR2.3 | policy | 识别为安全漏洞则改走私密上报，不得走本通道 |
| BR3.1 | calculation | 正文由插件按模板字段确定性渲染，覆盖模板全部字段 |
| BR3.2 | constraint | 字段清单、dropdown 选项取值与 label 取值都必须与模板同源，测试锁定漂移 |
| BR3.3 | validation | 标题单行化；正文逐字节保真，不转义、不折叠、不截断 |
| BR3.4 | policy | 类型只用 labels 表达，不用标题前缀 |
| BR4.1 | authorization | 两个写入工具无条件走审批，不受 confirmExecutions 影响；needsApproval 语义不变 |
| BR4.2 | constraint | 卡片展示完整字节且可编辑，编辑值写回 args，展示与提交同源 |
| BR4.3 | policy | 卡片必须讲清公开可见、以发布方账号发出、不可撤回，并解释为何此处仍需确认 |
| BR4.4 | constraint | 三层幂等且都在真实提交路径上：requestId + dedupKey 跨卡片复用（主保障）+ 同步原子认领（冗余层，前提须满足） |
| BR4.5 | constraint | 只有拿到 2xx 才允许声称成功、回显编号、置终态 |
| BR5.1 | policy | 401/403/404/422/网络层各有不同的可操作提示 |
| BR5.2 | policy | Retry-After 退避有上限含抖动；检索侧不退避，直接跳过去重 |
| BR5.3 | policy | 失败落暂存并给重试入口，重启后可读，重试受 dedupKey 约束 |
| BR5.4 | constraint | 未提交草稿上限 20，达上限拒绝新建并提示清理，不静默丢弃 |
| BR5.5 | policy | 凭据缺失时给「未配置」提示，不呈现必然失败的流程 |
| BR6.1 | constraint | token 只经构建期 env 注入；CI 扫本次提交范围、发布扫全量历史（同一脚本）；正则按真实格式长度校准 |
| BR6.2 | policy | 发布路径缺 token 即失败 + 探活；本地构建警告；运行时提示未配置 |
| BR6.3 | constraint | token 不得出现在日志/错误/诊断/正文/UI/测试快照中 |
| BR6.4 | constraint | vault 读工具显式拒绝 configDir 前缀；插件 bundle 目录在读取/列举/搜索三路排除 |
| BR6.5 | constraint | read_skill 只接受 skill 名；PLUGIN_ID 排除与抽取过滤必须被测试锁定 |
| BR6.6 | constraint | 读隔离测试断言守卫函数本身，不依赖 Obsidian 行为 |
| BR6.7 | policy | 不得把 token 的呈现方式描述为加密或安全保护；不采纳混淆 |
| BR7.1 | constraint | 诊断工具只返回固定白名单，不接受任何参数扩展返回集合 |
| BR7.2 | calculation | 错误摘要取会话内缓冲，单行 ≤300 字符并脱敏，空则省略 |
| BR7.3 | policy | privacyMode 开启时诊断默认不带，逐项勾选 |
| BR7.4 | constraint | 来自 GitHub 的内容按不可信数据处理，只进数据区 |
| BR8.1 | policy | 设置页 feedback 分区含开关/只读展示/测试连接/草稿列表，无 token 输入框 |
| BR8.2 | policy | 功能默认开启（可否决） |
| BR8.3 | policy | 测试连接验证三项并按类报错，不回显 token |
| BR9.1 | policy | 轮换 runbook 五步，并写明「轮换即断服」 |
| BR9.2 | policy | 发布 preflight = 非空校验 + 探活（探活为设计新增，可否决） |
