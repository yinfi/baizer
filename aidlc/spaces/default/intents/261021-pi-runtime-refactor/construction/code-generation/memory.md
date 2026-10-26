<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is kept up to date automatically while the stage runs. Add observations at the review step, not by editing here directly.

## Interpretations
<!-- example: 2026-05-29T10:14:32Z — chose REST over GraphQL; the consuming team only needs CRUD, revisit if subscriptions land -->
- 2026-10-23T03:41:28Z — 生成前先把 `fix/startup-blocking-io` 合并进 `main`（合并提交 577e9ef），使本次 build 的基线已含 PR #49 的 provider 自定义 header 机制；计划 Touches 里的 `harness-chat-runtime.ts`/`pi-native-model.ts` 正是该合并涉及的文件
- 2026-10-26T16:04:00Z — 复核 `code-generation-plan.md` 的 Step 7.2/7.3 时发现盘上状态自相矛盾：7.2 已勾选（口径是「产出成功且 < 5 MB」，早已满足），7.3 未勾选并把失败原因归给 `bundle-size.test.ts`。实为同一件事的两个口径 —— 7.3 的动作「运行全部测试文件」确实被那条软预算挡过，故当时的「不勾选」是诚实的；补齐决策后一并勾选

## Deviations
<!-- example: 2026-05-29T10:14:32Z — skipped the optional caching layer the stage prose suggested; the dataset is small enough that it adds risk -->
- 2026-10-26T16:04:00Z — 改动 `test/bundle-size.test.ts` 的 `BUDGET_BYTES`（4.6 MB → 4.8 MB），超出计划 Step 5 的文字范围（Step 5 只讲 esbuild 存根）。经人工确认后执行：该阈值是仓库自设的预警余量而非计划验收标准（计划要求的是 5 MB 硬限，一直通过），且方案 1（自建 frontmatter 解析器替换 `yaml`）需新写解析器并承担正确性风险，为省 820 KB 不值得

## Tradeoffs
<!-- example: 2026-05-29T10:14:32Z — picked TDD over BDD this run; the team is unit-first and the domain is well-understood -->
- 2026-10-23T03:41:28Z — 合并冲突取 main 侧（通用 `ProviderConfig.customHeaders` + `{{conversationId}}`，已接通设置界面/i18n/model-service）；分支侧在 harness 里硬编码 `x-opencode-session` 的做法被取代，其 `buildOpenCodeGoHeaders` 仍保留在无状态路径 `createNativeCompleteFn`（main 那条路径原本不发任何 header）
- 2026-10-26T16:04:00Z — 体积预算选了「上调阈值」而非「换掉 `yaml`」：5 MB 硬限（Obsidian Sync 的真实用户影响）是必须守的，4.6 MB 只是仓库自设的预警余量。为守住一条自设余量去改 4 个文件的 frontmatter 解析路径，是用正确性风险换一个并非用户可见的指标 —— 代价与收益不成比例。上调后仍有 0.23 MB 余量，足以挡住下一次意外膨胀

## Open questions
<!-- example: 2026-05-29T10:14:32Z — confirm the retention window with compliance before the next stage hardens the schema -->
- 2026-10-23T03:41:28Z — 升级到 pi 1.3.0 后，无状态路径是否仍需要 `buildOpenCodeGoHeaders`，还是统一走 `resolveCustomHeaders`
