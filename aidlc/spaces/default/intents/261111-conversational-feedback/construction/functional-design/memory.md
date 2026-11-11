<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
<!-- example: 2026-05-29T10:14:32Z — chose REST over GraphQL; the consuming team only needs CRUD, revisit if subscriptions land -->
2026-11-11T12:05:00Z — 把 FR6.1 的「用户可在预览中编辑」读作「审批卡片上的标题与正文可就地编辑」，而不是「在对话里改草稿、卡片只读」。理由：FR6.1 把编辑绑定在「显式确认（FR3.7）」这个环节上，且编辑值写回已持久化的 request.args 后不存在「展示的与提交的不是同一份字节」这种偏差。已在 functional-design-questions.md 的 Q2 记录备选读法与代价。
2026-11-11T12:05:00Z — 把 FR6.7.6 的「实测」落成**代码级核验**（逐工具读路径解析方式 + 该解析方式能否索引点目录），并明确标注这不是 Obsidian 运行时实测。理由：本执行环境没有 Obsidian（无 CLI、无桌面端）。按 FR6.7.6 本身「无论可达与否守卫都要做」，该实测不改变任何设计决策；真机实测作为验证项移交 Code Generation / Build and Test，步骤与预期已写进 functional-spec.md 决策表 4。
2026-11-11T12:05:00Z — 把「草稿记录在第一次调用写入工具时创建」定为草稿的产生时机。理由：FR2.6 把 feedback 技能的工具子集钉死在四个工具，新增一个 save_draft 工具会破坏该约束；而澄清中途的中间态本来就已经由会话持久化（FR2.8）承载，草稿记录只需在载荷真正成型时存在。

## Deviations
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->
2026-11-11T12:05:00Z — 本阶段**没有上游 units-generation / domain-design / contract-design 产物**（编排层直接派发本阶段）。按阶段说明「输入缺失时不臆造」，以 requirements.md 为唯一规范输入、现有代码结构作为既成领域设计，产物落在 construction/functional-design/（不设 per-unit 子目录），与 261021-pi-runtime-refactor 同一处理方式。缺口已在 functional-design-questions.md 的 Q10 显式回报编排层。
2026-11-11T12:05:00Z — 按编排层要求，在 ci.yml 与 release.yml 各加入一步「追踪文件凭据守卫」，并给 .gitignore 补 .env。这是本阶段唯一的源码改动：它是设计约束 BR6.1 自身的守卫，不是功能实现。功能实现（四个工具、feedback 技能、UI）留给 Code Generation。

## Tradeoffs
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->
2026-11-11T12:05:00Z — 让审批卡片为 external-publish 预览引入可编辑分支，代价是改动了共享组件（ChangePreview 联合类型 + 卡片渲染分派）。选择接受，因为替代方案（把编辑移出预览环节）要改写一条已定稿的 Must 需求，而完全另造确认 UI 会与既有 requestId 去重、ApprovalState 生命周期脱钩。收窄手段：可编辑分支由 preview.kind 唯一门控 + 补测试断言其余 kind 渲染路径不变。
2026-11-11T12:05:00Z — 反馈会话选择「对记忆系统既不读也不写」，而不是只做需求明写的「不读」。多花一条规则（BR1.3），换来隔离契约的对称性与可测性，并避免一次性的报障对话污染后续召回。
2026-11-11T12:05:00Z — 发布 preflight 在非空校验之外追加一次 GET /repos/yinfi/baizer 探活（BR9.2，可否决）。多一次网络依赖换掉「发布一个凭据已死、所有用户静默 401 的版本」这个最贵的失败模式。不验权限范围——那需要一次真实写入，不适合放进发布门禁。
2026-11-11T12:05:00Z — chatStream 末尾新增一个可选 options 对象承载 isolatedContext 与 forcedSkillName，而不是借机把它重构成单一 options 对象。牺牲了一次顺手清理的机会，换掉「本功能的 diff 被入口重构盖过」的风险。
2026-11-11T12:05:00Z — 类型只用 labels 表达、不加标题前缀（BR3.4）。依据是 A4（标签被静默丢弃）在本场景不成立——token 属仓库所有者。若开发阶段实测推翻，回退是局部改动，已记入轮换 runbook 的备注。

## Open questions
<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
2026-11-11T12:05:00Z — FR6.7.6 的真机运行时实测尚未执行（本环境无 Obsidian）。需在装有 Obsidian 的环境里逐个读能力工具尝试读取 <vault>/.obsidian/plugins/baizer/main.js，与 functional-spec.md 决策表 4 的静态结论比对。守卫不依赖该结果。
2026-11-11T12:05:00Z — 待用户/编排层确认的四项推导结论：BR1.3（反馈会话不写记忆）、BR8.2（功能默认开启）、BR9.2（preflight 探活）、以及 Q2 对 FR6.1「可编辑」的落点。前两项与最后一项都会改变实现面，建议在下一棒之前给一个明确答复。
2026-11-11T12:05:00Z — 本 intent 的目录里没有 aidlc-state.md，intents.json 也未登记（编排层决定留待统一处理）。若编排层要跑完整链路，需先补 domain-design + units-generation；本阶段的实体与规则可直接作为其输入。
2026-11-11T12:05:00Z — 草稿上限 20 与错误摘要截断 300 字符都是策略常量，当前无实测依据，取的是「异常情况下够用」的量级；若实际使用中频繁触顶，应按 BR5.4 的提示路径观察后再调。
