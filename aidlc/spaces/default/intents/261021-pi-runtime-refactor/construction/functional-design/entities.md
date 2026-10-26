# 实体模型 —— pi 运行时底座重构

## 范围与来源

来源：`requirements.md` FR2（会话持久化自建层）；`functional-design-questions.md` Q1/Q3/Q5；CodeKB `component-inventory.md`"Harness 会话与执行环境"一节（现有 `HarnessSessionManager`/`VaultSessionFileSystem` 行为基线）。

本次重构不引入新的业务领域实体（不新增业务概念，不改变 Baizer 现有四条业务线的领域模型）；本阶段要建模的是**自建会话持久化层**本身的结构——它取代 pi 0.75.5 已移除的 `SessionRepo`/`JsonlSessionRepo`，必须承载 FR2.1 的全部既有行为。

```yaml
entities:
  - name: Session
    description: >
      一个持久化的对话会话，对应现有 HarnessSessionManager 的 per-conversation
      隔离单元（conversationId = tab id）。一个 Session 在 vault 内对应一个
      JSONL 文件（迁移后为新存储格式）。
    attributes:
      - name: conversationId
        type: string
        required: true
        unique: true
        constraints: ["非空"]
      - name: formatVersion
        type: integer
        required: true
        default: 当前新格式版本号（整数，首次写入即固定）
        constraints: ["缺失该字段视为旧格式（来源：Q2 答案 A，由解析器层面判定，而非仅靠该字段——见下方“格式判定”说明）"]
      - name: createdAt
        type: datetime (ISO 8601)
        required: true
      - name: lastActivityAt
        type: datetime (ISO 8601)
        required: true
        constraints: ["每次新增 Entry 时更新"]
      - name: activeLeafEntryId
        type: string (Entry 的 id 引用)
        required: false
        defaults: null（空会话尚无条目）
        constraints: ["指向当前激活分支的叶子 Entry；分支切换/重试/编辑都通过改写这一个指针完成，而不是建独立的 Branch 实体（来源：Q1 答案 A）"]
      - name: compactionState
        type: object（opaque，延续现有 maybeCompact 判定所需的最少必要字段：lastCompactedAt、tokensSinceCompaction）
        required: false
        defaults: null（未发生过压缩）
      - name: availability
        type: enum["active", "read_only_degraded"]
        required: true
        default: active
        constraints: ["迁移失败时置为 read_only_degraded（来源：Q3 答案 A）；该状态下仍可读取历史 Entry，但拒绝任何新增 Entry 的写操作"]
    entity_level_constraints:
      - "conversationId 在整个 vault 范围内唯一（延续现有多 tab 互不串台的行为）"
      - "availability = read_only_degraded 的 Session 不参与自动压缩判定"
    relationships:
      - target: Entry
        cardinality: "1 对多"
        direction: "Session 拥有多个 Entry"

  - name: Entry
    description: >
      会话树中的一条条目：用户消息、助手消息、工具调用、工具结果、审批结果或
      custom_message。Entry 之间通过 parentEntryId 构成分叉树；"分支"是从根到
      某个 Entry 的一条路径，由查询时的投影算法（projectBranchToMessages 的继
      任者）计算，不是独立实体（来源：Q1 答案 A）。
    attributes:
      - name: id
        type: string
        required: true
        unique: true
      - name: sessionId
        type: string（引用 Session.conversationId）
        required: true
        references: Session
      - name: parentEntryId
        type: string（引用 Entry.id）
        required: false
        defaults: null（根条目）
        references: Entry
        constraints: ["null 仅允许用于该 Session 的根条目；非根条目必须引用同一 Session 内的既有 Entry"]
      - name: kind
        type: enum["user_message", "assistant_message", "tool_call", "tool_result", "approval_outcome", "custom_message"]
        required: true
        constraints: [
          "approval_outcome 是本次新增的显式条目种类，取代对旧 custom_message 的隐式复用，使审批回灌语义在类型层面可辨识（为 Q5 的可见性维度提供载体）"
        ]
      - name: visibleToModel
        type: boolean
        required: true
        default: true
        constraints: ["决定该 Entry 是否进入下一轮发往模型的历史（来源：Q5 答案 A，独立维度一）"]
      - name: visibleToUiProjection
        type: boolean
        required: true
        default: true
        constraints: [
          "决定该 Entry 是否出现在 UI 分支投影结果中（来源：Q5 答案 A，独立维度二）",
          "审批回灌条目（kind = approval_outcome）的既有行为固定为 visibleToModel = true、visibleToUiProjection = false，不随用户设置变化"
        ]
      - name: supersededByEntryId
        type: string（引用 Entry.id）
        required: false
        defaults: null（未被取代）
        references: Entry
        constraints: ["编辑/重试产生新 Entry 时，原 Entry 记录其被哪个新 Entry 取代（延续现有 supersedeUserEntry 语义），用于投影算法判断该分叉是否已作废"]
      - name: createdAt
        type: datetime (ISO 8601)
        required: true
      - name: payload
        type: object（内容随 kind 变化：消息文本、工具调用参数、工具结果、审批结果文本等）
        required: true
    entity_level_constraints:
      - "visibleToModel = false 且 visibleToUiProjection = false 的组合被禁止（没有任何一处会写入完全不可见的 Entry；若要彻底隐藏应改为不写入而非写入后双重隐藏）"
      - "同一 Session 内，parentEntryId 不得形成环（必须是一棵树）"
    relationships:
      - target: Session
        cardinality: "多对 1"
        direction: "Entry 属于一个 Session"
      - target: Entry
        cardinality: "0/1 对多（自引用）"
        direction: "Entry 通过 parentEntryId 指向其父 Entry，构成分叉树"
```

## 实体集摘要

自建持久化层只建两个实体：`Session`（会话，对应一个 vault 内 JSONL 文件）与 `Entry`（会话树中的一条条目）。"分支"不是第三个实体，而是从树根到 `Session.activeLeafEntryId` 或任意历史 Entry 的一条路径，由投影算法在读取时计算——这与 FR2.1 要求的"分叉/重试/编辑/兄弟切换"行为一致：切换分支只是改写 `activeLeafEntryId` 这一个指针，不需要迁移或复制任何 Entry。

`Entry.visibleToModel` / `Entry.visibleToUiProjection` 两个独立维度取代了现有代码里"custom_message 对模型可见、对 UI 不可见"这条硬编码规则，把它从"实现细节"提升为"数据模型显式字段"，使审批回灌（`appendApprovalOutcome`）的语义可以被其他 Entry 种类复用，而不必每次新增一种可见性组合就新增一次特判代码。

`Session.availability` 承载 FR2.2 的迁移失败处理：迁移失败时该字段置为 `read_only_degraded`，而不是删除或静默重建会话，满足 Q3 的只读保护决策。
