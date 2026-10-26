# 业务规则 —— pi 运行时底座重构

## 范围与来源

来源：`requirements.md` FR1-FR5；`functional-design-questions.md` Q1-Q5 的回答；`entities.md` 的实体定义。

```yaml
rules:
  - id: BR1.1
    statement: >
      会话文件的格式归属（新格式 / 旧格式）按文件内容特征判定：解析器先尝试
      按新格式的结构特征解析；若该特征不满足，则按旧格式（pi 0.75.5
      JsonlSessionRepo 的既有字节结构）特征解析。不依赖单一的格式版本号字段
      做判定依据。
    category: validation
    applies_to: Session（文件级，发生在会话被打开时）
    trigger: 会话文件被首次打开（读取）
    logic: >
      IF 文件内容匹配新格式的结构特征（例如顶层字段形状、kind 枚举值集合）
      THEN 按新格式解析，不触发迁移
      ELSE IF 文件内容匹配已知的旧格式（pi 0.75.5 JsonlSessionRepo 产出）特征
      THEN 触发 BR1.2（自动迁移）
      ELSE 该文件既不是已知新格式也不是已知旧格式，视为迁移失败，触发 BR1.3
    violation_behaviour: 不适用（本规则是判定逻辑本身，不是可违反的约束）
    source: FR2.2；Q2 答案 A

  - id: BR1.2
    statement: >
      判定为旧格式的会话文件，在被打开时自动迁移为新存储格式；迁移后原会话的
      全部用户可见行为（分叉/重试/编辑/兄弟切换、审批回灌的可见性语义、跨重
      启历史）必须与迁移前等价。
    category: policy
    applies_to: Session
    trigger: BR1.1 判定为旧格式
    logic: >
      IF BR1.1 判定该文件为旧格式
      THEN 解析旧格式的全部 Entry，按 entities.md 的 Entry 模型重建树结构，
           为既有的 custom_message 审批回灌条目重建为 kind = approval_outcome
           且 visibleToModel = true、visibleToUiProjection = false，
           写出新格式文件，Session.formatVersion 置为当前版本号，
           Session.availability 保持 active
    violation_behaviour: 迁移产生的新文件在用户可见行为上与原文件不等价，是一个缺陷（由 FR2.2 要求的专门测试覆盖捕获），而非本规则允许的分支
    source: FR2.2；Q2 答案 A；Q1 答案 A（迁移目标形态即 entities.md 的两层模型）

  - id: BR1.3
    statement: >
      迁移失败（文件既不匹配新格式也不匹配已知旧格式特征，或迁移过程中解析/
      写出出错）时，该会话的 Session.availability 置为 read_only_degraded；
      该状态下允许读取已有历史 Entry，拒绝写入任何新 Entry；UI 必须向用户给
      出明确提示；此状态不影响 vault 内其他会话文件。
    category: policy
    applies_to: Session
    trigger: BR1.1 判定既非新格式也非旧格式，或迁移过程本身抛出错误
    logic: >
      IF 迁移失败
      THEN Session.availability = read_only_degraded
           AND 保留原文件不做任何写入或删除
           AND UI 层在打开该会话时显示"该会话无法继续对话，仅可查看历史"
               一类的明确提示
      ELSE （正常路径见 BR1.1/BR1.2）
    violation_behaviour: 若实现为"静默创建空会话"或"直接报错导致整个应用不可用"，均违反本规则；前者丢失用户历史（Q3 已排除的选项 C），后者让单个坏文件波及其他会话
    source: FR2.2；Q3 答案 A

  - id: BR2.1
    statement: >
      Entry 的可见性由两个独立的布尔维度共同决定：visibleToModel（是否进入下
      一轮发往模型的历史）与 visibleToUiProjection（是否出现在 UI 分支投影结
      果中）。审批回灌条目（kind = approval_outcome）固定为
      visibleToModel = true、visibleToUiProjection = false，且该组合对用户或
      调用方不可配置。
    category: constraint
    applies_to: Entry
    trigger: 任意 Entry 被写入或被投影算法读取
    logic: >
      IF Entry.kind = approval_outcome
      THEN Entry.visibleToModel = true AND Entry.visibleToUiProjection = false
           （不可被覆盖）
      投影算法读取分支时：IF Entry.visibleToUiProjection = false THEN 该 Entry
      不出现在 UI 渲染的消息列表中；模型历史组装时：IF Entry.visibleToModel =
      false THEN 该 Entry 不计入发往模型的消息序列
    violation_behaviour: 若审批回灌结果意外出现在 UI 气泡中（UI 可见性泄漏），或模型在下一轮"失忆"审批结果（模型可见性缺失），均是对本规则的违反，对应现状代码里"已有配对占位 toolResult，不能给第二个结果"要规避的具体问题
    source: FR2.1；Q5 答案 A；entities.md Entry.visibleToModel/visibleToUiProjection

  - id: BR2.2
    statement: >
      分支切换（分叉/重试/编辑/兄弟切换）只通过改写 Session.activeLeafEntryId
      完成，不复制、不删除、不改写任何既有 Entry（除 supersededByEntryId 字
      段的标记写入）。
    category: constraint
    applies_to: Session, Entry
    trigger: 用户执行分叉、重试、编辑或兄弟切换操作
    logic: >
      IF 用户编辑/重试某条已有消息
      THEN 创建一条新 Entry（parentEntryId 指向原 Entry 的父节点），
           原 Entry.supersededByEntryId 指向新 Entry，
           Session.activeLeafEntryId 更新为新分支的叶子
      IF 用户切换到另一条兄弟分支
      THEN 仅更新 Session.activeLeafEntryId，不产生新 Entry，不改写任何既有
           Entry 的字段（supersededByEntryId 除外）
    violation_behaviour: 若分支切换导致某条历史 Entry 的 payload 被就地改写，则破坏了"分叉树只增长、不改写既有节点内容"的不变量，会使审计与回放失真
    source: FR2.1（分叉/重试/编辑/兄弟切换行为保真度）；Q1 答案 A（分支为投影算法而非实体，不持有可变状态）

  - id: BR3.1
    statement: >
      升级后适配层对 pi 1.x `Agent` 实际产生的每一种事件类型，必须在
      functional-spec.md 的事件映射决策表中有且仅有一条对应行，取值为"映射到
      某个 StreamEvent 字段"或"丢弃，并注明理由"二者之一；不允许存在未经决
      策表覆盖、被静默丢弃的事件类型。
    category: constraint
    applies_to: pi 原生适配层（pi-event-adapter 的继任实现）
    trigger: Code Generation 阶段实现事件适配逐型映射时
    logic: >
      FOR EACH 1.x Agent 实际产生的事件类型
        IF 决策表中存在该类型对应行且取值为"映射"
        THEN 必须有可观察的 StreamEvent 产出路径
        ELSE IF 决策表中存在该类型对应行且取值为"丢弃+理由"
        THEN 允许无 StreamEvent 产出，但理由必须出现在决策表中
        ELSE （决策表中不存在该行）视为 Code Generation 阶段未完成 FR3.3
    violation_behaviour: 决策表之外悄悄丢弃一种事件类型，是对 FR3.3"有意识评估"要求的违反，哪怕丢弃的结论本身是合理的
    source: FR3.3；Q4 答案 A
```

## 业务规则摘要

| 规则 ID | 一句话 |
|---|---|
| BR1.1 | 会话文件新旧格式按内容特征判定，不依赖单一版本号字段 |
| BR1.2 | 旧格式会话首次打开时自动迁移，行为保真度与迁移前等价 |
| BR1.3 | 迁移失败则该会话只读保护，不影响其他会话，UI 给出明确提示 |
| BR2.1 | Entry 可见性由 visibleToModel / visibleToUiProjection 两个独立维度决定；审批回灌固定为"模型可见、UI 不可见" |
| BR2.2 | 分支切换只改写 activeLeafEntryId 指针，不复制/改写既有 Entry 内容 |
| BR3.1 | pi 1.x 事件类型必须在决策表中逐一"映射"或"丢弃+理由"，不允许静默丢弃 |
