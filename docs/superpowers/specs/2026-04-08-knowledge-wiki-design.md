# Knowledge Wiki 设计

**Date:** 2026-04-08
**Project:** `baizer`
**Status:** Proposed design, pending spec review

## 目标

为 Baizer 插件新增 LLM Wiki 功能：将指定文件夹中的笔记自动编译为结构化知识库，并在 Shell 问答和 Guardian 写作补全中消费这些知识，让 AI 输出融入用户个人积累，而非千篇一律的通用回答。

## 动机

当前插件能保存内容、对话、辅助写作，但不会把已有素材编译成可复用的知识层。用户积累的笔记和剪藏散落在 vault 中，AI 回答和补全无法利用这些个人知识，导致输出缺乏个性和深度。

参考 Karpathy 提出的 LLM Wiki 模型：
- 原始文件保持本地、显式、不可变
- AI 将原始素材编译为结构化 wiki 页
- 系统维护索引、链接和健康检查
- 用户保持完全控制，输出是本地可检视的 Markdown

## 范围

### 包含

- 指定文件夹监听，新建/修改笔记自动入队编译
- 手动编译单篇笔记和批量编译
- 笔记 → 结构化 summary 页的 AI 编译
- 全局索引和 topic 索引维护
- 健康检查和 lint 报告
- Shell 问答通过 `query_knowledge` 工具消费知识库
- Guardian 补全时预注入知识上下文
- 回填机制：Shell 对话中的高质量回答自动归档回 Wiki，知识库越用越丰富
- 默认关闭自动编译，可在设置中开启
- wiki 优先检索 + vault 搜索补充

### 不包含

- 向量索引 / embedding 检索
- 图片理解
- 自主 agent 行为
- 修改原始笔记内容
- 全 vault 笔记自动编译（仅限指定文件夹 + 手动单篇）

## 整体架构

系统分为编译层（离线）和消费层（在线），共四个核心模块：

```
编译层（离线）                          消费层（在线）
┌─────────────────────┐              ┌─────────────────────┐
│  Folder Watcher     │              │  query_knowledge    │
│  监听指定文件夹      │──入队──▶     │  MCP 工具           │
│                     │              │  (读 index → 选文章) │
├─────────────────────┤              ├─────────────────────┤
│  Knowledge Compiler │              │  Shell 集成         │
│  笔记 → summary 页  │──产出──▶     │  系统提示词引导 AI   │
│                     │              │  主动查阅知识库      │
├─────────────────────┤              ├─────────────────────┤
│  Wiki Indexer       │              │  Guardian 集成      │
│  维护 index.md      │──供给──▶     │  补全前注入知识上下文 │
│  + topic 页         │              │                     │
└─────────────────────┘              └─────────────────────┘
         │
    Knowledge Wiki/
    ├── index.md          (全局索引)
    ├── Articles/         (summary 页)
    └── Topics/           (topic 页)
```

关键设计决策：

1. 新增 `src/knowledge/` 子系统，不膨胀 `main.ts` 和 `tools.ts`
2. 编译用无状态 AI 调用，不复用 Shell 的聊天会话和记忆
3. 消费通过 `query_knowledge` 工具，复用现有 function calling 机制
4. 指定文件夹监听，用户在设置中配置 `knowledgeSourceFolders`
5. wiki 层是派生产物，可以随时重建

## 编译层

### Unit 1：文件夹监听（Folder Watcher）

**职责：** 监听指定文件夹，将新建/修改的笔记自动入队。

触发条件：
- 用户在设置中配置 `knowledgeSourceFolders`（如 `["Clippings", "Reading Notes"]`）
- 监听这些文件夹下的 Markdown 文件创建和修改事件
- 默认关闭（`knowledgeAutoCompile: false`），用户可在设置中开启

入队逻辑：
- 新建文件 → 立即入队为 `pending`
- 修改文件 → 如果已编译过（`done`），标记为 `stale` 等待重编译
- 文件删除 → 标记 `missing_source`
- 文件重命名 → 更新 registry 中的路径

防抖：文件修改事件 debounce 1 分钟，避免频繁触发。

### Unit 2：知识注册表（Registry）

**职责：** 跟踪哪些笔记已进入知识管线及其当前状态。

存储位置：`.obsidian/baizer/knowledge-registry.json`

注册表记录结构：

```json
{
  "schema_version": 1,
  "records": {
    "ksrc_abc123": {
      "id": "ksrc_abc123",
      "path": "Clippings/karpathy-second-brain.md",
      "status": "done",
      "created_at": "2026-04-07T10:00:00Z",
      "updated_at": "2026-04-08T12:00:00Z",
      "summary_path": "Knowledge Wiki/Articles/ksrc_abc123.md",
      "error": null
    }
  }
}
```

状态机：

| 状态 | 含义 | 可转移到 |
|------|------|----------|
| `pending` | 等待编译 | `processing`, `missing_source` |
| `processing` | 正在编译 | `done`, `failed`, `partial`, `missing_source` |
| `done` | 编译完成 | `stale`, `missing_source` |
| `stale` | 源文件已修改，需重编译 | `pending`（批量编译或手动触发时转换）, `missing_source` |
| `failed` | 编译失败 | `pending`, `missing_source` |
| `partial` | summary 成功但索引失败 | `pending`, `missing_source` |
| `missing_source` | 源文件已删除 | `pending`（如果文件恢复） |

ID 生成规则：
- 格式 `ksrc_<随机后缀>`，由插件生成，不依赖 AI
- 一个笔记文件对应一个 knowledge source，即使 URL 相同
- 重复 ID 冲突时报错，不静默合并

启动恢复：插件重启时，`processing` 状态重置为 `pending`。

### Unit 3：编译器（Compiler）

**职责：** 将一篇原始笔记编译为一个结构化 summary 页。

输入：原始笔记全文 + 路径元数据

AI 提取字段：
- `title` — 文章标题
- `author` — 作者
- `source_url` — 来源 URL（如果 frontmatter 中有 `source` 字段）
- `created_at` — 创建时间
- `topics` — 标准化 topic（slug + 显示标签）
- `concepts` — 关键概念列表
- `key_claims` — 核心观点/论断
- `review_flags` — 低置信度标记

输出：一个 summary 页 `Knowledge Wiki/Articles/<id>.md`

Summary 页结构：

```yaml
---
knowledge_generated: true
knowledge_source_id: "ksrc_abc123"
title: "Karpathy 的第二大脑"
source_url: "https://mp.weixin.qq.com/..."
author: "新智元"
created_at: "2026-04-05T09:46:50Z"
compiled_at: "2026-04-08T12:00:00Z"
topics:
  - slug: "second-brain"
    label: "Second Brain"
  - slug: "llm-wiki"
    label: "LLM Wiki"
concepts: ["知识编译", "LLM Wiki", "第二大脑"]
key_claims:
  - "原始文件保持本地可控"
  - "AI 编译成结构化知识层"
review_flags: []
---
# Karpathy 的第二大脑

## 摘要
（AI 生成的结构化摘要）

## 核心观点
- 原始文件保持本地可控
- AI 编译成结构化知识层

## 关键概念
- 知识编译
- LLM Wiki
- 第二大脑

## 原始来源
[[Clippings/karpathy-second-brain.md]]
```

编译规则：
- 无状态 AI 调用，不复用 Shell 聊天会话和记忆系统
- 不运行 function calling 循环，单次提取
- 幂等：重编译覆盖已有 summary（仅覆盖带 `knowledge_generated: true` 标记的文件）
- 低置信度提取标记在 `review_flags` 中，不伪装为事实
- 源文件 `missing_source` 时，`## 原始来源` 显示缺失提示而非过期路径

### Unit 4：索引器（Indexer）

**职责：** 编译完成后维护全局索引和 topic 索引页。

产出：
- `Knowledge Wiki/index.md` — 全局索引
  - Articles 区：按 `compiled_at` 倒序列出所有 summary
  - Topics 区：按字母序列出所有 topic 页链接
  - 不展示 `missing_source` 状态的条目
- `Knowledge Wiki/Topics/<slug>.md` — 每个 topic 一页
  - 列出属于该 topic 的所有 summary 链接
  - topic 失去最后一个 summary 时，删除该 topic 页

Topic 标准化规则：
- 小写化、去首尾空格、去标点、内部连续空格转 `-`
- 例：`"Second Brain"` → `second-brain`，`"LLM Wiki!"` → `llm-wiki`
- 全系统共用一个纯函数做标准化

索引页 frontmatter：

```yaml
---
knowledge_generated: true
knowledge_artifact_type: "global_index"
compiled_at: "2026-04-08T12:00:00Z"
---
```

### Unit 5：健康检查（Linter）

**职责：** 检查知识层健康状况，生成报告。

检查项：
- 缺失 summary（registry 中有记录但无对应 summary 文件）
- 低置信度提取（summary 中有 `review_flags`）
- 孤立概念（某 concept 只出现在一篇 summary 中）
- 重复 topic（多个 `topic_candidates` 标准化后指向同一 slug）
- 过期编译（`missing_source` 状态的 summary 仍存在）

输出：`Knowledge Wiki/Health/report.md`

规则：Linter 只报告问题，不自动修复。

## 消费层

### Unit 6：`query_knowledge` MCP 工具

**职责：** 提供知识库检索能力，供 Shell 对话中的 AI 通过 function calling 调用。

工具定义：

```typescript
{
  name: "query_knowledge",
  description: "从个人知识库中检索相关知识。先读取全局索引了解有哪些文章和主题，再根据需要读取具体的 summary 全文。",
  parameters: {
    query: "string - 检索关键词或问题",
    max_results: "number - 最多返回几篇 summary，默认 3"
  }
}
```

执行流程：
1. 读取 `Knowledge Wiki/index.md` 获取全部文章标题、topic 列表和摘要概览
2. 将 index 内容连同 query 一起返回给外层 AI
3. 外层 AI 根据 query 与 index 内容判断哪些 summary 相关，发起后续 `read_note` 调用读取 summary 全文

即：`query_knowledge` 负责提供索引视图，AI 自主决定深入读哪些文章。这保持了"AI 自主导航"的设计意图，同时工具本身是确定性的文件读取。

### Unit 7：Shell 集成

**职责：** 让 Shell 对话中的 AI 自主决定何时查阅知识库。

改动：在系统提示词中追加知识库引导段落：

```
你有一个个人知识库可用。当用户的问题可能与你之前积累的知识相关时，
使用 query_knowledge 工具查阅知识库。回答时引用具体来源。
如果知识库中没有相关内容，正常回答即可，不要强行引用。
知识库检索不足时，可以用 search_vault 搜索整个 vault 补充。
```

不需要改动 Shell 的对话流程代码。AI 通过 function calling 自主决定是否调用 `query_knowledge`，和调用 `search_vault`、`read_note` 一样自然。

### Unit 8：Guardian 集成

**职责：** 在 Guardian 补全时预注入个人知识上下文，让建议融入用户积累。

Guardian 不走多轮 function calling，需要快速响应。采用预注入方案：

流程：
1. Guardian 检测到用户正在编辑的内容（当前段落/标题关键词）
2. 从 `Knowledge Wiki/index.md` 中做纯文本关键词匹配（不调 AI）
3. 如果匹配到相关 summary，读取其 frontmatter 中的 `key_claims` 和 `concepts`
4. 将知识片段作为额外上下文注入 Guardian 的 prompt：

```
[知识库参考]
来自《Karpathy 的第二大脑》：
- 核心观点：原始文件保持本地可控，AI 编译成结构化知识层
- 关键概念：知识编译、LLM Wiki、第二大脑

请在补全建议中自然融入上述个人知识，而不是给出通用回答。
```

5. Ghost Text 生成的建议就会带有用户个人知识库的色彩

关键：Guardian 的知识注入是轻量的文件读取 + 关键词匹配，不额外调用 AI 做检索。只有 Shell 对话才走完整的 function calling 路径。

### Unit 9：回填（File Back）

**职责：** 将 Shell 对话中产出的高质量回答存回 Wiki，让知识库随使用不断增长。

核心理念（引自 Karpathy）：你的每一次提问，都在让知识库变得更丰富。查询不是消耗，是投资。

触发方式：
- Shell 对话结束后，AI 判断本次回答是否产出了有价值的综合分析（如跨多篇 summary 的对比、新的洞察、结构化总结）
- 如果有价值，AI 调用新增的 `file_back_knowledge` 工具，将回答归档为一篇新的 wiki 页

`file_back_knowledge` 工具定义：

```typescript
{
  name: "file_back_knowledge",
  description: "将当前对话中产出的高质量知识回答存回知识库 Wiki，让知识库随使用不断增长。",
  parameters: {
    title: "string - 回填文章的标题",
    content: "string - 要归档的内容（Markdown 格式）",
    source_queries: "string[] - 触发这次回答的问题列表",
    related_sources: "string[] - 引用的 knowledge_source_id 列表"
  }
}
```

回填产出：`Knowledge Wiki/Articles/fb_<id>.md`

```yaml
---
knowledge_generated: true
knowledge_artifact_type: "file_back"
title: "知识编译 vs RAG 对比分析"
compiled_at: "2026-04-08T15:00:00Z"
source_queries:
  - "知识编译和 RAG 的区别是什么？"
related_sources:
  - "ksrc_abc123"
  - "ksrc_def456"
topics:
  - slug: "knowledge-management"
    label: "Knowledge Management"
concepts: ["RAG", "知识编译", "向量检索"]
---
```

回填规则：
- 回填页和编译产出的 summary 页一样，是 wiki 层的派生产物
- 回填页同样带 `knowledge_generated: true` 标记，可被覆盖和重建
- 回填页会被索引器纳入 index.md 和 topic 页
- 回填不修改任何原始笔记，只在 wiki 层新增页面

回填触发机制（用户反馈优先）：
- Shell 每条 AI 回答旁显示点赞/点踩按钮
- 用户点赞 → 立即触发回填，将该回答归档到 Wiki
- 用户点踩 → 明确不回填，即使 AI 认为有价值也跳过
- 用户未操作（无点赞/点踩）→ 由 AI 自主判断是否值得回填
- AI 自主判断标准：只有综合了多个知识来源、产出跨源对比或新洞察的回答才值得回填；简单事实查询不回填

系统提示词中追加引导：

```
当你的回答综合了多个知识来源、产出了有价值的新洞察或对比分析时，
使用 file_back_knowledge 工具将回答归档到知识库。
不要对简单的事实查询做回填，只回填有综合价值的内容。
注意：如果用户对回答点赞，无论你的判断如何都执行回填；
如果用户点踩，则不回填。用户反馈优先于你的判断。
```

## 设置与权限

### 新增设置项

```typescript
// GeminiSettings 新增字段
knowledgeSourceFolders: string[]    // 监听的文件夹列表，默认 []
knowledgeAutoCompile: boolean       // 自动编译开关，默认 false
knowledgeWikiFolder: string         // wiki 输出目录，默认 "Knowledge Wiki"
knowledgeMaxCompileBatch: number    // 单次批量编译上限，默认 10
```

设置 UI 新增 `Knowledge Compiler` 区域：
- 文件夹列表编辑器（添加/删除监听文件夹）
- 自动编译开关
- wiki 输出目录配置
- 批量编译上限

### 权限控制

复用现有权限体系：
- 编译产出 wiki 文件需要 `allowFileCreation` + `allowFileModification`
- 权限不足时，编译项保持 `pending`，不静默失败
- 手动命令视为用户显式授权，不再弹 `confirmExecutions` 确认
- registry 自身的读写不受权限开关限制（内部状态文件）

## 用户命令

四个 Obsidian 命令面板命令：

| 命令 | 行为 |
|------|------|
| `Compile this note` | 编译当前打开的笔记（不限于指定文件夹，可手动编译任意笔记） |
| `Compile all pending` | 批量编译所有 pending/stale 项（stale 先转为 pending 再处理），逐条执行 |
| `Open knowledge index` | 打开 `Knowledge Wiki/index.md` |
| `Run knowledge lint` | 运行健康检查，生成报告 |

`Compile this note` 对未注册的笔记会先注册再编译。

## 可靠性规则

- 编译失败不损坏原始笔记（只读原文，写入独立的 wiki 文件）
- 重复编译不产生重复 summary（幂等，按 source id 覆盖）
- 后台处理逐条执行，不并发，避免 API 限流
- 失败项记录错误信息，不自动无限重试
- 插件重启时，`processing` 状态重置为 `pending`
- wiki 层全部可重建：删除 `Knowledge Wiki/` 后重新 `Compile all pending` 即可恢复

### 文件所有权保护

- 只覆盖带 `knowledge_generated: true` 标记的文件
- 目标路径已存在用户手写笔记（无标记）时，编译报错而不是覆盖
- 原始笔记永远只读，编译器不修改源文件内容

## 数据流

```
用户保存/修改笔记
    │
    ▼
Folder Watcher（如果开启自动编译）
    │ 或 手动执行 Compile this note
    ▼
Registry 注册为 pending
    │
    ▼
Compiler 读取原文 → AI 提取 → 写入 summary 页
    │
    ▼
Indexer 更新 index.md + topic 页
    │
    ▼
Shell 对话时 → AI 调用 query_knowledge → 读 index → 选 summary → 综合回答
                                        ↓ 如果回答有综合价值
                              AI 调用 file_back_knowledge → 归档回 Wiki → Indexer 更新索引
Guardian 补全时 → 关键词匹配 index → 读 frontmatter → 注入上下文 → 个性化建议
```

## 模块清单

```
src/knowledge/
├── types.ts           # 类型定义、常量、状态枚举
├── registry.ts        # 注册表读写、状态管理
├── compiler.ts        # 无状态 AI 编译（笔记 → summary）
├── indexer.ts         # index.md 和 topic 页维护
├── linter.ts          # 健康检查和报告
├── watcher.ts         # 文件夹监听和入队
├── query.ts           # query_knowledge 工具实现
├── file-back.ts       # file_back_knowledge 回填工具实现
└── runtime.ts         # 生命周期管理、命令注册、事件监听
```

`main.ts` 只做一件事：实例化 `KnowledgeRuntime` 并委托生命周期。

## 验证策略

### 自动化测试

- 编译器输出结构验证（frontmatter 字段完整性）
- 索引器幂等性（重复编译不产生重复条目）
- 注册表状态机转换正确性
- topic 标准化纯函数测试
- `query_knowledge` 返回结构验证

测试不依赖真实 AI 输出，使用固定 extraction fixture。

### 手动验收

1. 保存一篇笔记到监听文件夹
2. 执行 `Compile this note`，确认 summary 页生成
3. 打开 knowledge index，确认条目存在
4. 在 Shell 中提问相关话题，确认 AI 引用知识库
5. 在编辑器中写相关内容，确认 Guardian 建议融入个人知识
6. 重命名原始笔记，确认 registry 路径更新
7. 删除 wiki 文件夹，重新 `Compile all pending`，确认可重建

## 设计权衡

### 为什么用 AI 自主导航而非预计算索引

AI 读 index → 选文章的方式灵活度高，能理解语义关联，不需要维护额外的关键词映射表。代价是 Shell 每次问答可能多一次文件读取，但 index.md 通常很小，开销可接受。

### 为什么 Guardian 用预注入而非 function calling

Guardian 需要快速响应（Ghost Text 场景），多轮 function calling 会引入明显延迟。预注入方案只做文件读取和关键词匹配，延迟可控。精度不如 Shell 的 AI 导航，但对补全场景够用。

### 为什么不用向量检索

向量检索需要 embedding API 调用和本地索引存储，增加复杂度和依赖。当前知识库规模（几十到几百篇 summary）下，AI 读 index 选文章的方式足够有效。未来规模增长时可以叠加向量检索，不影响当前架构。
