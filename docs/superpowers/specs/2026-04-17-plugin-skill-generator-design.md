# Plugin Skill 自动生成器设计

**Date:** 2026-04-17
**Project:** `obsidian-cli`
**Status:** Proposed design, pending spec review

## 目标

增强 plugin-ctrl skill，使其能自动为已安装的 Obsidian 插件生成使用 SKILL.md。让 AI 不仅能发现插件，还能通过插件专属 skill 智能地使用插件完成用户任务。

## 动机

### 当前问题

1. **AI 只能调命令，不懂怎么用插件**：plugin-ctrl 能列出插件命令、执行命令，但 AI 不知道什么场景该用什么插件、怎么组合操作
2. **用户手写 SKILL.md 门槛高**：需要了解插件的命令、设置、文件格式，还要写 YAML frontmatter
3. **插件能力浪费**：用户装了 tasks、kanban、dataview 等插件，但 AI 无法主动利用它们

### 解决方案

插件启动时自动扫描已安装插件，调用 AI 为每个插件生成 SKILL.md，注册到 SkillRegistry。AI 在对话中能看到这些 skill 摘要，主动选择合适的插件完成任务。

## 使用流程示例

```
用户: "帮我创建一个待办：明天早上跑步"

AI 内部流程:
  1. 识别意图：创建待办任务
  2. 查看 skill 摘要，发现 plugin-obsidian-tasks 可用
  3. 调用 use_skill("plugin-obsidian-tasks")
  4. 获取 instructions：任务格式、目标文件、可用命令
  5. 根据 instructions 自主操作：
     - append_to_note("Daily/2026-04-18.md", "- [ ] 早上跑步 📅 2026-04-18")
  6. 返回结果给用户
```

## 架构设计

### 整体流程

```
插件启动 (onload)
  │
  ├─ 正常初始化 SkillRegistry、ToolRegistry
  ├─ 注册内置 skill（web-clipper, knowledge, plugin-ctrl...）
  ├─ 加载用户 skill（.obsidian/obsidian-cli/skills/）
  │
  └─ 启动 PluginWatcher（后台异步）
       │
       ├─ 首次扫描：遍历所有已启用插件
       │   ├─ 跳过自身（obsidian-cli）
       │   ├─ 检查是否已有 SKILL.md → 有则跳过
       │   └─ 无 SKILL.md → 收集插件信息 → 调 AI 生成 → 写入 vault → 注册
       │
       └─ 定时监听（每 10 秒）
           ├─ 对比 enabledPlugins 快照
           ├─ 新启用的插件 → 生成 skill
           └─ 已禁用的插件 → 从 SkillRegistry 注销（不删文件）
```

### 新增模块

```
src/skills/builtin/plugin-ctrl/
├── SKILL.md              # 更新：编排器角色描述
├── executor.ts           # 更新：增加 use_plugin_skill 工具
├── skill-generator.ts    # 新增：AI 生成插件 SKILL.md
└── plugin-watcher.ts     # 新增：插件状态监听 + skill 生命周期管理
```

### 模块职责

#### PluginWatcher（plugin-watcher.ts）

插件状态监听器，管理插件 skill 的生命周期。

```typescript
class PluginWatcher {
  private snapshot: Set<string>;     // 上次已知的 enabledPlugins
  private intervalId: number | null;

  constructor(
    private app: App,
    private skillRegistry: SkillRegistry,
    private skillGenerator: PluginSkillGenerator,
    private settings: PluginSettings,
  ) {}

  /** 启动监听：首次扫描 + 定时轮询 */
  async start(): Promise<void>;

  /** 停止监听（插件 unload 时调用） */
  stop(): void;

  /** 首次扫描：为所有缺 skill 的已启用插件生成 */
  private async initialScan(): Promise<void>;

  /** 定时检查：对比快照，处理新增/移除 */
  private async checkChanges(): Promise<void>;

  /** 检查插件是否已有 SKILL.md */
  private async hasSkillFile(pluginId: string): Promise<boolean>;
}
```

#### PluginSkillGenerator（skill-generator.ts）

调用 AI 生成插件 SKILL.md 的核心逻辑。

```typescript
class PluginSkillGenerator {
  constructor(
    private app: App,
    private modelService: ModelService,
    private settings: PluginSettings,
  ) {}

  /** 收集插件信息 */
  collectPluginInfo(pluginId: string): PluginInfo;

  /** 调用 AI 生成 SKILL.md 内容 */
  async generateSkillMd(info: PluginInfo): Promise<string>;

  /** 写入 vault 并返回路径 */
  async writeSkillFile(pluginId: string, content: string): Promise<string>;
}

interface PluginInfo {
  id: string;
  name: string;
  description: string;
  version: string;
  commands: { id: string; name: string }[];
  settings: Record<string, any>;
}
```

### AI Prompt 策略

生成 SKILL.md 时，给 ModelService 的 prompt 包含以下信息：

**System Prompt：**

```
你是一个 Obsidian 插件专家。根据提供的插件信息，生成一个 SKILL.md 文件。
这个文件将指导 AI 助手如何使用该插件完成用户任务。

输出格式要求：
1. YAML frontmatter：name, description, triggers.keywords, tools
2. Markdown body：插件能力、可用命令、操作指南、注意事项

关键原则：
- name 格式：plugin-{pluginId}，小写+连字符
- description 要简洁（<200字符），说明插件能做什么、什么时候用
- keywords 包含中英文触发词
- tools 列出 AI 需要的工具（vault 操作 + execute_plugin_command）
- 操作指南要具体：告诉 AI 用什么工具、写什么格式、存到哪里
- 如果插件主要通过文件格式工作（如 tasks 的 checkbox 语法），
  重点描述文件格式而非命令
```

**User Prompt 模板：**

```
请为以下 Obsidian 插件生成 SKILL.md：

## 插件信息
- ID: {pluginId}
- 名称: {name}
- 描述: {description}
- 版本: {version}

## 可用命令（{commandCount} 个）
{commands 列表，每行一个: id — name}

## 当前设置
{settings JSON，脱敏处理}

请生成完整的 SKILL.md 内容（包含 --- frontmatter ---）。
```

### 生成示例

以 `obsidian-tasks-plugin` 为例，AI 应生成类似内容：

```yaml
---
name: plugin-obsidian-tasks
description: 管理待办任务。创建、查询、完成、设置截止日期和优先级时使用。
triggers:
  keywords: ["待办", "任务", "todo", "task", "提醒", "deadline"]
tools: ["read_note", "append_to_note", "create_note", "search_vault", "execute_plugin_command"]
---

# Obsidian Tasks

## 插件能力
在笔记中管理结构化任务，支持截止日期、优先级、重复规则、标签过滤。

## 任务语法
任务使用 Markdown checkbox 格式，附加 emoji 标记：
- `📅 YYYY-MM-DD` — 截止日期（due date）
- `⏳ YYYY-MM-DD` — 计划日期（scheduled date）
- `🛫 YYYY-MM-DD` — 开始日期（start date）
- `⏫` 高优先级 / `🔼` 中优先级 / `🔽` 低优先级
- `🔁 every week` — 重复规则

示例：`- [ ] 早上跑步 📅 2026-04-18 🔼`

## 可用命令
- `obsidian-tasks-plugin:edit-task` — 打开任务编辑对话框
- `obsidian-tasks-plugin:toggle-done` — 切换任务完成状态

## 操作指南
1. **创建任务**：用 `append_to_note` 在目标笔记中追加任务行
2. **查询任务**：用 `search_vault` 搜索 `- [ ]` 或特定关键词
3. **完成任务**：用 `read_note` 读取 → 替换 `- [ ]` 为 `- [x]` → `update_note`
4. **默认文件**：优先追加到今日 Daily Note，无则创建新笔记
```

## executor.ts 变更

### 现有工具保留

`list_plugins`、`get_plugin_commands`、`get_plugin_settings`、`execute_plugin_command` 全部保留。

### list_plugins 增强

返回值增加 `hasSkill` 字段，标注哪些插件已有 skill：

```typescript
// 增强后的返回值
{
  plugins: [
    { id: "obsidian-tasks-plugin", name: "Tasks", enabled: true, hasSkill: true },
    { id: "obsidian-kanban", name: "Kanban", enabled: true, hasSkill: false },
  ]
}
```

### plugin-ctrl SKILL.md 更新

plugin-ctrl 自身的 SKILL.md 更新为编排器角色：

```yaml
---
name: plugin-ctrl
description: 发现和使用 Obsidian 插件。需要插件能力时先通过此 skill 查找合适插件。
triggers:
  keywords: ["插件", "plugin", "plugins"]
tools: ["list_plugins", "get_plugin_commands", "get_plugin_settings", "execute_plugin_command"]
---

# Plugin Control — 插件编排器

## 工作流程

当用户的需求可能由某个插件完成时：

1. 查看 skill 摘要列表，是否已有匹配的 `plugin-*` skill
2. 如果有 → 直接调用该插件 skill（如 `use_skill("plugin-obsidian-tasks")`）
3. 如果没有 → 使用 `list_plugins` 查看已安装插件
4. 找到候选插件后，用 `get_plugin_commands` 了解其能力
5. 根据命令和设置信息，直接操作完成任务

## 原则
- 优先使用已有 skill 的插件（instructions 更完整）
- 没有 skill 的插件，退回到命令级操作
- 只有在没有合适插件时，才用纯 vault 操作创建普通 Markdown
```

## 集成方式

### main.ts 变更

```typescript
// 在现有初始化流程之后，启动 PluginWatcher
async onload() {
  // ... 现有初始化 ...

  // 启动插件 skill 监听（后台异步，不阻塞）
  this.pluginWatcher = new PluginWatcher(
    this.app,
    this.skillRegistry,
    new PluginSkillGenerator(this.app, this.modelService, this.settings),
    this.settings,
  );
  this.pluginWatcher.start();  // 不 await，后台运行
}

async onunload() {
  this.pluginWatcher?.stop();
}
```

### Skill 文件存放路径

生成的 SKILL.md 存放在用户 skill 目录：

```
.obsidian/obsidian-cli/skills/
├── plugin-obsidian-tasks/
│   └── SKILL.md          # AI 生成
├── plugin-obsidian-kanban/
│   └── SKILL.md          # AI 生成
├── daily-digest/
│   └── SKILL.md          # 用户手写
└── ...
```

命名规则：`plugin-{pluginId}/SKILL.md`，`plugin-` 前缀区分 AI 生成和用户手写。

## 边界情况

### 1. AI 生成失败

- 网络错误、API 限流等 → 记录日志，跳过该插件，下次轮询时重试
- 生成内容格式不合法（frontmatter 解析失败）→ 丢弃，记录警告
- 设置最大重试次数（3 次），超过后标记为"跳过"，不再自动重试

### 2. 插件无命令

有些插件没有注册命令（如纯 CSS 主题插件、纯渲染插件）。
- 如果 commands 为空且 settings 也为空 → 跳过，不生成 skill
- 如果有 settings 但无 commands → 仍然生成（可能通过文件格式工作）

### 3. 插件禁用后重新启用

- 禁用时：从 SkillRegistry 注销，但 SKILL.md 文件保留
- 重新启用时：检测到文件已存在 → 直接加载注册，不重新生成

### 4. 并发控制

首次扫描可能有 10-20 个插件需要生成 skill：
- 串行生成，每个之间间隔 1 秒，避免 API 限流
- 用 Notice 显示进度："正在为插件生成 skill（3/15）..."

### 5. 自身排除

`obsidian-cli` 自身不生成 skill，硬编码排除。

## 设置项

在 `PluginSettings` 中新增：

```typescript
/** 是否自动为插件生成 skill（默认 true） */
autoGeneratePluginSkills: boolean;

/** 插件 skill 生成排除列表（插件 ID） */
pluginSkillExcludeList: string[];
```

设置页面增加：
- 开关：自动生成插件 Skill
- 排除列表：用户可以排除不需要生成 skill 的插件

## 设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 插件变化检测方式 | 轮询 enabledPlugins（10秒） | Obsidian 无插件状态事件，轮询 Set diff 开销极低 |
| Skill 生成方式 | 调用 ModelService | 模型无关，用用户配置的模型；模板拼装无法理解插件语义 |
| 生成的 skill 存放位置 | 用户 skill 目录 | 复用现有 SkillLoader 加载机制，用户可手动编辑 |
| 已有 SKILL.md 是否覆盖 | 不覆盖 | 尊重用户手动编辑，避免丢失定制内容 |
| 插件禁用时是否删除文件 | 不删除 | 重新启用时可直接加载，避免重复生成 |
| 命名前缀 | `plugin-` | 区分 AI 生成和用户手写 skill |
| 无命令插件 | 跳过 | 无命令无设置的插件对 AI 无操作价值 |

## 需要的 SkillRegistry 扩展

当前 `SkillRegistry` 没有注销方法。需要新增：

```typescript
/** 注销 skill（插件禁用时调用） */
unregisterSkill(name: string): void {
  const skill = this.skills.get(name);
  if (!skill) return;
  // 清理命令索引
  if (skill.triggers?.commands) {
    for (const cmd of skill.triggers.commands) {
      this.commandIndex.delete(cmd);
    }
  }
  this.skills.delete(name);
  console.log(`[SkillRegistry] Unregistered skill: ${name}`);
}
```

这是一个小改动，不影响现有功能。
