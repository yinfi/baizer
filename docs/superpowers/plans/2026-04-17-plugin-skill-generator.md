# Plugin Skill 自动生成器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 plugin-ctrl 自动为已安装 Obsidian 插件生成 SKILL.md，使 AI 能智能使用插件完成用户任务。

**Architecture:** 新增 PluginWatcher（轮询 enabledPlugins 检测变化）和 PluginSkillGenerator（收集插件信息 + 调 ModelService 生成 SKILL.md）。启动时后台异步扫描，生成的 skill 写入用户 skill 目录并热注册到 SkillRegistry。

**Tech Stack:** TypeScript, Obsidian API, ModelService（模型无关）, esbuild text loader

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/skills/builtin/plugin-ctrl/skill-generator.ts` | Create | 收集插件信息 + 调 AI 生成 SKILL.md + 写入 vault |
| `src/skills/builtin/plugin-ctrl/plugin-watcher.ts` | Create | 轮询 enabledPlugins、检测变化、触发生成/注销 |
| `src/skills/builtin/plugin-ctrl/executor.ts` | Modify | list_plugins 增加 hasSkill 字段 |
| `src/skills/builtin/plugin-ctrl/SKILL.md` | Modify | 更新为编排器角色描述 |
| `src/skills/skill-registry.ts` | Modify | 新增 unregisterSkill 方法 |
| `src/mcp/types.ts` | Modify | 新增 autoGeneratePluginSkills + pluginSkillExcludeList 设置 |
| `src/settings.ts` | Modify | 设置页面增加插件 skill 开关和排除列表 |
| `main.ts` | Modify | 启动 PluginWatcher |
| `test/plugin-skill-generator.test.ts` | Create | skill-generator 单元测试 |
| `test/plugin-watcher.test.ts` | Create | plugin-watcher 单元测试 |

---

### Task 1: SkillRegistry 新增 unregisterSkill 方法

**Files:**
- Modify: `src/skills/skill-registry.ts:80-301`

- [ ] **Step 1: 在 SkillRegistry 类中添加 unregisterSkill 方法**

在 `src/skills/skill-registry.ts` 的 `registerUser` 方法之后（约 line 201），添加：

```typescript
/** 注销 skill（插件禁用时调用） */
unregisterSkill(name: string): void {
  const skill = this.skills.get(name);
  if (!skill) return;
  if (skill.triggers?.commands) {
    for (const cmd of skill.triggers.commands) {
      this.commandIndex.delete(cmd);
    }
  }
  this.skills.delete(name);
  console.log(`[SkillRegistry] Unregistered skill: ${name}`);
}

/** 暴露 toolRegistry 供 PluginWatcher 使用 */
getToolRegistry(): ToolRegistry {
  return this.toolRegistry;
}
```

- [ ] **Step 2: 验证构建通过**

Run: `npm run build`
Expected: 构建成功，无类型错误

- [ ] **Step 3: Commit**

```bash
git add src/skills/skill-registry.ts
git commit -m "feat(skill-registry): add unregisterSkill method"
```

---

### Task 2: PluginSettings 新增配置项

**Files:**
- Modify: `src/mcp/types.ts:70-155`

- [ ] **Step 1: 在 PluginSettings 接口中添加新字段**

在 `src/mcp/types.ts` 的 `PluginSettings` 接口末尾（`knowledgeMaxCompileBatch` 之后），添加：

```typescript
// --- 🔌 Plugin Skill Generator ---
autoGeneratePluginSkills: boolean;
pluginSkillExcludeList: string[];
```

- [ ] **Step 2: 在 DEFAULT_SETTINGS 中添加默认值**

在 `DEFAULT_SETTINGS` 末尾（`knowledgeMaxCompileBatch: 50` 之后），添加：

```typescript
// Plugin Skill Generator
autoGeneratePluginSkills: true,
pluginSkillExcludeList: []
```

- [ ] **Step 3: 验证构建通过**

Run: `npm run build`
Expected: 构建成功

- [ ] **Step 4: Commit**

```bash
git add src/mcp/types.ts
git commit -m "feat(settings): add autoGeneratePluginSkills config"
```

---

### Task 3: PluginSkillGenerator — 收集插件信息 + 跳过判断

**Files:**
- Create: `src/skills/builtin/plugin-ctrl/skill-generator.ts`
- Create: `test/plugin-skill-generator.test.ts`

- [ ] **Step 1: 写 collectPluginInfo 的测试**

创建 `test/plugin-skill-generator.test.ts`：

```typescript
import { App } from 'obsidian';
import { DEFAULT_SETTINGS } from '../src/mcp/types';

function mockFn(impl?: Function) {
  const fn: any = impl ? (...args: any[]) => impl(...args) : () => {};
  fn.mock = { calls: [] as any[] };
  const wrapper: any = (...args: any[]) => {
    fn.mock.calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  wrapper.mock = fn.mock;
  return wrapper;
}

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected)
        throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toEqual: (expected: any) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
    },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected))
        throw new Error(`Expected string to contain "${expected}"`);
    },
  };
}

const mockApp = {
  plugins: {
    manifests: {
      'obsidian-tasks-plugin': {
        id: 'obsidian-tasks-plugin', name: 'Tasks',
        version: '7.14.0', description: 'Task management for Obsidian',
      },
      'obsidian-minimal-settings': {
        id: 'obsidian-minimal-settings', name: 'Minimal Theme Settings',
        version: '1.0.0', description: 'Settings for Minimal theme',
      },
    },
    enabledPlugins: new Set([
      'obsidian-tasks-plugin', 'obsidian-minimal-settings',
    ]),
    getPlugin: (id: string) => {
      if (id === 'obsidian-tasks-plugin')
        return { settings: { globalFilter: '', defaultFolder: 'Tasks' } };
      return null;
    },
  },
  commands: {
    listCommands: () => [
      { id: 'obsidian-tasks-plugin:edit-task', name: 'Tasks: Edit task' },
      { id: 'obsidian-tasks-plugin:toggle-done', name: 'Tasks: Toggle done' },
      { id: 'editor:toggle-bold', name: 'Toggle bold' },
    ],
    executeCommandById: mockFn(() => true),
  },
  vault: {
    getAbstractFileByPath: mockFn(() => null),
    createFolder: mockFn(),
    create: mockFn(),
  },
} as unknown as App;

async function runTests() {
  console.log('Plugin Skill Generator Tests');
  const { PluginSkillGenerator } = await import(
    '../src/skills/builtin/plugin-ctrl/skill-generator'
  );

  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✅ ${name}`); }
    catch (e: any) { console.error(`  ❌ ${name}: ${e.message}`); process.exit(1); }
  }

  const mockModelService = {
    chat: async () => `---
name: plugin-obsidian-tasks
description: 管理待办任务。
triggers:
  keywords: ["待办", "task"]
tools: ["append_to_note", "execute_plugin_command"]
---
# Tasks
## 操作指南
1. 用 append_to_note 追加任务`,
  };

  const settings = {
    ...DEFAULT_SETTINGS,
    autoGeneratePluginSkills: true,
    pluginSkillExcludeList: [] as string[],
  };
  const generator = new PluginSkillGenerator(
    mockApp, mockModelService as any, settings,
  );

  await test('collectPluginInfo returns correct data', async () => {
    const info = generator.collectPluginInfo('obsidian-tasks-plugin');
    expect(info.id).toBe('obsidian-tasks-plugin');
    expect(info.name).toBe('Tasks');
    expect(info.commands.length).toBe(2);
    expect(info.commands[0].id).toBe('obsidian-tasks-plugin:edit-task');
  });

  await test('collectPluginInfo returns empty for unknown plugin', async () => {
    const info = generator.collectPluginInfo('nonexistent');
    expect(info.commands.length).toBe(0);
  });

  await test('shouldSkipPlugin true for no-command no-settings', async () => {
    const info = generator.collectPluginInfo('obsidian-minimal-settings');
    expect(generator.shouldSkipPlugin(info)).toBe(true);
  });

  await test('shouldSkipPlugin false for plugins with commands', async () => {
    const info = generator.collectPluginInfo('obsidian-tasks-plugin');
    expect(generator.shouldSkipPlugin(info)).toBe(false);
  });
}

runTests().catch(console.error);
```

- [ ] **Step 2: 创建 skill-generator.ts**

创建 `src/skills/builtin/plugin-ctrl/skill-generator.ts`：

```typescript
// src/skills/builtin/plugin-ctrl/skill-generator.ts
import { App } from 'obsidian';
import { PluginSettings, PLUGIN_ID } from '../../../mcp/types';

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  version: string;
  commands: { id: string; name: string }[];
  settings: Record<string, any>;
}

const SKILL_DIR = `.obsidian/obsidian-cli/skills`;

const SYSTEM_PROMPT = `你是一个 Obsidian 插件专家。根据提供的插件信息，生成一个 SKILL.md 文件。
这个文件将指导 AI 助手如何使用该插件完成用户任务。

输出格式要求：
1. YAML frontmatter：name, description, triggers.keywords, tools
2. Markdown body：插件能力、可用命令、操作指南

关键原则：
- name 格式：plugin-{pluginId}，小写+连字符
- description 简洁（<200字符），说明插件能做什么、什么时候用
- keywords 包含中英文触发词
- tools 列出 AI 需要的工具（vault 操作 + execute_plugin_command）
- 操作指南要具体：用什么工具、写什么格式、存到哪里
- 如果插件主要通过文件格式工作，重点描述文件格式而非命令
- 只输出 SKILL.md 的内容，不要包含其他说明文字`;

export class PluginSkillGenerator {
  constructor(
    private app: App,
    private modelService: any,
    private settings: PluginSettings,
  ) {}

  collectPluginInfo(pluginId: string): PluginInfo {
    const manifests = (this.app as any).plugins.manifests;
    const manifest = manifests[pluginId];
    const commands = (this.app as any).commands.listCommands()
      .filter((c: any) => c.id.startsWith(pluginId + ':'))
      .map((c: any) => ({ id: c.id, name: c.name }));
    const plugin = (this.app as any).plugins.getPlugin(pluginId);
    const settings = plugin?.settings || plugin?.data || {};
    return {
      id: pluginId,
      name: manifest?.name || pluginId,
      description: manifest?.description || '',
      version: manifest?.version || '',
      commands,
      settings,
    };
  }

  shouldSkipPlugin(info: PluginInfo): boolean {
    return info.commands.length === 0
      && Object.keys(info.settings).length === 0;
  }

  buildPrompt(info: PluginInfo): string {
    const cmdList = info.commands.length > 0
      ? info.commands.map(c => `- ${c.id} — ${c.name}`).join('\n')
      : '（无注册命令）';
    const settingsJson = Object.keys(info.settings).length > 0
      ? JSON.stringify(info.settings, null, 2)
      : '（无可读设置）';
    return `请为以下 Obsidian 插件生成 SKILL.md：

## 插件信息
- ID: ${info.id}
- 名称: ${info.name}
- 描述: ${info.description}
- 版本: ${info.version}

## 可用命令（${info.commands.length} 个）
${cmdList}

## 当前设置
${settingsJson}

请生成完整的 SKILL.md 内容（以 --- frontmatter --- 开头）。`;
  }

  async generateSkillMd(info: PluginInfo): Promise<string> {
    const prompt = this.buildPrompt(info);
    const response = await this.modelService.chat(
      prompt, [], SYSTEM_PROMPT,
    );
    // 提取 --- ... --- 开头的内容（AI 可能包裹在 code block 中）
    let content = response.trim();
    // 去掉 ```yaml 或 ```markdown 包裹
    const codeBlockMatch = content.match(
      /```(?:yaml|markdown|md)?\s*\n([\s\S]*?)```/
    );
    if (codeBlockMatch) content = codeBlockMatch[1].trim();
    // 确保以 --- 开头
    if (!content.startsWith('---')) {
      throw new Error('Generated content missing frontmatter');
    }
    return content;
  }

  async writeSkillFile(pluginId: string, content: string): Promise<string> {
    const dirPath = `${SKILL_DIR}/plugin-${pluginId}`;
    const filePath = `${dirPath}/SKILL.md`;
    // 确保目录存在
    if (!this.app.vault.getAbstractFileByPath(dirPath)) {
      await this.app.vault.createFolder(dirPath);
    }
    await this.app.vault.create(filePath, content);
    return filePath;
  }

  skillDirPath(pluginId: string): string {
    return `${SKILL_DIR}/plugin-${pluginId}`;
  }

  skillFilePath(pluginId: string): string {
    return `${this.skillDirPath(pluginId)}/SKILL.md`;
  }
}
```

- [ ] **Step 3: 运行测试**

Run: `npx tsx test/plugin-skill-generator.test.ts`
Expected: 全部 ✅

- [ ] **Step 4: Commit**

```bash
git add src/skills/builtin/plugin-ctrl/skill-generator.ts test/plugin-skill-generator.test.ts
git commit -m "feat(plugin-ctrl): add PluginSkillGenerator"
```

---

### Task 4: PluginWatcher — 插件状态监听 + skill 生命周期

**Files:**
- Create: `src/skills/builtin/plugin-ctrl/plugin-watcher.ts`
- Create: `test/plugin-watcher.test.ts`

- [ ] **Step 1: 写 PluginWatcher 的测试**

创建 `test/plugin-watcher.test.ts`：

```typescript
import { App } from 'obsidian';
import { DEFAULT_SETTINGS } from '../src/mcp/types';

function mockFn(impl?: Function) {
  const fn: any = impl ? (...args: any[]) => impl(...args) : () => {};
  fn.mock = { calls: [] as any[] };
  const wrapper: any = (...args: any[]) => {
    fn.mock.calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  wrapper.mock = fn.mock;
  return wrapper;
}

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected)
        throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toEqual: (expected: any) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
    },
  };
}

// 追踪 SkillRegistry 调用
const registeredSkills: string[] = [];
const unregisteredSkills: string[] = [];

const mockSkillRegistry = {
  registerUser: (skill: any) => { registeredSkills.push(skill.name); },
  unregisterSkill: (name: string) => { unregisteredSkills.push(name); },
  listSkills: () => registeredSkills.map(n => ({ name: n, description: '' })),
};

// 追踪 generator 调用
const generatedPlugins: string[] = [];
const mockGenerator = {
  collectPluginInfo: (id: string) => ({
    id, name: id, description: '', version: '1.0',
    commands: [{ id: `${id}:cmd`, name: 'cmd' }],
    settings: {},
  }),
  shouldSkipPlugin: () => false,
  generateSkillMd: async () => `---\nname: test\ndescription: test\n---\n# Test`,
  writeSkillFile: async (id: string) => {
    generatedPlugins.push(id);
    return `.obsidian/obsidian-cli/skills/plugin-${id}/SKILL.md`;
  },
  skillFilePath: (id: string) => `.obsidian/obsidian-cli/skills/plugin-${id}/SKILL.md`,
};

const enabledPlugins = new Set(['plugin-a', 'plugin-b']);

const mockApp = {
  plugins: {
    manifests: {
      'plugin-a': { id: 'plugin-a', name: 'A', version: '1.0', description: '' },
      'plugin-b': { id: 'plugin-b', name: 'B', version: '1.0', description: '' },
    },
    enabledPlugins,
    getPlugin: () => null,
  },
  commands: { listCommands: () => [] },
  vault: {
    getAbstractFileByPath: mockFn(() => null),
    createFolder: mockFn(),
    create: mockFn(),
    read: mockFn(),
  },
} as unknown as App;

async function runTests() {
  console.log('Plugin Watcher Tests');
  const { PluginWatcher } = await import(
    '../src/skills/builtin/plugin-ctrl/plugin-watcher'
  );

  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✅ ${name}`); }
    catch (e: any) { console.error(`  ❌ ${name}: ${e.message}`); process.exit(1); }
  }

  const settings = {
    ...DEFAULT_SETTINGS,
    autoGeneratePluginSkills: true,
    pluginSkillExcludeList: [] as string[],
  };

  const watcher = new PluginWatcher(
    mockApp,
    mockSkillRegistry as any,
    mockGenerator as any,
    settings,
  );

  await test('getEnabledPluginIds excludes obsidian-cli', async () => {
    const ids = watcher.getEnabledPluginIds();
    expect(ids.includes('obsidian-cli')).toBe(false);
  });

  await test('diffPlugins detects added plugins', async () => {
    const oldSet = new Set(['plugin-a']);
    const newSet = new Set(['plugin-a', 'plugin-b']);
    const diff = watcher.diffPlugins(oldSet, newSet);
    expect(diff.added.length).toBe(1);
    expect(diff.added[0]).toBe('plugin-b');
    expect(diff.removed.length).toBe(0);
  });

  await test('diffPlugins detects removed plugins', async () => {
    const oldSet = new Set(['plugin-a', 'plugin-b']);
    const newSet = new Set(['plugin-a']);
    const diff = watcher.diffPlugins(oldSet, newSet);
    expect(diff.removed.length).toBe(1);
    expect(diff.removed[0]).toBe('plugin-b');
  });
}

runTests().catch(console.error);
```

- [ ] **Step 2: 创建 plugin-watcher.ts**

创建 `src/skills/builtin/plugin-ctrl/plugin-watcher.ts`：

```typescript
// src/skills/builtin/plugin-ctrl/plugin-watcher.ts
import { App, Notice, TFile } from 'obsidian';
import { PluginSettings, PLUGIN_ID } from '../../../mcp/types';
import { SkillRegistry } from '../../skill-registry';
import { SkillLoader } from '../../skill-loader';
import { ToolRegistry } from '../../tool-registry';
import { PluginSkillGenerator } from './skill-generator';

const POLL_INTERVAL_MS = 10_000; // 10 秒
const GENERATE_DELAY_MS = 1_000; // 生成间隔 1 秒
const MAX_RETRIES = 3;

export class PluginWatcher {
  private snapshot: Set<string> = new Set();
  private intervalId: number | null = null;
  private failedRetries = new Map<string, number>();

  constructor(
    private app: App,
    private skillRegistry: SkillRegistry,
    private generator: PluginSkillGenerator,
    private settings: PluginSettings,
  ) {}

  /** 获取当前已启用插件 ID（排除自身） */
  getEnabledPluginIds(): string[] {
    const enabled = (this.app as any).plugins.enabledPlugins as Set<string>;
    return [...enabled].filter(id =>
      id !== PLUGIN_ID
      && !this.settings.pluginSkillExcludeList.includes(id)
    );
  }

  /** 对比两个集合，返回新增和移除 */
  diffPlugins(
    oldSet: Set<string>, newSet: Set<string>,
  ): { added: string[]; removed: string[] } {
    const added = [...newSet].filter(id => !oldSet.has(id));
    const removed = [...oldSet].filter(id => !newSet.has(id));
    return { added, removed };
  }

  /** 检查插件是否已有 SKILL.md */
  hasSkillFile(pluginId: string): boolean {
    const path = this.generator.skillFilePath(pluginId);
    return !!this.app.vault.getAbstractFileByPath(path);
  }

  /** 启动：首次扫描 + 定时轮询 */
  async start(): Promise<void> {
    if (!this.settings.autoGeneratePluginSkills) {
      console.log('[PluginWatcher] Disabled by settings');
      return;
    }
    console.log('[PluginWatcher] Starting...');
    await this.initialScan();
    this.intervalId = window.setInterval(
      () => this.checkChanges(),
      POLL_INTERVAL_MS,
    );
  }

  /** 停止轮询 */
  stop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('[PluginWatcher] Stopped');
  }

  /** 首次扫描 */
  private async initialScan(): Promise<void> {
    const pluginIds = this.getEnabledPluginIds();
    this.snapshot = new Set(pluginIds);

    const toGenerate = pluginIds.filter(id => !this.hasSkillFile(id));
    if (toGenerate.length === 0) {
      console.log('[PluginWatcher] All plugins have skills');
      return;
    }

    // 过滤掉应跳过的插件
    const candidates: string[] = [];
    for (const id of toGenerate) {
      const info = this.generator.collectPluginInfo(id);
      if (!this.generator.shouldSkipPlugin(info)) {
        candidates.push(id);
      }
    }

    if (candidates.length === 0) return;

    console.log(
      `[PluginWatcher] Generating skills for ${candidates.length} plugins`,
    );
    new Notice(
      `🔌 正在为 ${candidates.length} 个插件生成 Skill...`,
    );

    for (let i = 0; i < candidates.length; i++) {
      await this.generateAndRegister(candidates[i]);
      if (i < candidates.length - 1) {
        await this.delay(GENERATE_DELAY_MS);
      }
    }

    new Notice(`✅ 插件 Skill 生成完成（${candidates.length} 个）`);
  }

  /** 定时检查变化 */
  private async checkChanges(): Promise<void> {
    if (!this.settings.autoGeneratePluginSkills) return;

    const currentIds = new Set(this.getEnabledPluginIds());
    const { added, removed } = this.diffPlugins(this.snapshot, currentIds);

    // 处理新增
    for (const id of added) {
      if (this.hasSkillFile(id)) {
        // 文件已存在，直接加载注册
        await this.loadAndRegister(id);
      } else {
        const info = this.generator.collectPluginInfo(id);
        if (!this.generator.shouldSkipPlugin(info)) {
          new Notice(`🔌 正在为 ${info.name} 生成 Skill...`);
          await this.generateAndRegister(id);
        }
      }
    }

    // 处理移除
    for (const id of removed) {
      const skillName = `plugin-${id}`;
      this.skillRegistry.unregisterSkill(skillName);
      console.log(`[PluginWatcher] Unregistered skill: ${skillName}`);
    }

    this.snapshot = currentIds;
  }

  /** 生成 SKILL.md 并注册 */
  private async generateAndRegister(pluginId: string): Promise<void> {
    const retries = this.failedRetries.get(pluginId) || 0;
    if (retries >= MAX_RETRIES) return;

    try {
      const info = this.generator.collectPluginInfo(pluginId);
      const content = await this.generator.generateSkillMd(info);
      await this.generator.writeSkillFile(pluginId, content);
      await this.loadAndRegister(pluginId);
      this.failedRetries.delete(pluginId);
      console.log(`[PluginWatcher] Generated skill for: ${pluginId}`);
    } catch (e: any) {
      this.failedRetries.set(pluginId, retries + 1);
      console.error(
        `[PluginWatcher] Failed to generate skill for ${pluginId} `
        + `(attempt ${retries + 1}/${MAX_RETRIES}):`, e.message,
      );
    }
  }

  /** 从已有 SKILL.md 加载并注册 */
  private async loadAndRegister(pluginId: string): Promise<void> {
    const filePath = this.generator.skillFilePath(pluginId);
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof TFile)) return;

    const content = await this.app.vault.read(file);
    const loader = new SkillLoader(
      this.app,
      this.skillRegistry.getToolRegistry(),
    );
    const skill = loader.parseSkillMd(content);
    if (skill) {
      this.skillRegistry.registerUser(skill);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

- [ ] **Step 3: 运行测试**

Run: `npx tsx test/plugin-watcher.test.ts`
Expected: 全部 ✅

- [ ] **Step 4: 验证构建通过**

Run: `npm run build`
Expected: 构建成功

- [ ] **Step 5: Commit**

```bash
git add src/skills/builtin/plugin-ctrl/plugin-watcher.ts test/plugin-watcher.test.ts
git commit -m "feat(plugin-ctrl): add PluginWatcher for plugin state monitoring"
```

---

### Task 5: executor.ts — list_plugins 增加 hasSkill 字段

**Files:**
- Modify: `src/skills/builtin/plugin-ctrl/executor.ts:7-21`

- [ ] **Step 1: 修改 listPlugins 工具的 execute 方法**

在 `src/skills/builtin/plugin-ctrl/executor.ts` 中，修改 `listPlugins` 的 `execute` 方法，增加 `hasSkill` 字段：

```typescript
const listPlugins: Tool = {
  name: 'list_plugins',
  description: 'List all installed plugins and their status, including whether they have an AI skill.',
  parameters: { type: 'object', properties: {} },
  async execute(args, ctx) {
    if (!ctx.settings.allowPluginControl) return { error: 'Permission denied' };
    const manifests = (ctx.app as any).plugins.manifests;
    const enabled = (ctx.app as any).plugins.enabledPlugins;
    const SKILL_DIR = '.obsidian/obsidian-cli/skills';
    const list = Object.values(manifests).map((m: any) => ({
      id: m.id, name: m.name, version: m.version,
      enabled: enabled.has(m.id), description: m.description,
      hasSkill: !!ctx.app.vault.getAbstractFileByPath(
        `${SKILL_DIR}/plugin-${m.id}/SKILL.md`
      ),
    }));
    return { plugins: list, total: list.length };
  },
};
```

- [ ] **Step 2: 验证构建通过**

Run: `npm run build`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add src/skills/builtin/plugin-ctrl/executor.ts
git commit -m "feat(plugin-ctrl): list_plugins adds hasSkill field"
```

---

### Task 6: 更新 plugin-ctrl SKILL.md 为编排器角色

**Files:**
- Modify: `src/skills/builtin/plugin-ctrl/SKILL.md`

- [ ] **Step 1: 替换 SKILL.md 内容**

将 `src/skills/builtin/plugin-ctrl/SKILL.md` 替换为：

```yaml
---
name: plugin-ctrl
description: 发现和使用 Obsidian 插件。需要插件能力时先通过此 skill 查找合适插件。
triggers:
  keywords: ["插件", "plugin", "plugins"]
tools: ["list_plugins", "get_plugin_commands", "get_plugin_settings", "execute_plugin_command"]
---

# Plugin Control — 插件编排器

查询和控制 Obsidian 插件。自动为已安装插件生成使用 Skill。

## 工作流程

当用户的需求可能由某个插件完成时：

1. 查看 skill 摘要列表，是否已有匹配的 `plugin-*` skill
2. 如果有 → 直接调用该插件 skill（如 `use_skill("plugin-obsidian-tasks")`）
3. 如果没有 → 使用 `list_plugins` 查看已安装插件
4. 找到候选插件后，用 `get_plugin_commands` 了解其能力
5. 根据命令和设置信息，直接操作完成任务

## 可用工具

- `list_plugins` — 列出所有已安装插件及其启用状态和 skill 状态
- `get_plugin_commands` — 获取指定插件的可用命令
- `get_plugin_settings` — 获取指定插件的设置
- `execute_plugin_command` — 执行指定插件命令

## 原则

- 优先使用已有 skill 的插件（instructions 更完整）
- 没有 skill 的插件，退回到命令级操作
- 只有在没有合适插件时，才用纯 vault 操作创建普通 Markdown
```

- [ ] **Step 2: 验证构建通过**

Run: `npm run build`
Expected: 构建成功（esbuild text loader 加载 .md）

- [ ] **Step 3: Commit**

```bash
git add src/skills/builtin/plugin-ctrl/SKILL.md
git commit -m "feat(plugin-ctrl): update SKILL.md to orchestrator role"
```

---

### Task 7: main.ts 集成 PluginWatcher

**Files:**
- Modify: `main.ts:1-151`

- [ ] **Step 1: 添加 import**

在 `main.ts` 顶部 import 区域（约 line 18 之后），添加：

```typescript
import { PluginWatcher } from './src/skills/builtin/plugin-ctrl/plugin-watcher';
import { PluginSkillGenerator } from './src/skills/builtin/plugin-ctrl/skill-generator';
```

- [ ] **Step 2: 添加 pluginWatcher 属性**

在 `ObsidianCliPlugin` 类中（约 line 31），添加属性：

```typescript
private pluginWatcher: PluginWatcher | null = null;
```

- [ ] **Step 3: 在 onload 末尾启动 PluginWatcher**

在 `main.ts` 的 `onload()` 方法末尾（`registerEvent` 之后，约 line 142），添加：

```typescript
// 启动插件 Skill 自动生成（后台异步，不阻塞）
const skillGenerator = new PluginSkillGenerator(
  this.app, this.modelService, this.settings,
);
this.pluginWatcher = new PluginWatcher(
  this.app, this.skillRegistry, skillGenerator, this.settings,
);
this.pluginWatcher.start();
```

- [ ] **Step 4: 在 onunload 中停止 PluginWatcher**

在 `main.ts` 的 `onunload()` 方法中（约 line 145），在 `this.modelService.shutdown()` 之前添加：

```typescript
this.pluginWatcher?.stop();
```

- [ ] **Step 5: 验证构建通过**

Run: `npm run build`
Expected: 构建成功

- [ ] **Step 6: Commit**

```bash
git add main.ts
git commit -m "feat: integrate PluginWatcher into plugin lifecycle"
```

---

### Task 8: 设置页面增加插件 Skill 配置

**Files:**
- Modify: `src/settings.ts`

- [ ] **Step 1: 在设置页面添加插件 Skill 区域**

在 `src/settings.ts` 的 `display()` 方法中，找到合适位置（Knowledge Compiler 设置之后），添加：

```typescript
// --- 🔌 Plugin Skill Generator ---
containerEl.createEl('h3', { text: '🔌 Plugin Skill Generator' });

new Setting(containerEl)
  .setName('Auto-generate plugin skills')
  .setDesc('Automatically generate AI skills for installed plugins on startup.')
  .addToggle(toggle => toggle
    .setValue(this.plugin.settings.autoGeneratePluginSkills)
    .onChange(async (value) => {
      this.plugin.settings.autoGeneratePluginSkills = value;
      await this.plugin.saveSettings();
    }));

new Setting(containerEl)
  .setName('Excluded plugins')
  .setDesc('Plugin IDs to exclude from skill generation (comma-separated).')
  .addText(text => text
    .setPlaceholder('plugin-id-1, plugin-id-2')
    .setValue(this.plugin.settings.pluginSkillExcludeList.join(', '))
    .onChange(async (value) => {
      this.plugin.settings.pluginSkillExcludeList = value
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      await this.plugin.saveSettings();
    }));
```

- [ ] **Step 2: 验证构建通过**

Run: `npm run build`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add src/settings.ts
git commit -m "feat(settings): add plugin skill generator UI"
```
