# 单元测试说明 —— pi 运行时底座重构

来源：`code-generation-plan.md`；Testing Contract（Minimal 策略，test-after 方法论）。

## 测试框架与配置

本仓没有第三方测试框架（无 Vitest/Jest），延续既有自建 runner 方式：

- 运行器：`tsx` 4.21.0 + `test/run-tests.ts`（硬编码文件路径数组，逐个 `execSync`）
- 每个测试文件：`tsconfig.test.json`（`module: commonjs`，`paths: { "obsidian": ["./test/__mocks__/obsidian.ts"] }`）
- 每个测试文件自带 `assert`，用 `console.log` 输出进度，任一断言失败即抛出异常使该文件以非零退出码结束

新增测试文件必须加入 `test/run-tests.ts` 的 `tests` 数组，否则不会被执行（这是本仓"全部测试文件必须在 runner 注册"的既有约定，CodeKB `code-quality-assessment.md` §2 记录）。

## 如何运行本次改造涉及的测试（每条命令都精确限定到单个文件，不是项目级命令）

```
npx tsx --tsconfig tsconfig.test.json test/pi-native-model.test.ts
npx tsx --tsconfig tsconfig.test.json test/pi-event-adapter.test.ts
npx tsx --tsconfig tsconfig.test.json test/pi-approval-policy.test.ts
npx tsx --tsconfig tsconfig.test.json test/harness-chat-runtime.test.ts
npx tsx --tsconfig tsconfig.test.json test/session-store-types.test.ts
npx tsx --tsconfig tsconfig.test.json test/session-store-branching.test.ts
npx tsx --tsconfig tsconfig.test.json test/session-store-migration.test.ts
npx tsx --tsconfig tsconfig.test.json test/harness-session-manager-regression.test.ts
npx tsx --tsconfig tsconfig.test.json test/bundle-size.test.ts
```

全量回归（Build and Test 阶段会跑）：

```
npx tsx test/run-tests.ts
```

## 覆盖目标（Minimal 策略）

需求驱动：每条 FR 至少 1 条可验证测试，每个受影响组件至少 1 条 happy-path 单测。预计新增/修改测试条数：

| 测试文件 | 对应 FR/BR | 类型 | 预计条数 |
|---|---|---|---|
| `test/pi-native-model.test.ts` | FR1.1-1.3, FR3.1 | 单测（修改） | 2-3 |
| `test/pi-event-adapter.test.ts` | FR3.3, BR3.1 | 单测（修改） | 3-4（决策表每个新增分支至少 1 条） |
| `test/pi-approval-policy.test.ts` | FR2.1, BR2.1 | 单测（修改） | 1-2 |
| `test/harness-chat-runtime.test.ts` | FR3.1, FR5.1 | 单测（修改） | 2-3 |
| `test/session-store-types.test.ts` | entities.md Session/Entry | 单测（新增） | 2-3 |
| `test/session-store-branching.test.ts` | FR2.1, BR2.2 | 单测（新增） | 3-4（根/追加/兄弟切换/编辑） |
| `test/session-store-migration.test.ts` | FR2.2, BR1.1-1.3 | 单测（新增） | 3-4（新格式直读/旧格式迁移/迁移失败降级/损坏文件） |
| `test/harness-session-manager-regression.test.ts` | FR2.1, FR5.1-5.2 | 单测（新增） | 3-4（多 tab 隔离/跨重启恢复/压缩判定/审批回灌可见性） |
| `test/bundle-size.test.ts` | FR4.1, NFR1 | 既有（重跑） | 0（既有断言复用） |

合计约 19-27 条新增/修改测试，落在 Minimal 策略"5-15 条"的指导区间之上是合理的：这是一次跨越式依赖升级，受影响符号多（12 个值符号 + 10-11 个类型符号，见 `requirements.md` FR1.3），Minimal 策略本身允许"需求明确但范围广时不要硬卡数量上限"。

## Mock/Stub 指引

- `obsidian` API 继续走现有 `test/__mocks__/obsidian.ts`（`tsconfig.test.json` 的 `paths` 映射），不新增 mock 机制
- pi 1.3.0 的 `Agent`/`streamFn` 在单测里用最小 stub 替代（不发真实网络请求）；参考现有 `test/pi-native-model.test.ts` 对 0.75.5 `completeSimple` 的既有 stub 方式，延续同一模式而不是引入新的 mocking 库
- vault adapter 的读写（session-store 测试）用内存实现的 `FileSystem` stub，不碰真实磁盘，延续 `VaultSessionFileSystem` 既有测试方式

## 数据管理

- 迁移测试（`test/session-store-migration.test.ts`）需要构造一份"旧格式"的示例 JSONL 内容作为测试固件（inline 字符串常量或 `test/__fixtures__/` 下的小文件，二者皆可，由实现者选择，但不得依赖真实用户会话文件）
- 分支测试的固件数据（根/子/兄弟 Entry）用测试文件内联构造，不依赖外部文件

## 执行顺序

延续 Testing Contract 的 test-after 方法论：先实现该层（数据模型/仓储/业务逻辑/API/构建配置），再写并运行该层的测试，按 `code-generation-plan.md` 的步骤顺序推进。Step 1（运行器核验）必须在第一个测试文件之前完成。
