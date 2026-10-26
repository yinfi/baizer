## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-10-26T08:06:44Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261021-pi-runtime-refactor/construction/code-generation/ > 缺少 `traceability.json` | 本阶段的产出清单里包含 `traceability.json`，计划的 Step 7.4 也点名了它，但该目录下只有 `code-summary.md`；全仓唯一的 `traceability.json` 在 `functional-design/` 下。`code-summary.md`「关于 traceability.json」给出的三条理由中，核心那条是「复用设计阶段那份会被设计阶段的语义校验误判为 GAP/ORPHAN」——这条只对「改写同一个文件」成立，推不出「本阶段不需要这份清单」：清单每条记录自带 `stage` 字段，工具按 `--stage build-and-test` 调用时读的是 Code Generation 的表。现在 FR/BR → 实现文件 → 验证用例 的映射只以散文表格存在于 `code-summary.md`，Build and Test 的覆盖率门读不到它，会把已经实现并验证过的需求报成未实现。 | 在 `construction/code-generation/traceability.json` 写出本阶段的追溯清单（逐条列出每个 FR/BR、对应实现文件、对应验证用例）；若确实要豁免这一产出，请由人在批准门明确豁免，并把豁免理由落到本记录里，而不是以「与设计阶段同名会互相污染」为由整体跳过。 | New |
| R-02 | Minor | src/runtime/pi/session-store/store.ts > `markDegraded()`（第 466-473 行） | 该方法会把 `availability='read_only_degraded'` 落盘，与本层自己声明的 BR1.3 不变量「迁移失败时降级只在本次 open 的内存结果里体现，原文件一个字节都不动」（同文件 `open()` 注释第 144 行；生产路径走 `openDegraded()`）直接冲突。它当前没有任何生产调用方，唯一调用者是 `test/session-store-branching.test.ts:202`。风险不在今天，而在后续有人把 BR1.3 的处理接到这个方法上——那份无法迁移的用户旧会话文件会被静默改写，正是 BR1.3 要避免的结果。 | 删除 `markDegraded()` 并同步删掉它的测试用例，或把它改成纯内存操作并在注释里写明它不落盘。 | New |
| R-03 | Minor | src/runtime/pi/session-store/store.ts > `appendEntry()` / `writeFile()` | 每追加一条 Entry 都要走一次「`load()` 全量读 → 改内存 → `writeFile()` 全量重写整个 JSONL 文件」。一次长对话（数百到上千条 Entry）因此退化成 O(n²) 的写放大，每次都要把整份历史重新序列化。代码注释自称「简单实现」，但会话文件是随使用时长单调增长的用户数据，不是一次性数据。 | 追加路径改为向文件尾 append 一行，只在迁移/压缩/分支切换这类必须整体重写的场景保留全量重写；或明确记录该取舍的容量上限与后续触发条件。 | New |
| R-04 | Minor | src/runtime/pi/session-store/store.ts > `appendEntry()` / `applyCompaction()` / `moveActiveLeaf()` / `markSuperseded()` | 四个写方法都是「读全文 → 改内存对象 → 写回全文」，彼此之间没有按 conversationId 串行化。同一会话上发生并发写时（例如流式回合进行中 UI 侧触发分支切换/重试，或两处同时 append），后一次写回会覆盖前一次的结果，丢 Entry 或把 `activeLeafEntryId` 指回旧值。 | 在 SessionStore 内按 conversationId 串行化写操作（一条 promise 链即可）；或在设计上明确禁止同会话并发写，并给出保障手段。 | New |
| R-05 | Minor | aidlc/spaces/default/intents/261021-pi-runtime-refactor/construction/code-generation/unit-test-instructions.md > 运行命令清单 | 文件里除 9 条按文件限定的命令外，还列了项目级的 `npx tsx test/run-tests.ts`（标注为「全量回归（Build and Test 阶段会跑）」）。这条不受单元范围限定，与文件其余部分「只跑本单元相关测试」的约定不一致；照抄它会把整仓测试拉起来，本单元测试自身的失败定位被掩盖。 | 把全量回归那条移出本文件的命令清单（或明确标注它不属于本阶段的单元验证命令），只保留按文件限定的命令。 | New |
| R-06 | Minor | test/bundle-size.test.ts > `BUDGET_BYTES` | 软预算由 4.6 MB 上调到 4.8 MB（2026-10-26，已获人工确认，理由与替代方案见 `code-summary.md`「体积预算决策」），NFR1 的 5 MB 硬限未动、仍成立。需要让人看到的是余量数字：本次构建产物 5,003,337 字节 = 4.77 MB，已用掉软预算的 99.4%，只剩约 30 KB；也就是说下一次任何轻微依赖膨胀都会让这个测试变红，而文档里已经点名的下一根杠杆（yaml 821 KB）还没有动。 | 在 `code-summary.md` 的体积预算决策里补上「软预算已消耗 99.4%、仅余约 30 KB」这一事实，并写明下一步的触发条件与首选动作。 | New |

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| `npx tsc -p tsconfig.json --noEmit` | PASS（0 个错误，EXIT:0） | FR1.2 成立；Step 2.3 记录的基线编译错误已全部修掉，没有遗留的悬空符号引用 |
| `npm run build` | PASS（EXIT:0），`dist/main.js` = 5,003,337 字节（4.77 MB） | NFR1 成立（低于 5 MB 硬限）；四个 esbuild 插件在 1.3.0 的新目录结构下仍然生效 |
| `npx tsx test/run-tests.ts` | PASS（EXIT:0，末行「Executed 100 test files successfully.」） | 全量 100 个测试文件全绿，含 4 个新增的会话持久化测试；计划 Step 7.3 的声明与实际运行结果一致 |
| `test/run-tests.ts` 注册清单 与 HEAD 对比 | HEAD 96 个 → 现 100 个（新增 `session-store-types`、`session-store-branching`、`session-store-migration`、`harness-session-manager-regression`） | 新增测试文件均已注册进运行器，没有被遗漏 |
| `aidlc engine testing-posture render` 与计划内 Testing Contract 块对比 | 逐字一致（`contract_sha256: sha256:be24de49065e6c54a26024b4a9117dabfa3bc2a5a7d4774a9ade02b7d86b1894`） | 计划的测试契约未被改写或放宽 |
| `src/runtime/pi` 内 `as any` 计数 与 HEAD 对比 | 减少（`new (pi as any).AgentHarness(...)` 已换成 `new pi.Agent(...)`） | NFR2 成立（`as any` 数量未增加）；FR3.1 的构造点已用真实类型 |
| `dist/main.js` 内容抽查 | 不含 `@mistralai/mistralai` 模块路径注释 | 未用 provider 存根仍生效，42 家 provider 未整体进入单文件 |

### Summary

主要担忧只有一条，且不是代码缺陷：本阶段的追溯清单 `traceability.json` 没有产出，导致 FR/BR → 实现 → 验证 的映射只以散文形式留在 `code-summary.md` 里，Build and Test 的覆盖率门读不到它——作者拒绝改写的理由（怕污染设计阶段那份同名文件）不足以支撑整体跳过，应当补写或由人在批准门显式豁免。其余五条均为 Minor，集中在自建持久化层的写路径（每次追加全量重写、写操作无按会话串行化、`markDegraded()` 会落盘且无生产调用方）与两处文档卫生问题；代码本身可编译、可构建、体积达标，全量 100 个测试文件实跑全绿，没有 Critical，Major 仅 1 条，按规则判为 READY。
