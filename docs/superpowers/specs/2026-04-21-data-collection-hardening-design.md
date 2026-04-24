# 数据采集与记忆链路加固设计

## 背景

当前插件已经具备 4 条和“采集数据”直接相关的链路：

1. `save_webpage` 将网页、YouTube、Bilibili 内容抓取并落盘到 vault。
2. `ContextManager` 在聊天发送前抓取临时 URL/视频上下文。
3. `MemoryManager` 记录聊天历史、用户画像和会话摘要。
4. WeChat Inbox 监听 `Inbox.md` 变更并自动把裸链接转成已保存笔记。

这几条链路已经能工作，但存在一些会直接影响正确性和稳定性的缺陷：

- 视频摘要路径调用了错误的 `ModelService.chat()` 签名，可能把错误字符串写入笔记。
- `MemoryManager` 构造阶段异步加载未被等待，存在启动早期读到空 memory、晚到磁盘加载覆盖新数据的竞态。
- 会话摘要生成时没有使用真实会话内容，摘要质量不可用。
- 切换 provider / model / settings 时没有先结束并保存当前 memory session，容易丢摘要和会话数据。
- Inbox 自动采集按旧快照整文件回写，用户中途编辑或重复触发时存在覆盖和重复采集风险。
- 临时上下文采集和正式落盘链路不一致，`ShellView` 还会携带陈旧 selection。
- `web_search` 和 `save_webpage` 缺少 HTTP 状态校验与轻量重试，容易把 202/403/反爬页当成功结果解析。

## 目标

本轮修复选择“方案 B：核心 + 稳健性”，目标如下：

1. 修复所有会导致错误结果、错误摘要或数据丢失的核心问题。
2. 给采集链路补上最小但有效的并发保护、状态校验和失败降级。
3. 让聊天临时上下文和正式保存链路尽量复用同一份抓取逻辑。
4. 为关键路径补回归测试，确保后续迭代不会把这些问题带回来。

## 非目标

本轮明确不做以下工作：

- 不重做整个 skill / tool 架构。
- 不把所有网络请求统一抽成一个共享抓取框架。
- 不扩展插件 skill generator 的远程资料采集能力。
- 不引入新的外部依赖，只在现有 TypeScript / Obsidian API / `tsx` 测试方式下完成修复。

## 方案概览

### 1. `save_webpage` 视频摘要改为无状态生成

`save_webpage` 的视频摘要不应该走带 memory、contextItems 和 tool loop 的 `ModelService.chat()`，而应走 `ModelService.generate()` 这类单轮、无状态接口。

修复方式：

- 在 `src/skills/builtin/web-clipper/executor.ts` 中新增内部摘要 helper。
- 当 `modelService.generate()` 可用时，直接用单轮 prompt 生成摘要。
- 如果生成失败、返回空文本、或返回明显错误文本，则降级为“保存视频链接 + transcript excerpt”，而不是把错误字符串写入正文。
- 保持现有 note frontmatter、命名和落盘路径逻辑不变。

这样做的好处是：

- 避免错误的 `chat()` 参数约定导致崩溃。
- 避免摘要请求污染当前聊天 session 和记忆上下文。
- 降低 `save_webpage` 的副作用，使它更接近纯工具。

### 2. `MemoryManager` 增加初始化屏障和真实会话摘要

`MemoryManager` 当前在构造函数里异步加载 profile / summaries / history，但调用方没有等待，导致存在竞态。

修复方式：

- 在 `MemoryManager` 内引入 `initPromise` / `ready()`。
- 所有会读取或写入 memory 状态的公开方法在必要时先 `await ready()`。
- `ModelService.chat()`、`chatStream()`、`clearSession()`、`updateProfile()`、`learnFromMessages()`、`shutdown()` 在调用 memory 前显式等待 ready。
- 新增 `currentSessionTranscript`，只保存当前 session 的 user/model 消息，用于 `endSession()` 生成摘要。
- `generateSessionSummary()` 的 prompt 必须包含当前 session transcript 的压缩内容，而不是空指令。

这样可以同时解决：

- 启动早期读不到已持久化 memory。
- 晚到的磁盘加载覆盖新消息。
- 会话摘要没有真实输入。

### 3. provider/model/settings 切换前显式 flush memory session

当前切换 provider / model / settings 时，`ModelService` 直接清掉 `memoryManager` 引用，导致当前 session 的摘要和上下文可能丢失。

修复方式：

- 在 `ModelService` 中增加 `flushMemorySession()`。
- 该方法负责：
  - `await memoryManager.ready()`
  - `await memoryManager.clearSession()`
  - `await memoryManager.save()`
- 在 `switchProvider()`、`switchModel()`、`updateSettings()`、`shutdown()` 中统一复用。
- 如果 `updateSettings()` 需要异步化，则同步更新它的调用方，尤其是插件 `saveSettings()`。

### 4. 提取 Inbox 自动采集协调器，解决并发覆盖

`main.ts` 当前在文件变更后直接：

1. 读取整文件内容
2. 串行抓取多个 URL
3. 基于旧快照写回整文件

这在用户中途编辑和重复触发时风险很高。

修复方式：

- 新建 `src/services/inbox-autosave.ts`，抽出纯逻辑和串行协调逻辑。
- 新服务负责：
  - 提取裸 URL match。
  - 按文件 path 串行化处理，避免同一文件并发重入。
  - 在真正写回前重新读取最新文件内容，只替换仍然存在的原始 URL。
  - 若 URL 已被用户改成链接或删除，则跳过，不覆盖用户新内容。
- `main.ts` 只保留监听和委托调用。

这样可以把最难测的逻辑从 plugin 主类里拿出来，同时控制重入。

### 5. 统一临时上下文抓取逻辑，修正陈旧 selection

当前 `ContextManager` 自己维护了一份弱化版 YouTube transcript 抓取，而正式保存使用 `getVideoTranscript()`。两条链路对同一链接可能拿到不同结果。

修复方式：

- `ContextManager` 不再自己解析 YouTube 页面，改为直接复用 `src/utils/video_utils.ts` 中的 `getVideoTranscript()`。
- URL context 继续保留普通网页文本抓取，但补上 HTTP 状态判断和错误返回。
- `ShellView.processCommand()` 在每次发送前先把 `currentSelection` 重置为空串，再尝试从当前 editor 读取，杜绝沿用上一轮 selection。
- 粘贴纯文本 URL 时，普通网页也允许进入 context chip，而不是只识别 YouTube。

### 6. `web_search` / `save_webpage` 补 HTTP 校验和轻量重试

目标不是做完整爬虫框架，而是避免明显坏结果。

修复方式：

- `web_search`：
  - 检查 `response.status`。
  - 对 DuckDuckGo 的 `202` / 明显过短页面做 2~3 次轻量重试。
  - 保留空结果返回，但不要把无效 HTML 当成功解析。
- `save_webpage`：
  - 检查网页响应状态是否为 `200`。
  - 若 Readability / Markdown 转换失败，返回明确错误而不是默默写入“Conversion failed.” 占位文本，或至少让调用方感知这是降级结果。
- `ContextManager.fetchWebContent()` 也同步补状态检查，避免错误页进入聊天上下文。

## 文件边界

本轮涉及的文件边界如下：

| 文件 | 动作 | 责任 |
|------|------|------|
| `src/skills/builtin/web-clipper/executor.ts` | Modify | 修复视频摘要路径、网页抓取状态校验、明确降级 |
| `src/memory/memory-manager.ts` | Modify | 初始化屏障、当前 session transcript、真实会话摘要 |
| `src/services/model-service.ts` | Modify | memory ready / flush 生命周期管理 |
| `src/services/inbox-autosave.ts` | Create | Inbox URL 提取、串行协调、merge-safe 回写 |
| `main.ts` | Modify | 用新协调器替代内联 Inbox 自动采集 |
| `src/services/context-manager.ts` | Modify | 复用 `getVideoTranscript()`，补网页状态校验 |
| `src/ui/shell-view.ts` | Modify | 清理陈旧 selection，允许普通 URL 进入 context |
| `src/skills/builtin/web-search/executor.ts` | Modify | DuckDuckGo 状态校验与轻量重试 |
| `test/web-clipper.test.ts` | Create | `save_webpage` 视频摘要 / 网页错误路径回归 |
| `test/memory-manager.test.ts` | Create | memory 初始化屏障、摘要输入、持久化竞态回归 |
| `test/model-service.test.ts` | Create | provider/model/settings 切换前 flush 回归 |
| `test/inbox-autosave.test.ts` | Create | 串行处理、latest-content merge、安全跳过 |
| `test/context-manager.test.ts` | Modify | 共享 transcript 抓取与网页错误处理回归 |
| `test/web-search.test.ts` | Create | 202 重试、空结果、错误状态回归 |

## 测试策略

### 自动化测试

- 新增以 `tsx` 直接执行的轻量测试文件，保持和仓库现有测试风格一致。
- 核心测试优先覆盖：
  - 错误调用不再把 error string 落盘。
  - memory 在异步加载未完成时不会读空、不会覆盖新消息。
  - session summary 使用真实 transcript。
  - provider/model/settings 切换前一定 flush。
  - Inbox 处理不会覆盖较新的文件内容。
  - DuckDuckGo `202` 页面会重试。

### 手工验证

- `/save <youtube-url>`：摘要正常，失败时降级为链接 note。
- `/save <普通网页>`：403/错误页不再被误保存为正常文章。
- 修改 `Inbox.md`，同时快速追加新内容：不会覆盖后写入的文本。
- 在编辑器取消选区后发送消息：prompt 中不再携带旧 selection。

## 风险与控制

### 风险 1：`updateSettings()` 异步化影响调用链

控制方式：

- 只在必要处把调用链升级为 `await`。
- 先补测试，再收敛到最小调用面。

### 风险 2：Inbox 协调器提取后行为变化

控制方式：

- 保持原有 URL 匹配规则不变。
- 先提纯逻辑到可测试模块，再把 `main.ts` 接上。

### 风险 3：上下文链路统一后 token 量变化

控制方式：

- 对 transcript 和网页文本做长度截断，保持临时上下文可控。
- 这轮不做更激进的自动摘要，只保证正确和稳定。

## 执行顺序

推荐执行顺序：

1. 修 `save_webpage` 视频摘要错误路径。
2. 修 `MemoryManager` 初始化和会话摘要。
3. 修 `ModelService` 生命周期 flush。
4. 抽 Inbox 自动采集协调器并接入。
5. 统一临时上下文抓取、修 selection。
6. 补 `web_search` / 网页抓取状态校验和重试。
7. 统一跑回归测试和手工 smoke。

## 结论

方案 B 不是“大重构”，而是把当前最影响正确性的采集链路加固到“可依赖”的程度：

- 错误不会静默写入笔记。
- memory 不会在初始化和切换生命周期里丢数据。
- Inbox 自动采集不会轻易覆盖用户内容。
- 临时上下文和正式保存链路不再相互漂移。
- 关键路径有回归测试兜底。
