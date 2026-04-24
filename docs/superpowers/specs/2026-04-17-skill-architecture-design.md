# Skill 架构设计

**Date:** 2026-04-17
**Project:** `obsidian-cli`
**Status:** Proposed design, pending spec review

## 目标

用 Skill 架构替换当前的 MCP 工具体系。将 AI 能力组织为两层：底层原子工具（无状态、可组合）+ 上层 Skill（编排、渐进式披露、可定制）。解决当前 ToolManager God Object、context 浪费、不可扩展等问题。

## 动机

### 当前问题

1. **Context 浪费**：16 个工具定义始终注入 function calling（~2000+ tokens），用户只想聊天也要背着 `delete_note`、`list_plugins` 的 schema
2. **ToolManager 臃肿**：914 行单文件，`save_webpage` 300 行 HTML 解析和 vault CRUD 混在同一个 switch-case
3. **MCP 客户端是死代码**：`StdioMcpClient` 依赖 `child_process`，移动端不可用；同步/异步矛盾未解决；外部 MCP 工具从未真正注册到 function calling
4. **工具粒度不对**：`get_current_time` 与 system prompt 重复；`search_vault` 与 `/open` 命令重复；插件控制默认关闭但 schema 始终占 context
5. **不可扩展**：每新增一个能力就要改 `tools.ts`，加一个 case，工具定义数组越来越长

### Skill 如何解决

参考 [Claude Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) 的三级渐进式加载模型：

- **Level 1（始终加载）**：只有 name + description，~100 tokens/skill
- **Level 2（触发时加载）**：完整指令 + 工具集，<5k tokens
- **Level 3（按需执行）**：脚本、模板、参考资料，不进 context

## 架构分层

```
┌─────────────────────────────────────────────────┐
│  触发层                                          │
│  斜杠命令 / AI 意图识别 / 事件驱动                │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│  Skill 层（编排 + 渐进式披露）                    │
│                                                  │
│  SkillRegistry                                   │
│  ├─ 内置 Skill（TypeScript）                     │
│  │   ├─ web-clipper                              │
│  │   ├─ web-search                               │
│  │   ├─ knowledge                                │
│  │   └─ plugin-ctrl                              │
│  └─ 用户 Skill（SKILL.md）                       │
│      └─ vault:.obsidian/obsidian-cli/skills/     │
│                                                  │
│  每个 Skill 声明它需要哪些工具                    │
│  激活时才把工具注入 function calling              │
└──────────────────┬──────────────────────────────┘
                   │ 调用
┌──────────────────▼──────────────────────────────┐
│  工具层（原子操作）                               │
│                                                  │
│  ToolRegistry                                    │
│  ├─ vault: read_note, create_note, update_note,  │
│  │   append_to_note, delete_note, rename_note,   │
│  │   list_notes, search_vault, open_file         │
│  ├─ web: fetch_url, parse_html,                  │
│  │   extract_transcript                          │
│  ├─ search: web_search                           │
│  ├─ knowledge: query_knowledge,                  │
│  │   file_back_knowledge                         │
│  └─ plugin: list_plugins, get_plugin_commands,   │
│      get_plugin_settings                         │
│                                                  │
│  无状态、可组合、不感知 Skill                     │
└─────────────────────────────────────────────────┘
```

## 目录结构

```
src/skills/
├── types.ts              # Skill/Tool 接口定义
├── tool-registry.ts      # 原子工具注册表
├── skill-registry.ts     # Skill 发现、注册、加载、路由
├── skill-loader.ts       # SKILL.md 解析器（用户自定义 skill）
├── builtin/
│   ├── vault-ops.ts      # vault 文件操作工具集（始终可用）
│   ├── web-clipper/
│   │   ├── index.ts      # Skill 定义 + 编排逻辑
│   │   └── parsers.ts    # HTML/视频解析（从 tools.ts 拆出）
│   ├── web-search.ts     # DuckDuckGo 搜索 Skill
│   ├── knowledge.ts      # 知识库查询 + 回填 Skill
│   └── plugin-ctrl.ts    # 插件控制 Skill（可选启用）
└── user/                 # 运行时从 vault 加载的用户 Skill
```

## 接口定义

### 原子工具

```typescript
/**
 * 原子工具：无状态、可组合的最小操作单元
 * 不感知 Skill，不感知 AI，只做一件事
 */
interface Tool {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute(args: any, ctx: ToolContext): Promise<any>;
}

interface ToolContext {
  app: App;
  settings: PluginSettings;
}

interface ToolParameters {
  type: 'object';
  properties: Record<string, ParameterDef>;
  required?: string[];
}

interface ParameterDef {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description: string;
  items?: ParameterDef;
  enum?: string[];
}
```

### Skill

```typescript
/**
 * Skill：编排层，组合原子工具完成复杂任务
 * 支持渐进式披露的三级加载
 */
interface Skill {
  // === Level 1: Metadata（始终加载，~100 tokens） ===
  name: string;                    // 唯一标识，如 "web-clipper"
  description: string;             // 一句话，告诉 AI 什么时候用（<200 chars）

  // === Level 2: Instructions（触发时加载） ===
  getInstructions(): string;       // 完整的 prompt 模板 / 工作流指引
  getTools(): ToolDefinition[];    // 该 Skill 暴露给 AI 的工具子集

  // === Level 3: Execution（按需执行） ===
  execute(toolName: string, args: any): Promise<any>;

  // === 触发条件 ===
  triggers?: SkillTriggers;

  // === 生命周期 ===
  enabled?: boolean | ((settings: PluginSettings) => boolean);
}

interface SkillTriggers {
  commands?: string[];     // 斜杠命令: ["/save", "/clip"]
  events?: string[];       // 事件: ["file:modified", "timer:daily:21:00"]
  keywords?: string[];     // AI 意图路由辅助词（不进 context）
}
```

### SkillRegistry

```typescript
/**
 * Skill 注册表：发现、注册、路由、加载
 */
interface ISkillRegistry {
  // 注册
  registerBuiltin(skill: Skill): void;
  loadUserSkills(skillsDir: string): Promise<void>;

  // 发现（Level 1 — 生成 system prompt 摘要）
  getSkillSummaries(): SkillSummary[];

  // 路由（判断该激活哪个 Skill）
  resolveByCommand(command: string): Skill | null;
  resolveByIntent(userMessage: string): Skill | null;
  resolveByEvent(event: string): Skill | null;

  // 加载（Level 2 — 注入工具到 function calling）
  activateSkill(name: string): ActivatedSkill;

  // 列表
  listSkills(): SkillSummary[];
}

interface SkillSummary {
  name: string;
  description: string;
  commands?: string[];
}

interface ActivatedSkill {
  skill: Skill;
  tools: ToolDefinition[];
  instructions: string;
}
```

## AI 交互流程

### 当前流程（所有工具始终注入）

```
startChat(allTools: 16个工具定义)
  → 用户: "帮我保存这个链接 https://..."
  → AI 从 16 个工具中选择 save_webpage
  → ToolManager.execute("save_webpage", {url})
  → 300 行 God Function 执行
  → 返回结果
```

### 新流程（渐进式披露）

```
startChat(coreTools + use_skill)

AI 始终看到的 context（~800 tokens）:
  ┌─────────────────────────────────────────┐
  │ 核心工具（vault 操作，高频，始终注册）    │
  │  read_note, create_note, update_note,   │
  │  append_to_note, list_notes,            │
  │  search_vault, open_file                │
  ├─────────────────────────────────────────┤
  │ 元工具                                   │
  │  use_skill(name, args)                  │
  ├─────────────────────────────────────────┤
  │ Skill 摘要（每个 ~1 行）                 │
  │  - web-clipper: 保存网页/视频到 vault    │
  │  - web-search: 搜索互联网获取信息        │
  │  - knowledge: 检索和归档个人知识库        │
  │  - plugin-ctrl: 查询和控制 Obsidian 插件 │
  │  - (用户自定义 skill...)                 │
  └─────────────────────────────────────────┘

流程:
  → 用户: "帮我保存这个链接 https://..."
  → AI 识别意图，调用 use_skill("web-clipper", {url: "https://..."})
  → SkillRegistry.activateSkill("web-clipper")
  → 加载 web-clipper 的 instructions + tools
  → 执行 skill 内部的工具链
  → 返回结果给 AI
```

### use_skill 元工具定义

```typescript
const USE_SKILL_TOOL: ToolDefinition = {
  name: 'use_skill',
  description: '激活并执行一个 Skill。查看上方 Skill 列表选择合适的 skill。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Skill 名称，如 "web-clipper"'
      },
      args: {
        type: 'object',
        description: 'Skill 所需的参数'
      }
    },
    required: ['name']
  }
};
```

### 两种 Skill 执行模式

**模式 A：单次执行（Simple Skill）**

Skill 内部直接编排工具调用，一次返回结果。适合确定性流程。

```
use_skill("web-clipper", {url})
  → skill 内部: fetch_url → parse_html → create_note
  → 返回: {success: true, path: "Clippings/xxx.md"}
```

**模式 B：工具注入（Composable Skill）**

Skill 激活后，将自己的工具集注入当前对话的 function calling，AI 自主编排。适合需要 AI 判断的场景。

```
use_skill("knowledge")
  → 注入 query_knowledge + file_back_knowledge 到 function calling
  → AI 自主决定先 query 还是直接回答
  → AI 自主决定是否 file_back
```

Skill 接口通过 `mode` 字段区分：

```typescript
interface Skill {
  // ...
  mode: 'simple' | 'composable';
  // simple: execute() 直接返回结果
  // composable: getTools() 注入工具，AI 自主调用
}
```

## 内置 Skill 清单

### 始终可用的核心工具（不走 Skill 层）

这些工具因为高频使用，始终注册到 function calling，不需要通过 `use_skill` 激活。

| 工具 | 来源 | 说明 |
|------|------|------|
| `read_note` | vault-ops | 读取笔记内容 |
| `create_note` | vault-ops | 创建新笔记 |
| `update_note` | vault-ops | 更新笔记内容 |
| `append_to_note` | vault-ops | 追加内容到笔记 |
| `list_notes` | vault-ops | 列出文件夹中的笔记 |
| `search_vault` | vault-ops | 按文件名搜索 vault |
| `open_file` | vault-ops | 在 Obsidian 中打开文件 |

**删除的工具：**
- `get_current_time` — system prompt 已注入 `[Current Time: ...]`，多余
- `delete_note` — 从始终可用降级为需确认操作，移入 vault-ops skill
- `rename_note` — 同上，低频且有破坏性

### 内置 Skill

| Skill | Mode | 触发方式 | 包含工具 | 说明 |
|-------|------|---------|---------|------|
| `vault-danger` | simple | AI 意图 | `delete_note`, `rename_note` | 破坏性 vault 操作，需确认 |
| `web-clipper` | simple | `/save <url>`, AI 意图 | `fetch_url`, `parse_html`, `extract_transcript` | 保存网页/视频到 vault |
| `web-search` | simple | AI 意图 | `web_search` | DuckDuckGo 搜索 |
| `knowledge` | composable | AI 意图, `/wiki:query` | `query_knowledge`, `file_back_knowledge` | 知识库检索和回填 |
| `plugin-ctrl` | composable | AI 意图 | `list_plugins`, `get_plugin_commands`, `get_plugin_settings` | 插件查询和控制 |

## 用户自定义 Skill 规范

### 存放位置

```
vault/.obsidian/obsidian-cli/skills/
├── daily-digest/
│   └── SKILL.md
├── meeting-notes/
│   └── SKILL.md
└── translate/
    └── SKILL.md
```

### SKILL.md 格式

```yaml
---
name: daily-digest
description: 生成每日摘要，汇总今天修改的笔记和待办事项。当用户说"今日总结"或"daily digest"时使用。
mode: simple
triggers:
  commands: ["/digest"]
  events: ["timer:daily:21:00"]
  keywords: ["今日总结", "daily digest", "每日回顾"]
tools: ["list_notes", "read_note", "create_note"]
enabled: true
---

# Daily Digest

## 工作流程

1. 使用 `list_notes` 获取今天修改的文件（按 modified 时间过滤）
2. 对每个文件使用 `read_note` 读取前 200 字
3. 生成摘要，包含：
   - 今天修改了哪些笔记
   - 每篇笔记的关键变更
   - 明日待办建议
4. 使用 `create_note` 保存到 `Daily/YYYY-MM-DD-digest.md`

## 输出格式

```markdown
# YYYY-MM-DD 每日摘要

## 今日修改
- [[笔记1]] - 变更摘要
- [[笔记2]] - 变更摘要

## 明日待办
- [ ] ...
```
```

### Frontmatter 字段说明

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `name` | 是 | string | 唯一标识，小写字母+连字符，≤64 字符 |
| `description` | 是 | string | 一句话描述 + 触发时机，≤200 字符 |
| `mode` | 否 | `simple` \| `composable` | 默认 `simple` |
| `triggers.commands` | 否 | string[] | 斜杠命令列表 |
| `triggers.events` | 否 | string[] | 事件触发条件 |
| `triggers.keywords` | 否 | string[] | AI 意图路由辅助词 |
| `tools` | 否 | string[] | 该 Skill 需要的工具名列表 |
| `enabled` | 否 | boolean | 默认 true |

### 解析规则

1. `SkillLoader` 在插件启动时扫描 `vault:.obsidian/obsidian-cli/skills/*/SKILL.md`
2. 解析 YAML frontmatter 提取 Level 1 metadata
3. Markdown body 作为 Level 2 instructions，触发时才读取
4. `tools` 字段引用 ToolRegistry 中已注册的原子工具
5. 用户 Skill 的 `mode` 只能是 `simple`（安全考虑，不允许用户 Skill 注入工具到 function calling）

## 渐进式披露机制

### System Prompt 注入（Level 1）

SkillRegistry 生成的摘要注入到 system prompt 末尾：

```
你有以下 Skill 可用。需要时通过 use_skill 工具调用：

- web-clipper: 保存网页或视频到 vault，支持 YouTube/Bilibili/微信公众号
- web-search: 搜索互联网获取最新信息
- knowledge: 从个人知识库检索相关知识，或将高质量回答归档
- plugin-ctrl: 查询已安装插件的命令和设置
- daily-digest: 生成每日摘要，汇总今天修改的笔记和待办事项
```

Token 开销：~100 tokens/skill × 5 个 skill = ~500 tokens
对比当前：16 个完整工具定义 = ~2000+ tokens

### Skill 激活流程（Level 2）

```
AI 调用 use_skill("web-clipper", {url: "..."})
  │
  ▼
SkillRegistry.activateSkill("web-clipper")
  │
  ├─ 检查 skill 是否 enabled
  ├─ 加载 instructions（内置 Skill 从代码，用户 Skill 从 SKILL.md body）
  ├─ 加载 tools（从 ToolRegistry 获取工具实例）
  │
  ▼
根据 mode 分支：
  │
  ├─ simple: 直接执行 skill.execute(args)
  │   → skill 内部编排工具调用
  │   → 返回结果给 AI
  │
  └─ composable: 返回 ActivatedSkill
      → 将 tools + instructions 注入当前对话
      → AI 自主调用注入的工具
      → 工具结果返回给 AI
```

### 事件驱动触发（Level 2 自动激活）

```typescript
interface SkillEventBus {
  // Watcher 层发出事件
  emit(event: string, payload?: any): void;

  // SkillRegistry 监听事件，自动激活匹配的 Skill
  on(event: string, handler: (payload: any) => void): void;
}

// 支持的事件类型
type SkillEvent =
  | 'file:created'        // 新文件创建
  | 'file:modified'       // 文件修改
  | 'file:deleted'        // 文件删除
  | `timer:daily:${string}` // 每日定时，如 "timer:daily:21:00"
  | `timer:interval:${string}`; // 间隔定时，如 "timer:interval:5m"
```

## 迁移计划

### 原则

- 渐进式迁移，不一次性重写
- 每个阶段可独立交付和测试
- 保持对外行为不变（AI 能力不退化）

### Phase 1：基础骨架

**目标**：搭建 Skill 架构骨架，不改变现有行为

1. 创建 `src/skills/types.ts` — Skill/Tool 接口定义
2. 创建 `src/skills/tool-registry.ts` — 原子工具注册表
3. 创建 `src/skills/skill-registry.ts` — Skill 注册表（发现、路由、激活）
4. 创建 `src/skills/skill-loader.ts` — SKILL.md 解析器
5. 在 `main.ts` 中初始化 SkillRegistry，与现有 ToolManager 并行运行

**验证**：SkillRegistry 能加载内置 Skill 摘要，`/tools` 命令能列出 Skill

### Phase 2：拆分原子工具

**目标**：将 ToolManager 中的工具拆分为独立的原子工具

1. 将 vault 操作（read/create/update/append/delete/rename/list/search/open）拆到 `src/skills/builtin/vault-ops.ts`
2. 将 `save_webpage` 拆分：
   - `fetch_url` — HTTP 请求 + 响应
   - `parse_html` — Readability 提取 + htmlToMarkdown
   - `extract_transcript` — 视频转录（YouTube/Bilibili）
   - 编排逻辑移到 `web-clipper` Skill
3. 将 `web_search` 拆到 `src/skills/builtin/web-search.ts`
4. Knowledge 工具保持委托模式（已经是独立 executor）
5. 所有原子工具注册到 ToolRegistry

**验证**：所有现有功能通过 ToolRegistry 调用正常工作

### Phase 3：接入 Skill 层

**目标**：AI 通过 Skill 层调用工具，替换直接 function calling

1. 实现 `use_skill` 元工具
2. 修改 `ModelService.chat()` 的工具注入逻辑：
   - 始终注入：vault 核心工具 + `use_skill`
   - system prompt 追加：Skill 摘要列表
3. 实现 simple mode 执行流程（web-clipper, web-search）
4. 实现 composable mode 执行流程（knowledge, plugin-ctrl）
5. 斜杠命令路由：`/save` → web-clipper skill，`/wiki:query` → knowledge skill

**验证**：AI 能通过 `use_skill` 调用所有 Skill，功能与迁移前一致

### Phase 4：用户自定义 Skill

**目标**：支持用户在 vault 中创建 SKILL.md

1. 实现 SkillLoader 的 SKILL.md 解析
2. 插件启动时扫描 `.obsidian/obsidian-cli/skills/` 目录
3. 用户 Skill 注册到 SkillRegistry
4. 设置页面增加 Skill 管理 UI（列表、启用/禁用）
5. 提供 2-3 个示例 Skill 模板

**验证**：用户创建 SKILL.md 后，AI 能发现并使用该 Skill

### Phase 5：清理

**目标**：移除旧代码

1. 删除 `src/mcp/tools.ts`（ToolManager）
2. 删除 `src/mcp/mcp-client.ts`（StdioMcpClient）
3. 删除 `PluginSettings.mcpServers` 配置项
4. 更新 `src/mcp/types.ts` 中的设置接口
5. 更新 CLAUDE.md 中的架构文档

## 与现有系统的关系

### Knowledge Wiki

Knowledge 子系统（`src/knowledge/`）不受影响。`query_knowledge` 和 `file_back_knowledge` 的执行逻辑仍在 `QueryKnowledgeExecutor` 和 `FileBackExecutor` 中。Skill 层只是包装了触发和发现机制。

### Guardian Mode

Guardian 的 ghost text 补全不走 function calling，不受 Skill 架构影响。但未来可以通过 Skill 的 composable mode 让 Guardian 在补全前查询知识库。

### Memory System

MemoryManager 不变。Skill 层不参与记忆管理。

### ChatController

`chat-controller.ts` 中的斜杠命令（`/save`, `/wiki:compile` 等）将路由到 SkillRegistry，而不是直接调用 ToolManager 或硬编码逻辑。

## 设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| vault 操作是否走 Skill | 否，始终注册 | 高频操作，每次对话几乎都用，多一次 use_skill 往返不值得 |
| delete/rename 是否始终可用 | 否，移入 vault-danger skill | 低频且有破坏性，不应始终暴露 |
| 用户 Skill 是否支持 composable mode | 否，只支持 simple | 安全考虑，不允许用户 Skill 注入工具到 function calling |
| MCP 客户端是否保留 | 否，删除 | 死代码，移动端不可用，用 Skill 替代 |
| get_current_time 是否保留 | 否，删除 | system prompt 已注入时间 |
| Skill 摘要放在 system prompt 还是工具描述 | system prompt | 更自然，AI 可以在回答中引用 Skill 列表 |
