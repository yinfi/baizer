# Functional Design — 澄清问题

本次 scope（`refactor`）跳过 units-generation 与 domain-design，无 Unit DAG：以 `requirements.md` 为唯一规范输入，`aidlc/spaces/default/codekb/obsidian-cli/`（现有代码结构）作为既成的领域设计。本阶段针对 FR2（会话持久化自建层）与 FR3（底座用深）两组需求设计实体模型、业务规则与行为规范。

## Q1. [开发] 自建会话持久化层的实体模型要覆盖哪个粒度？

现有 `HarnessSessionManager` 的会话树里，一个会话（session）由多条"条目"（entry：用户消息/助手消息/工具调用/工具结果/审批结果/custom_message）组成，条目之间构成分叉树；"分支"是从根到某个条目的一条路径投影。entities.md 要把哪些概念建模为显式实体？

- A. 两层实体：`Session`（会话）与 `Entry`（条目，含其在树中的父指针），"分支"只是查询时的投影算法，不单独建模为实体
- B. 三层实体：`Session`、`Entry`、再加一个独立的 `Branch`/`Checkpoint` 实体用来记录"当前激活的叶子条目"
- C. 直接照搬 pi 0.75.5 现有 JSONL 的字节结构作为实体定义（即不重新设计，只重新实现读写逻辑）
- X. Other (please specify)

[Answer]: A. Session + Entry 两层

## Q2. [开发] 迁移触发的业务规则："首次打开自动迁移"具体判定标准是什么？

`requirements.md` FR2.2 确定了"首次打开时自动迁移"，但没有定义"如何判定一个会话文件是旧格式"。

- A. 用文件内容特征判定（例如旧格式 JSONL 首行/某字段的形状与新格式不同，逐行解析时按格式特征路由到对应的解析器）
- B. 用版本标记判定：新格式在文件或 session 元数据中写入一个格式版本号，缺失该版本号即视为旧格式
- C. 两者都要：优先读版本标记，读不到再退回内容特征探测，双重保险
- X. Other (please specify)

[Answer]: A. 按内容特征判定

## Q3. [开发] 迁移失败时的行为规则是什么？

FR2.2 要求迁移要有测试覆盖，但 requirements.md 没有定义迁移本身失败（文件损坏、格式既不是新也不是旧已知格式）时应该发生什么。

- A. 迁移失败时该会话只读不可写（能看历史，不能继续对话），并在 UI 给出明确提示，不影响其他会话
- B. 迁移失败时该会话视为不可用，提示用户该会话无法打开，但不删除原文件
- C. 迁移失败时静默创建一个全新的空会话（丢弃旧历史），不打断用户操作
- X. Other (please specify)

[Answer]: A. 只读保护

## Q4. [架构] pi 事件映射拓宽（FR3.3）的业务规则：新增事件类型如何处理才算"有意识评估"？

当前只映射 4 类 pi 事件到 `StreamEvent`；FR3.3 要求对 1.x `Agent` 实际产生的全部事件类型做"映射"或"有意识丢弃并记录理由"之一。这条规则在 functional-spec.md 里要以什么形式固化，才能让 Code Generation 阶段照此实现、Build and Test 阶段照此验收？

- A. functional-spec.md 列出一张"事件类型 → 处理方式"的决策表（每个 1.x 事件类型对应：映射到哪个 StreamEvent 字段，或"丢弃+理由"），这张表本身就是验收依据
- B. 不需要固定表，只要求 Code Generation 阶段在实现时自行枚举并在代码注释里说明取舍，Functional Design 阶段不预先列表
- X. Other (please specify)

[Answer]: A. 固定决策表

## Q5. [架构] 审批回灌（approval outcome replay）在自建持久化层下的状态机是否有变化？

现有行为："对模型可见、对 UI 分支投影不可见"的 custom_message 回灌（`appendApprovalOutcome`/`appendCustomMessageEntry`），用来避免给已有配对占位 toolResult 的 tool_call 再塞第二个结果。FR2.1 要求这个行为保持一致。这条规则在新实体模型下，`Entry` 要不要显式区分"对模型可见/对 UI 可见"这两个独立的可见性维度？

- A. 是，`Entry` 需要两个独立的布尔维度（visible_to_model / visible_to_ui_projection），这样 custom_message 类条目可以精确表达"模型可见、UI 不可见"
- B. 不需要独立维度，用现有的 entry kind（如新增一个 `approval_outcome` 条目类型）加上投影算法里的硬编码过滤规则即可
- X. Other (please specify)

[Answer]: A. 两个独立维度

## Consolidated Summary Confirmation

- Q1：自建持久化层的实体模型为 Session + Entry 两层，"分支"是投影算法而非独立实体
- Q2：旧格式判定按文件内容特征路由到对应解析器
- Q3：迁移失败时该会话只读保护（可看历史、不能继续对话），UI 给出明确提示，不影响其他会话
- Q4：pi 事件映射拓宽在 functional-spec.md 中固化为一张"事件类型 → 处理方式"的决策表，作为验收依据
- Q5：Entry 用两个独立布尔维度（visible_to_model / visible_to_ui_projection）表达审批回灌的可见性语义

Does this all look correct before I generate the artifact?

- Looks correct
- Request changes

[Answer]: Looks correct
