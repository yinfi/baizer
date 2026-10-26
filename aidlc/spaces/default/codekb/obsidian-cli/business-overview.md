# 业务概览 — Baizer（obsidian-cli）

## 1. 产品定位

Baizer 是一款面向 **Obsidian** 的 AI 知识工作台插件（`manifest.json`：`id: baizer`，`isDesktopOnly: false`，最低 Obsidian 1.7.2）。名字取自《山海经》中"知万物之情"的白泽。

它不是一个"给 Obsidian 挂一个聊天框"的产品，而是一条**闭环管线**：外部信息进来 → 被理解与改写 → 沉淀为持久记忆 → 再喂回下一次写作。管线四段（Capture → Process → Remember → Consume）共用同一套 AI 运行时，因此知识是**复利式积累**而非堆放。

## 2. 业务领域

- **领域**：个人知识管理（PKM）/ 笔记增强 / 本地优先的 AI 写作助手
- **宿主平台**：Obsidian（桌面 + 移动端）
- **交付形态**：Obsidian 社区插件（单文件 `main.js` bundle + `manifest.json` + `styles.css`）
- **授权**：MIT；版本 1.0.2；当前为公开开源项目（仓库 `yinfi/baizer`）

## 3. 目标用户与核心价值

| 用户 | 痛点 | Baizer 提供 |
|---|---|---|
| 重度笔记用户 | 笔记只增不消化，检索靠记忆 | 知识 Wiki：把选定文件夹编译成可检索、可引用的结构化文章 |
| 写作者 | 写作时反复切换工具查资料 | Guardian：编辑器内行内补全（Ghost Text），不打断心流 |
| 研究者 | 收集的网页/视频散落各处 | 剪藏管线：网页正文抽取、视频转录、微信文章，自动转 Markdown 入 vault |
| 长期使用者 | AI 助手每次从零开始，不了解"我" | Hindsight 记忆：事实/经验/观察三类记录，跨轮召回并注入提示 |

## 4. 核心功能（四条业务线）

### 4.1 Workbench —— 聊天工作台

侧边栏中的流式对话工作区（`ShellView`）。模型可读写笔记、搜索 vault、剪藏网页、调用其它插件命令，过程以可折叠的"工具/思考时间线"呈现（Step N 分组）。

- 多标签会话（每个 tab 一条独立会话，跨轮上下文互不可见）
- 会话持久化为 vault 内 JSONL，支持跨重启恢复、自动压缩、分支切换与"重跑/编辑"定位
- 运行中"补话"（steering）：不打断当前流，把用户补充指令注入下一轮
- 审批卡片：写类/插件控制类操作在执行前弹卡片确认，可撤销

### 4.2 Guardian —— 编辑器内协作者

在光标处给出续写建议，Tab 接受、Esc 丢弃。**双路径**设计：

- **快路径**（自动触发，亚秒级）：只读元数据与局部上下文，每次按键即中止重算
- **深路径**（手动触发，或停留 1.2 秒后自动升级）：读笔记正文与知识库摘要，允许更慢、不被打字打断

质量门控宁可"沉默"也不给平庸补全；通过硬拦截但信息量低的续写会被标记为 `weak`，也纳入升级触发。

### 4.3 Knowledge Wiki —— 知识编译

把用户指定的源文件夹编译成结构化、可检索的 wiki 文章。

- **Map-Reduce 编译**：长文档分块抽取后归并
- **本体驱动**（ontology）：从笔记中归纳出类别/实体类型模式，后续抽取按模式进行
- **内容哈希陈旧判定**：每篇笔记在 frontmatter 中带编译状态（`pending` / `processing` / `done` / `failed`）与内容哈希
- **索引与巡检**：生成 `.base` 索引文件与健康报告（缺摘要、低置信抽取、孤儿概念）
- **回填**（file-back）：把高质量问答归档回知识库，成为可复用来源

### 4.4 Hindsight Memory —— 本地语义记忆

与知识 Wiki **完全独立**的两个存储（`CONTEXT.md` 明确区分）。

- **三类记录**：`world`（关于用户与其领域的持久事实）、`experience`（过往任务中有效/无效的做法）、`observation`（较轻的信号）
- **极性感知**：记录带 `positive` / `negative`，负面记录以"避免这样做"的形式约束后续生成，来源是用户的 👍/👎 反馈
- **提炼而非转储**：沉淀经模型提炼成可复用记忆；consolidator 周期性合并与退役
- **查询感知召回**：每轮按用户请求做 BM25 召回（可选 LLM 查询扩展、一跳实体图检索、同主题矛盾更新），格式化为 `[Relevant Memory]` 块注入提示

## 5. 三个产品界面

- **Workbench** —— 聊天优先的侧边栏：提问、搜索、剪藏、编辑、跑工具、查看 AI 执行过程
- **Guardian** —— 编辑器侧助手：在不离开笔记的情况下获得续写与改写
- **Knowledge Wiki** —— 编译器：把选定文件夹变成可被引用复用的结构化页面

## 6. 业务规则（可观测的约束）

| 规则 | 落点 |
|---|---|
| 只有 Tool 会执行；Skill 只改变模型读什么 | `CONTEXT.md`；`src/skills/types.ts`（`Tool` 有 `execute`，`Skill` 无执行路径） |
| Skill 可用性与权限正交，**唯一例外**是派生技能（`plugin-*` 需插件控制权限） | `src/skills/skill-registry.ts:397`（`disabledSkills` 是唯一来源）；`CONTEXT.md` |
| 关键词命中**永不**收窄工具集，只给一行提示 | `docs/adr/0002-keyword-matches-never-narrow-the-tool-set.md`；`src/runtime/base-chat-runtime.ts:363` |
| 空 `tools` 声明 = 不限制（必须按 `length` 判，空数组是 truthy） | `src/runtime/base-chat-runtime.ts:169-174,373` |
| 收窄工具集时 `read_skill` 必须始终保留，否则渐进式披露断链 | `src/runtime/base-chat-runtime.ts:329,341`；`src/runtime/active-run-controller.ts:78` |
| 破坏性操作受 `confirmExecutions` 约束（write / plugin-control 需批准） | `src/permissions/permission-service.ts:109` |
| 隐私模式开启时**跳过**旧记忆迁移导入（"这台机器不沉淀我的数据"） | `src/memory/memory-manager.ts:88` |
| 派生技能是缓存，真相是来源插件的当前状态；每次启动对账 | `CONTEXT.md`；`main.ts:151` `reconcileDerivedSkills()` |
| 禁止 `child_process` 等 Node API（移动端兼容） | 本仓 `CLAUDE.md`；`src/runtime/pi/harness-env.ts:37,128` 显式返回 shell 不可用 |
| bundle 必须 < 5 MB（Obsidian Sync Standard 同步上限） | `esbuild.config.mjs:23-43`；`test/bundle-size.test.ts` |

## 7. 成功度量（可从代码观察到的部分）

- 插件体积：`main.js` 受 5 MB 硬约束（`test/bundle-size.test.ts`）
- 启动阻塞：内置 skill 物化写盘已移出 `onload` 同步路径（`main.ts:155-158`），并有 `test/startup-io-budget.test.ts` 守卫
- 测试规模：95 个测试文件，全部在 `test/run-tests.ts` 注册且必须全绿
- 发布合规：`test/release-guidelines.test.ts` 断言 README/manifest/CHANGELOG 一致性

## 8. 术语边界（易混概念，取自 `CONTEXT.md`）

- **Tool vs Skill**：Tool 是模型可调用的动词（有 JSON schema 参数、有风险分类）；Skill 是模型可读的建议（Markdown 指令文档，自身无 vault/网络访问路径）
- **Memory vs Knowledge Wiki**：两个完全独立的存储，互不流动。Memory 是交互副产物；Wiki 是用户笔记的编译产物
- **Built-in / User / Derived Skill**：内置（仓库内，磁盘副本是每次启动覆写的缓存）、用户（用户手写，磁盘就是原件）、派生（由已安装插件生成，来源与权限任一失效即不再提供）
- **Fast vs Deep（Guardian）**：快路径亚秒级、元数据检索、打字即中止；深路径读正文与知识库、不被打字打断、每锚点最多升级一次

## 9. 相关文档

- 模块级地图：`CLAUDE.md`
- 领域词汇表：`CONTEXT.md`
- 架构专题：`docs/architecture/runtime.md`、`skills.md`、`permissions.md`、`settings.md`
- 决策记录：`docs/adr/`
- 用户文档：`README.md` / `README.zh-CN.md`
