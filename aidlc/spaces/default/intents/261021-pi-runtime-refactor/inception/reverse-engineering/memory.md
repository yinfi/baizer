<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
<!-- example: 2026-05-29T10:14:32Z — chose REST over GraphQL; the consuming team only needs CRUD, revisit if subscriptions land -->
- 2026-10-21T09:52:10Z — 把 `.gitignore` 忽略的根文件当作"未打开"，而不是当作项目代码扫描；虽然任务说明提到 `AGENTS.md` 的"其余部分"属于项目自己，但该文件在本仓 `.gitignore` 第 44 行被显式忽略（与 `FORYF.md`、`TODOS.md` 同组，注释为"项目私有/个人文件,不入库"），故按"读仓库的 .gitignore 并跳过其中忽略的内容"处理，把它列入 Scan Coverage 的 Left out 而非 Skimmed。
- 2026-10-21T09:52:10Z — 把 `docs/superpowers/` 整目录跳过（含 19 份 spec 与 18 份 plan）；它同样被 `.gitignore` 第 48 行忽略，虽然其中 `2026-05-25-pi-runtime-refactor.md` 与 `2026-07-04-pi-harness-refactor-design.md` 与本 intent 主题高度相关。取舍理由：忽略规则优先，且指纹工具本身也会把这些文件排除在覆盖之外，纳入会让"报告的范围"与"可验证的范围"不一致。
- 2026-10-21T09:52:10Z — 把 `src/ui/guardian-completion.ts` 当作文本文件读取分析，尽管 `grep` 因文件内某个字节把它判定为二进制；该文件是 Guardian 双路径补全的核心（1039 行），跳过会让 UI 层组件清单失真。同一现象在 code-quality-assessment 的 T16 中记为债务。

## Deviations
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->
- 2026-10-21T09:52:10Z — 未运行项目的测试、构建或任何程序，严格只读代码；因此 `code-quality-assessment.md` 中"95 个测试文件全部在 runner 注册且必须全绿"是**结构性观察**（清单与磁盘文件一一对齐已核验），不是"测试实际通过"的实测结论。本阶段的规则明确禁止运行项目测试，故该断言如实标注为结构一致性而非执行结果。

## Tradeoffs
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->
- 2026-10-21T09:52:10Z — 组件清单按 **20 个逻辑组件**组织，而不是按 `src/` 的目录结构逐目录罗列；后者会把 `services/`（13 个文件）这类松耦合目录当成一个"组件"，而前者把 `ModelService 门面` 与 `服务层（横切）` 分开，使职责边界与依赖关系可读。代价是重跑守卫比对组件名时依赖本文件标题的稳定性。
- 2026-10-21T09:52:10Z — `api-documentation.md` 在 Minimal 深度下只列 25 个工具的名称/风险/执行模式/必填参数与权限门，不逐参数展开 JSON schema；完整 schema 可从 `src/skills/builtin/**` 源码直接读到，逐条抄写既冗长又会随代码漂移。同一信息在 `component-inventory.md` 只以交叉引用出现，不重复。
- 2026-10-21T09:52:10Z — 选择 `kind: full` 并把 `analyzed.paths` 写成 `./`，代价是必须承认"整仓深度覆盖"。为此把实际只做结构确认的 `styles.css`（110 KB）与 `assets/` 如实降级到 `shallow.paths`，而不是笼统声称全部深读。

## Open questions
<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
- 2026-10-21T09:52:10Z — `docs/architecture/runtime.md` 的文件清单仍指向已删除的 `src/runtime/steering-controller.ts`，`CLAUDE.md` 也提到已退役的 `PiChatRuntime`；本次按规则未改动任何源码或文档，但这些漂移是否应纳入本 intent 的改造范围（例如作为"迁移不充分"的证据之一），需在后续阶段确认。
- 2026-10-21T09:52:10Z — 本次扫描时工作树有 5 个未提交改动（`fix/startup-blocking-io` 分支上的 OpenCode Go 会话头）。指纹覆盖磁盘现状，故 CodeKB 已包含它们；但若这些改动在后续阶段被回滚或改写，本份 Scope of Analysis 的指纹会失效并触发重扫。

## Deviations
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->
- 2026-10-21T02:12:52Z — 本阶段以 pipeline 但只有唯一环节运行（collaborators 为 off，链条只有 aidlc-developer-agent），因此开发环节同时承担扫描与九件产物合成，没有架构师环节。这偏离了阶段正文描述的"开发扫描 → 架构师合成"两环链条，是有效 support_agents 为空的直接结果。
- 2026-10-21T02:12:52Z — 被委派的开发环节在写完交付物、指纹 check 已返回 VALID 之后，因模型上下文上限报错提前终止，其返回摘要与部分日记条目未产出。conductor 未重新派发整轮扫描（重跑会覆盖已完成产物并再次撞上同一上限），改为在磁盘上逐项核验交付物：交接文件含全部三个必需标题、九件产物齐备且结构完整、指纹 check 返回 VALID，随后完成发布。该失败与处理方式已记入审计。

## Tradeoffs
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->
- 2026-10-21T02:12:52Z — 重跑守卫结论为 NO_STORE，按阶段规则不向人提问扫描广度，直接按全量扫描整个仓库（`./`）执行；代价是首次 CodeKB 需要一次覆盖全仓的深度扫描，也是本轮派发触及上下文上限的原因之一。

## Open questions
<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
- 2026-10-21T02:12:52Z — 本轮"全仓扫描 + 九件产物"的单次派发已触及模型上下文上限；若后续阶段仍需同等规模的单次派发，是否应改为分段派发（例如按 `src/` 子目录分批扫描后合成），需在 Requirements Analysis 之前确认。
