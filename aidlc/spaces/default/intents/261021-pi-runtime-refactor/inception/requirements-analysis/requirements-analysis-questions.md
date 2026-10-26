# Requirements Analysis — 澄清问题

## 已在对话中确认的两项范围决定（记录存档，无需再答）

- **技术选型**：继续使用 `@earendil-works/pi-agent-core` / `@earendil-works/pi-ai`，不引入 DeepSeek Harness。理由：DeepSeek Harness 定位是独立终端编码代理（`dsh` CLI），嵌入第三方宿主只能走进程外 stdio JSON-RPC SDK server，这与 Obsidian 移动端禁用 `child_process` 的硬约束（本仓 `CLAUDE.md`、`manifest.json` `isDesktopOnly: false`）直接冲突；且它 2026-08-13 才开源，仍是"开发者预览"，官方 README 明确写着会有破坏性变更。
- **升级范围**：本次重构把"彻底用好 pi-agent 现有能力"与"把 pi-agent-core / pi-ai 从 0.75.5 升级到当前最新 1.3.0"合并为同一件事，一次性完成，不拆成两个独立任务。核心已知影响：`SessionRepo` / `JsonlSessionRepo` 持久化 API 在 1.x 中整体消失，现有会话分叉/重试/分支切换语义需要自建持久化层承接（详见 `aidlc/spaces/default/codekb/obsidian-cli/architecture.md` §8 "改进机会" 与本记录 `project.md` 之外的调研依据）。

## Q1. [开发] 会话持久化迁移到自建层后，对"行为"和"落盘格式"的保真度要求是什么？

现有的 `HarnessSessionManager` + `VaultSessionFileSystem` 整套建立在 pi-agent-core 0.75.5 自带的 `JsonlSessionRepo` 之上，支持：per-conversation 会话隔离、JSONL 落盘、自动压缩（`maybeCompact`）、分叉/重试（`session.moveTo` + 分支重投影）、审批结果回灌（`appendCustomMessageEntry`）。升级后这套能力必须自建。哪一种是这次改造要达到的标准？

- A. 用户可见行为必须逐项保持一致（多 tab 独立会话、JSONL 可读、分叉/重试/分支切换、审批回灌都不能变语义），但内部实现、存储的 JSON 结构细节可以改变
- B. 除上述行为一致外，vault 内已落盘的 JSONL 文件的**字节格式**也必须保持可读（旧会话文件要能被新代码直接打开，不需要迁移脚本）
- C. 允许在这次改造中顺带调整某些行为细节（例如压缩触发阈值、分支投影算法），只要在 PR 描述里说明变化点
- X. Other (please specify)

[Answer]: A. 行为一致，内部结构可改

## Q2. [开发] 已有的旧版会话文件（vault 里现存的 JSONL）升级后如何处理？

- A. 必须能继续读取和续写现有会话文件（无感迁移），新会话也用新格式
- B. 现有会话文件允许在首次打开时自动转换/迁移到新格式，迁移过程需要有测试覆盖
- C. 不要求兼容旧文件；用户升级插件后旧会话可以作废，只要新建会话正常工作即可（在 README/CHANGELOG 里说明即可）
- X. Other (please specify)

[Answer]: B. 首次打开时自动迁移

## Q3. [架构] 除了会话持久化，CodeKB 已记录的"pi 能力消费清单"（`technology-stack.md` §8：12 个值符号 + 11 个类型符号，`AgentHarness` 只用 8 个配置面、事件只映射 4 类、会话 API 被手抄成本地接口）是否就是这次"把 pi-agent 用深、用透"要覆盖的完整清单，还是你还有其它具体想补进来的 pi 能力（例如 `steer()`/`setActiveTools()` 之外的调度能力、新版 `transformHeaders` 机制、`prepareRequest`/`finishTurn` 钩子等）？

- A. 就按 CodeKB 记录的清单为基线：把窄事件映射、手抄的会话接口、只用 8/配置面这些"没用深"的点都在这次补齐/校正
- B. 基线之外，我还想明确要求补上以下 1.x 新增能力：______（请具体说明）
- X. Other (please specify)

[Answer]: A. 按 CodeKB 清单为基线

## Consolidated Summary Confirmation

- 技术选型：继续用 pi-agent，不引入 DeepSeek Harness（进程外 SDK server 与移动端禁 child_process 冲突，且其仍是开发者预览）
- 升级范围：本次把"用深 pi-agent 现有能力"和"升级到 pi-agent-core/pi-ai 1.3.0"合并为一件事
- Q1：会话持久化自建层后，用户可见行为必须逐项保持一致，内部 JSON 结构可以改变
- Q2：vault 里已有的旧会话 JSONL 文件，首次打开时自动迁移到新格式，迁移要有测试覆盖
- Q3：以 CodeKB `technology-stack.md` §8 记录的 pi 能力消费清单为这次"用深/校正"的完整基线

Does this all look correct before I generate the requirements artifact?

- Looks correct
- Request changes

[Answer]: Looks correct
