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

## 返工（review-01，2026-11-11T13:0x）

### Interpretations
2026-11-11T13:05:00Z — Critical 采纳编排层指定的方向：**唯一权威是 `request.args`**，`preview` 不再承载任何可编辑字节。没有选「编辑同时写回两处」——那只降低不一致的概率，不消除两份真相之间的写入顺序窗口。
2026-11-11T13:05:00Z — Major-3 采纳「从 `FeedbackDraft` 派生」这一支，但**另加一个 `kind` 标记**（BR1.6）。理由：终态标识确实可以从草稿派生（不新增快照字段），但「这个会话是不是反馈会话」在还没有任何草稿时就必须可判定，且重启后必须仍成立——派生不出来，只能持久化。这个字段记录的是会话种类，与草稿里的编号/链接不重复，因此不构成第二处真相。
2026-11-11T13:05:00Z — `dedupKey` 的语义澄清为「这一次反馈的身份」而不是内容校验和：渲染时派生一次，**不随卡片编辑变化**。否则用户编辑后重提会算出不同的键、绕过幂等——而 FR3.8 要防的是同一份草稿被重复提交，不是同一段文字被有意提交两次。

### Deviations
2026-11-11T13:05:00Z — Major-2 的机制选了**可见性过滤**而不是编排层提示的 `allowPluginControl` 式执行期自门控。理由：自门控形态下模型看得到、调得动、只是被拒，工具描述仍进入每一轮提示词（与 NFR6 冲突），且「被拒」与「不存在」对模型的诱导效果不同。执行期兜底仍保留一道（`ToolContext.conversationId`），但如实标注它识别不了「首次调用」，定位是重放/串台防护。
2026-11-11T13:05:00Z — 守卫正则阈值从 `{20,}` 提到 `{30,}`，**这是让全量历史扫描可用的前提**：`{20,}` 会在历史里命中 `test/memory-manager.test.ts` 的旧 fixture，使发布流水线永久失败。把阈值定在真实凭据格式的长度上（前缀后 36 字符起），低于真实长度的合成 fixture 就永不误报，守卫因此不需要白名单——这比「给某一行开例外」可靠。

### Tradeoffs
2026-11-11T13:05:00Z — `DiagnosticsSnapshot.providerType` 改为 `DiagnosticsSnapshot.provider`（枚举 = 模板 dropdown 6 项 + `Anthropic` + `Not relevant to this bug`）。牺牲了「快照只描述事实、不耦合模板」的纯度，换来两件事：原始 provider label 不再进公开 issue（label 可能是用户自建的端点名），以及映射的确定性可以被测试锁定。
2026-11-11T13:05:00Z — 模板 `provider` dropdown 没有 Anthropic 选项。选择如实写 `Anthropic` 并把它标为**显式例外**由测试断言可见，而不是塞进 `Other OpenAI-compatible endpoint`（事实错误）或 `Not relevant to this bug`（丢定位信息）。改模板不在本设计内擅自做，已列为待办。

### Open questions
2026-11-11T13:05:00Z — `bug_report.yml` 的 provider dropdown 缺 Anthropic 选项，待办：给模板补该项后，决策表 3b 的例外集可清空。
2026-11-11T13:05:00Z — 数字更正：此前回报的「54 FR / OK 38 / N/A 16」是汇总时数错，产物本身无误。返工后实际值：56 行 = 48 FR（OK 42 / N/A 6）+ 8 NFR（OK 2 / N/A 6）= OK 44 / N/A 12；BR 定义 39 条，全部被引用，无断链无孤儿。
2026-11-11T13:05:00Z — `reviews/review-01.md` 此前只存在于评审方的工作目录、未随任何分支推送，本次已一并纳入本分支，使评审记录与产物同处一处。

## 收口（review-02，2026-11-11T13:4x）

### Interpretations
2026-11-11T13:40:00Z — Major（技能解析不到时 fail-open）：编排层给了「只给四个工具继续跑」与「拒绝该轮并明确提示」两个选项，选后者。理由：只给工具不拒绝，模型会在一轮没有任何澄清策略与安全规则的情况下直接调 `create_github_issue`——渲染仍由工具确定性完成、审批闸门仍在，所以不会「未确认就公开」，但 issue 质量与那几条**提示词层的安全规则**（不主动索要联系方式、安全漏洞改道、不把笔记内容写进正文）会一起消失。触发条件是一个用户可见的设置开关，给可操作的提示比静默降级诚实。工具集仍同时收窄到「四个 ∪ read_skill」，两道一起上。

### Deviations
2026-11-11T13:40:00Z — 守卫的退出码处理从「合成一条管道读 `$?`」改为「先让 git 落盘并单独判它的码，再单独判 grep」。原来那句「pipefail 下 git log 的失败会以非 1 传出」的注释是**错的**——pipefail 取最右非零码，git 的 128 会被 grep 的 1 掩盖。这是我自己写错并写进注释的断言，评审与编排层各独立实测了一次。
2026-11-11T13:40:00Z — 顺带用 `mktemp` + `trap ... EXIT` 落盘 diff 文本，而不是把整段历史塞进一个 shell 变量：全量历史在稍大的仓库上可能很大，变量方案会把内存占用与「历史规模」直接挂钩。

### Tradeoffs
2026-11-11T13:40:00Z — 明确写下 ③（同步原子认领）是**冗余层**、作用面严格小于 ②，而不是把它包装成主要保障。这降低了它在文档里的「分量」，但一个被高估的机制比一个被低估的更危险——评审指出「② 之后 ③ 挡不住任何 ② 挡不住的东西，容易被当成主要保障」。
2026-11-11T13:40:00Z — `dedupKey` 的措辞从「这一次反馈的身份」改为「渲染时的内容派生键，一经派生不再随卡片编辑变化」，并显式写出「对话改写会派生新键、旧草稿留在 draft 并占用 20 上限」。原来的「身份」定性读起来像「对同一会话恒定」，按那个字面会写出「会话内只派生一次」的实现，反而破坏 ②。

### Open questions
2026-11-11T13:40:00Z — 两条按编排层决定留到实现阶段：① CI 的触发条件（`ci.yml` 的 `pull_request.branches: [main]` 按基分支过滤，stacked PR 不跑 CI）；② 给 `bug_report.yml` 的 provider dropdown 补 Anthropic 选项（补后决策表 3b 的例外集可清空）。
2026-11-11T13:40:00Z — `reviews/review-02.md` 与 review-01 同况：此前只在评审方工作目录，本次一并纳入本分支。
