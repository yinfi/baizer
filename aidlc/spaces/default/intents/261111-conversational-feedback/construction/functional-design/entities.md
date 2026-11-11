# 实体模型 —— 对话式反馈：与智能体澄清后提交 GitHub Issue

## 范围与来源

来源：`inception/requirements-analysis/requirements.md` FR1–FR6 / NFR1–NFR8；`functional-design-questions.md` 的 12 项回答；本次对仓库代码的逐文件核验（`vault-ops.ts`、`read-skill.ts`、`skill-registry.ts`、`permission-service.ts`、`pi-tool-adapter.ts`、`approval-card.ts`、`change-preview.ts`、`base-chat-runtime.ts`、`conversation-store.ts`、`.github/ISSUE_TEMPLATE/*.yml`）。

本次由编排层直接派发本阶段，没有 `units-generation` 的 `unit-of-work.md`、也没有 `domain-design` 的 `components.md`，故以 `requirements.md` 为唯一规范输入、以现有代码结构作为既成领域设计（与 `261021-pi-runtime-refactor` 同一处理方式，见 Q10）。

本功能**不新建领域实体**，只引入一个持久化实体与三个派生值对象：对话本身仍由既有的 `Session` / `ConversationSnapshot` 承载，vault 读写、审批、技能注册、网络通路全部复用既有机制。要建模的是**一次对外公开写入的载荷与其生命周期**——它是本功能唯一带不可逆副作用的东西，也是唯一需要跨重启存活的状态。

```yaml
entities:
  - name: FeedbackDraft
    description: >
      一次反馈的载荷与其生命周期。两种模式由 kind 区分：new_issue（在目标仓库
      新建 issue）与 issue_comment（向已有 issue 追加评论）。它是本功能唯一的
      持久化实体，承载「用户已经确认过、可能还没提交成功」的内容，使关闭会话、
      提交失败、插件重启都不丢用户输入。持久化走既有 plugin.saveData()/data.json。
    attributes:
      - name: id
        type: string
        required: true
        unique: true
        constraints: ["创建时生成一次，跨重启不变"]
      - name: kind
        type: enum["new_issue", "issue_comment"]
        required: true
        constraints: ["创建后不可变更；两种模式的载荷字段互斥（见 entity_level_constraints）"]
      - name: targetRepo
        type: string
        required: true
        default: "yinfi/baizer"
        constraints: ["只读常量，无配置路径（FR3.3 / Q4=A）"]
      - name: targetIssueNumber
        type: integer
        required: false
        defaults: null
        constraints: ["kind = issue_comment 时必填且为正整数；kind = new_issue 时必须为 null"]
      - name: title
        type: string
        required: false
        defaults: null
        constraints: [
          "kind = new_issue 时必填、非空、单行（不含换行符）",
          "kind = issue_comment 时必须为 null",
          "用户可在审批卡片上就地编辑（FR6.1），编辑后即成为提交字节的一部分"
        ]
      - name: body
        type: string
        required: true
        constraints: [
          "非空",
          "渲染一次后即为权威载荷：后续重试、重放、卡片编辑都以本字段为准，不再重新渲染",
          "逐字节保真——不做 Markdown 转义、不折叠换行、不因特殊字符截断（FR6.6）"
        ]
      - name: type
        type: enum["bug", "enhancement"]
        required: false
        defaults: null
        constraints: ["kind = new_issue 时必填；kind = issue_comment 时必须为 null"]
      - name: labels
        type: string[]
        required: false
        defaults: null
        constraints: [
          "kind = new_issue 时必填，取值由 type 唯一决定（bug → [\"bug\"]，enhancement → [\"enhancement\"]）",
          "取值必须与 .github/ISSUE_TEMPLATE/*.yml 的 labels 字段同源，由测试锁定（FR3.5）"
        ]
      - name: dedupKey
        type: string
        required: true
        constraints: [
          "内容派生的稳定键：由 kind + targetIssueNumber + 归一化后的 title + 归一化后的 body 计算",
          "同一份内容无论经几次渲染、几个审批请求、几个会话，键相同（FR3.8 的第二层去重）",
          "归一化只做空白与行尾统一，不做语义改写——避免把「实质不同」的两份内容判为同一份"
        ]
      - name: sourceConversationId
        type: string
        required: true
        constraints: ["= 发起它的反馈 tab id；用于把草稿列表项跳回所属会话（FR5.6）"]
      - name: status
        type: enum["draft", "awaiting_confirmation", "submitting", "submitted", "failed"]
        required: true
        default: draft
        constraints: [
          "状态迁移见 functional-spec.md 的状态机；submitted 是成功终态",
          "failed 可回到 submitting（重试），不视为终态"
        ]
      - name: attempts
        type: integer
        required: true
        default: 0
        constraints: ["每次实际发出写入请求前自增；用于退避上限判定（FR5.4）"]
      - name: lastError
        type: object
        required: false
        defaults: null
        constraints: [
          "形状固定为 { category, httpStatus, message, at }",
          "message 必须是已脱敏的短文本——不得含 token、请求头、绝对路径（FR6.8）"
        ]
      - name: submittedIssueNumber
        type: integer
        required: false
        defaults: null
        constraints: ["仅 status = submitted 时非空"]
      - name: submittedIssueUrl
        type: string
        required: false
        defaults: null
        constraints: ["仅 status = submitted 时非空；供 FR3.9 回显与 FR2.8 的会话终态标识使用"]
      - name: createdAt
        type: datetime (ISO 8601)
        required: true
      - name: updatedAt
        type: datetime (ISO 8601)
        required: true
        constraints: ["每次状态或载荷变更时更新"]
    entity_level_constraints:
      - "kind = new_issue  ⇒ title、type、labels 非空，targetIssueNumber 为 null"
      - "kind = issue_comment ⇒ targetIssueNumber 非空，title、type、labels 为 null"
      - "status ∈ {draft, awaiting_confirmation, submitting, submitted} 的草稿集合内 dedupKey 唯一（已 failed 的允许重复，否则重试会被自己挡住）"
      - "未提交草稿（status ∈ {draft, awaiting_confirmation, failed}）总数上限 20；达上限时拒绝创建新草稿（FR5.6 / Q11）"
      - "草稿内容含用户输入，删除即整条移除，不得留残影（FR5.6）"
    relationships:
      - target: ConversationSnapshot
        cardinality: "多对 1"
        direction: "多个草稿属于一个反馈会话；会话被删除时其草稿一并清理"

  - name: IssuePayload
    description: >
      派生值对象（不单独持久化，随审批请求的 args 存活）。它是一次对外写入的
      **最终字节**：标题、正文、label、目标仓库。之所以显式建模，是因为 FR3.4 /
      FR3.5 的模板等价与同源校验锁定的正是它的字段构成，而 FR6.1 要求的
      「卡片展示的字节 == 提交的字节」也是对它的一条不变量。
    attributes:
      - name: kind
        type: enum["new_issue", "issue_comment"]
        required: true
      - name: repo
        type: string
        required: true
      - name: title
        type: string
        required: false
        constraints: ["kind = new_issue 时非空且单行"]
      - name: body
        type: string
        required: true
        constraints: ["非空；kind = issue_comment 时为评论正文"]
      - name: labels
        type: string[]
        required: false
        constraints: ["kind = new_issue 时非空"]
      - name: issueNumber
        type: integer
        required: false
        constraints: ["kind = issue_comment 时非空"]
      - name: draftId
        type: string
        required: true
        constraints: ["回指 FeedbackDraft；审批通过后的执行以它取权威载荷"]
      - name: dedupKey
        type: string
        required: true
    entity_level_constraints:
      - "渲染是确定性的：同一组结构化澄清字段 + 同一份诊断信息 ⇒ 逐字节相同的 body"
      - "渲染只发生一次：审批通过后的执行路径不得重新渲染，否则会覆盖用户在卡片上的编辑"
      - "body 与 title 是提交的唯一来源；卡片展示的必须是同一份字节（无二次加工）"

  - name: DiagnosticsSnapshot
    description: >
      派生值对象（不持久化，每次按需生成）。FR6.3 的固定白名单字段集合，
      其构成由 get_plugin_diagnostics 的工具签名强制，而不是靠提示词约束。
      它是反馈正文里唯一来自运行环境的输入，因此它的字段边界就是隐私边界。
    attributes:
      - name: pluginVersion
        type: string
        required: true
        constraints: ["取自 manifest.json 的 version"]
      - name: obsidianVersion
        type: string
        required: true
      - name: platform
        type: enum["Windows", "macOS", "Linux", "iOS", "Android"]
        required: true
      - name: providerType
        type: enum["openai-compatible", "anthropic", "none"]
        required: true
        constraints: ["只给类型，不给 provider label、baseUrl、model id、apiKey（FR6.3）"]
      - name: lastErrorDigest
        type: string
        required: false
        defaults: null
        constraints: [
          "会话内错误环形缓冲的最新一条，插件重载即清空（不落盘，Q5）",
          "单行化（换行折叠为空格）后截断至 300 字符",
          "路径片段与凭据模式被替换为占位符；脱敏后为空则整项省略",
          "缺失是合法状态——不得用「无」以外的任何东西填充"
        ]
      - name: generatedAt
        type: datetime (ISO 8601)
        required: true
    entity_level_constraints:
      - "字段集合封闭：不接受任何调用方传入的字段名或查询参数（FR3.2a）"
      - "不含笔记内容、文件路径、vault 名称、API Key、内置 token、对话历史、环境上下文（FR6.3）"
      - "privacyMode 开启时默认不附带，改由用户在预览中逐项勾选（FR6.4）"

  - name: IssueCandidate
    description: >
      派生值对象（不持久化）。去重检索返回的候选 issue 条目。它来自外部系统，
      按不可信内容处理：只保留结构化字段、长度截断、控制字符剔除，且永远不被
      当作指令执行（FR6.5）。
    attributes:
      - name: number
        type: integer
        required: true
      - name: title
        type: string
        required: true
        constraints: ["单行化 + 截断至 200 字符 + 剔除控制字符"]
      - name: state
        type: enum["open", "closed"]
        required: true
      - name: url
        type: string
        required: true
        constraints: ["只接受 https://github.com/<repo>/issues/<n> 形态；其余一律丢弃该候选"]
      - name: updatedAt
        type: datetime (ISO 8601)
        required: false
    entity_level_constraints:
      - "候选集合是只读输入：任何候选都不得直接触发写入，写入必须经用户显式选择（FR3.6）"
      - "候选文本在进入对话时标注为外部数据，不进入系统提示的指令区（FR6.5）"
```

## 实体集摘要

本功能只引入**一个持久化实体**与**三个派生值对象**，没有第二个需要跨重启存活的状态。

`FeedbackDraft` 是本功能唯一有副作用的载荷载体。它把「新建 issue」与「追加评论」收在一个实体里，靠 `kind` 判别、靠 `entity_level_constraints` 保证两种模式的字段互斥——不拆成两个实体，是因为两者的生命周期（草稿 → 待确认 → 提交中 → 已提交/失败）、去重键算法、队列上限、错误分类完全一致，拆开只会让同一套规则写两遍。`body` 的「渲染一次即为权威载荷」是本模型最关键的一条不变量：它同时满足了 FR6.6 的字节保真与 FR6.1 的「卡片展示 == 提交字节」——因为一旦允许在提交路径上重新渲染，用户在卡片上的编辑就会被静默覆盖，而这发生在一个不可撤销的公开写操作上。

`IssuePayload` 不单独持久化，它随审批请求的 `args` 存活（`ApprovalRequest.args` 已随消息快照持久化，见 `src/ui/approval-card.ts`）。把它建模为独立值对象而不是 `FeedbackDraft` 的字段，是因为「一次提交尝试的字节」与「一份草稿的内容」在失败重试时会出现分歧：重试复用同一份 `IssuePayload`，而草稿可能已被用户改过。分清这两者，FR3.8 的双层去重才有明确的作用对象。

`DiagnosticsSnapshot` 与 `IssueCandidate` 都是纯派生、不持久化。前者的价值在于**把隐私边界从提示词约束变成类型约束**（工具签名只返回这几个字段）；后者在于**把外部输入从「可信文本」降级为「只读数据」**，这是 FR6.5 在模型层面的落点——候选标题永远只出现在数据区，不出现在指令区。

## 与既有模型的边界

本功能**不新增**对话实体、不新增消息存储、不新增审批实体。反馈会话就是既有的 `ConversationSnapshot` / `Session`（`conversationId` = tab id）；审批复用既有的 `ApprovalRequest` / `ApprovalState` / `ApprovalExecutionRegistry`（`requestId` 去重）；会话终态标识落在 `ConversationSnapshot` 上的一个可选字段（见 `functional-spec.md` 的状态机 2），不另建映射表。
