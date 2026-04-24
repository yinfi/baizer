// src/skills/builtin/plugin-ctrl/skill-generator.ts
import { App, requestUrl } from 'obsidian';
import { PluginSettings } from '../../../mcp/types';
import {
  USER_SKILLS_DIR,
  ensureDirectory,
  pluginSkillDirPath,
  pluginSkillFilePath,
} from '../../skill-files';

// ==================== 类型 ====================

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  version: string;
  commands: CommandInfo[];
  settingsKeys: string[];
  syntaxHints: string[];
  webContext: string;
}

interface CommandInfo {
  id: string;
  name: string;
  aiUsable: boolean;
  reason?: string;
}

// ==================== 常量 ====================


/** 合法的 vault 工具名（来自 vault-ops.ts + executor.ts） */
const SKILL_DIR = USER_SKILLS_DIR;
const VALID_TOOLS = [
  'read_note', 'create_note', 'update_note', 'append_to_note',
  'delete_note', 'rename_note', 'list_notes', 'search_vault', 'open_file',
  'execute_plugin_command', 'list_plugins', 'get_plugin_commands',
];

/** 命令名中包含这些词的通常需要 UI 交互，AI 无法直接调用 */
const UI_KEYWORDS = [
  'open', 'show', 'toggle', 'view', 'modal', 'picker',
  'select', 'insert', 'jump', 'focus', 'reveal',
];

/** 英文停用词，从 keywords 中过滤 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'your', 'you', 'this', 'that', 'it', 'its', 'yet', 'another', 'into',
  'not', 'can', 'has', 'have', 'had', 'will', 'would', 'could', 'should',
  'may', 'might', 'all', 'any', 'each', 'every', 'more', 'most', 'other',
  'plugin', 'obsidian', 'based', 'using', 'allows', 'allowing', 'use',
]);

const SYSTEM_PROMPT = `你是 Obsidian 插件专家。根据插件信息生成操作指南。

## 你的任务
输出 Markdown body 内容，格式要求：
1. 第一行必须是：<!-- DESC: 一句话中文描述，不超过100字 -->
   - 这句描述要概括插件的核心功能和 AI 能帮用户做什么，基于命令列表总结，不要直译英文描述
2. 然后是 # 标题开始的正文内容
不要输出 frontmatter（--- 块）。
这份指南告诉 AI 助手如何用 vault 工具配合该插件完成用户任务。

## 约束
- 不要输出 frontmatter、约束说明、或任何与操作指南无关的内容
- 操作指南中只使用下方列出的工具及其真实参数签名，禁止编造参数
- execute_plugin_command(commandId: string) 只接受一个参数 commandId
- execute_plugin_command 的局限：它只是触发命令，无法指定目标文件或传递额外参数；很多命令需要用户在编辑器中打开目标文件后才能生效
- 重点写"AI 怎么用 vault 工具读写文件来配合插件"，而不是简单翻译命令列表
- 如果插件通过特定 Markdown 格式存储数据，务必给出格式示例

## 好的示例

输入：插件 obsidian-tasks-plugin，命令 toggle-done / edit-task
输出：

<!-- DESC: 管理 vault 中的待办任务，支持截止日期、重复任务和完成状态追踪 -->

# Tasks

## 数据格式
任务以 Markdown checkbox 存储，支持 emoji 标记：
\`- [ ] 买牛奶 📅 2024-12-31\`
\`- [x] 写周报 ✅ 2024-06-01\`

## 操作指南
1. 查看任务：read_note(path) 读取笔记，识别 \`- [ ]\` 和 \`- [x]\` 行
2. 添加任务：append_to_note(path, "- [ ] 新任务描述 📅 YYYY-MM-DD")
3. 批量查找任务：search_vault("TODO") 或 list_notes(folder) 遍历目录
4. 标记完成（需要 UI）：先用 open_file(path) 打开笔记，再 execute_plugin_command("obsidian-tasks-plugin:toggle-done")

## 差的示例（不要这样写）
- 只列出 execute_plugin_command 调用，没有 vault 工具配合
- 给 execute_plugin_command 编造 path/content/task_identifier 等不存在的参数
- 把系统约束原样输出到操作指南中`;

// ==================== 生成器 ====================

export class PluginSkillGenerator {
  constructor(
    private app: App,
    private modelService: any,
    private settings: PluginSettings,
  ) {}

  // ---------- 信息收集 ----------

  async collectPluginInfo(pluginId: string): Promise<PluginInfo> {
    // 从 manifest.json 文件读取完整信息（比内存中的 manifest 更可靠）
    const manifestData = await this.readManifest(pluginId);
    const fallbackManifest = (this.app as any).plugins.manifests[pluginId];

    const name = manifestData.name || fallbackManifest?.name || pluginId;
    const description = manifestData.description || fallbackManifest?.description || '';

    const rawCommands = (this.app as any).commands.listCommands()
      .filter((c: any) => c.id.startsWith(pluginId + ':'))
      .map((c: any) => ({ id: c.id, name: c.name }));
    const commands = rawCommands.map((c: any) => this.classifyCommand(c));
    const plugin = (this.app as any).plugins.getPlugin(pluginId);
    const rawSettings = plugin?.settings || plugin?.data || {};
    const settingsKeys = this.extractSettingsKeys(rawSettings);

    // 本地层：从 main.js 提取语法标识符
    const syntaxHints = await this.extractSyntaxHints(pluginId);
    // 网络层：分层获取插件文档上下文
    const webContext = await this.fetchPluginContext(pluginId, name);

    console.log(`[SkillGenerator] ${pluginId} syntaxHints:`, syntaxHints);
    console.log(`[SkillGenerator] ${pluginId} webContext length:`, webContext.length);

    return {
      id: pluginId, name, description,
      version: manifestData.version || fallbackManifest?.version || '',
      commands, settingsKeys, syntaxHints, webContext,
    };
  }

  /** 从 main.js 提取代码块语法标识符 */
  private async extractSyntaxHints(pluginId: string): Promise<string[]> {
    try {
      const path = `.obsidian/plugins/${pluginId}/main.js`;
      // 用 adapter.read 直接读文件系统，vault API 不索引 .obsidian 目录
      let content: string;
      try {
        content = await this.app.vault.adapter.read(path);
      } catch {
        console.log(`[SkillGenerator] extractSyntaxHints ${pluginId}: file not found`);
        return [];
      }
      console.log(`[SkillGenerator] extractSyntaxHints ${pluginId}: file read, ${content.length} chars`);
      // 只取前 50KB
      const chunk = content.slice(0, 50_000);
      const hints = new Set<string>();
      // 搜索被引号包裹的短标识符（3-30字符，小写+连字符）
      const regex = /["']([a-z][a-z0-9-]{2,29})["']/g;
      let match;
      while ((match = regex.exec(chunk)) !== null) {
        const val = match[1];
        // 过滤常见噪音词
        if (val.includes(pluginId) || val.length < 3) continue;
        if (['function', 'object', 'string', 'number', 'boolean',
             'undefined', 'default', 'module', 'exports', 'require',
             'prototype', 'constructor', 'class'].includes(val)) continue;
        hints.add(val);
      }
      // 只保留可能是代码块名或 frontmatter key 的（含连字符或与插件名相关）
      const pluginShort = pluginId.replace(/^obsidian-?/, '').toLowerCase();
      return [...hints]
        .filter(h => h.includes('-') || h.includes(pluginShort)
          || ['dataview', 'dataviewjs', 'tasks', 'task', 'kanban',
              'button', 'button-maker', 'admonition', 'callout',
              'templater', 'excalidraw'].includes(h))
        .slice(0, 10);
    } catch {
      return [];
    }
  }

  /** 分层获取插件文档上下文 */
  private async fetchPluginContext(
    pluginId: string, pluginName: string,
  ): Promise<string> {
    // 1. 从 community-plugins.json 获取 repo，拼 GitHub raw README
    const repo = await this.getPluginRepo(pluginId);
    if (repo) {
      const rawUrl = `https://raw.githubusercontent.com/${repo}/HEAD/README.md`;
      const content = await this.fetchRawText(rawUrl);
      if (content) {
        console.log(`[SkillGenerator] ${pluginId}: got ${content.length} chars from GitHub README (${repo})`);
        return content;
      }
    }

    // 2. fallback: DuckDuckGo 搜索
    return this.searchPluginDocs(pluginName);
  }

  /** 社区插件索引缓存 */
  private communityPluginsCache: Record<string, string> | null = null;

  /** 从 community-plugins.json 获取插件的 GitHub repo */
  private async getPluginRepo(pluginId: string): Promise<string> {
    try {
      // 先尝试缓存
      if (this.communityPluginsCache) {
        return this.communityPluginsCache[pluginId] || '';
      }
      // 从 GitHub 获取官方索引
      const url = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json';
      const response = await requestUrl({ url });
      if (response.status !== 200) return '';
      const plugins: Array<{ id: string; repo: string }> = JSON.parse(response.text);
      // 缓存为 id -> repo 映射
      this.communityPluginsCache = {};
      for (const p of plugins) {
        this.communityPluginsCache[p.id] = p.repo;
      }
      console.log(`[SkillGenerator] Loaded community-plugins.json: ${plugins.length} plugins`);
      return this.communityPluginsCache[pluginId] || '';
    } catch (e: any) {
      console.warn(`[SkillGenerator] Failed to load community-plugins.json:`, e.message);
      return '';
    }
  }

  /** 从 manifest.json 读取基本信息 */
  private async readManifest(pluginId: string): Promise<{
    name: string; description: string; version: string;
  }> {
    try {
      const path = `.obsidian/plugins/${pluginId}/manifest.json`;
      const raw = await this.app.vault.adapter.read(path);
      const json = JSON.parse(raw);
      return {
        name: json.name || '',
        description: json.description || '',
        version: json.version || '',
      };
    } catch {
      return { name: '', description: '', version: '' };
    }
  }

  /** 抓取纯文本内容（用于 GitHub raw README） */
  private async fetchRawText(url: string): Promise<string> {
    try {
      const response = await requestUrl({ url });
      if (response.status !== 200) return '';
      return response.text;
    } catch {
      return '';
    }
  }

  /** 通过 DuckDuckGo 搜索插件文档摘要（fallback） */
  private async searchPluginDocs(pluginName: string): Promise<string> {
    try {
      const query = `obsidian ${pluginName} plugin usage markdown syntax`;
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

      // DuckDuckGo 可能返回 202（请稍候），需要重试
      let html = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await requestUrl({ url });
        console.log(`[SkillGenerator] web search for "${pluginName}": attempt=${attempt + 1}, status=${response.status}, html=${response.text.length} chars`);
        if (response.status === 200 && response.text.length > 20_000) {
          html = response.text;
          break;
        }
        // 202 或内容太短，等 2 秒后重试
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!html) return '';

      const snippets: string[] = [];
      const regex = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
      let match;
      while ((match = regex.exec(html)) !== null && snippets.length < 3) {
        const text = match[1].replace(/<[^>]+>/g, '').trim();
        if (text.length > 20) snippets.push(text);
      }
      return snippets.join('\n');
    } catch {
      return '';
    }
  }

  /** 启发式判断命令是否需要 UI 交互 */
  private classifyCommand(cmd: { id: string; name: string }): CommandInfo {
    const nameLower = cmd.name.toLowerCase();
    const needsUI = UI_KEYWORDS.some(k => nameLower.includes(k));
    return {
      id: cmd.id,
      name: cmd.name,
      aiUsable: !needsUI,
      reason: needsUI ? '需要 UI 交互' : undefined,
    };
  }

  /** 只提取 settings 顶层 key 名，不 dump 值 */
  private extractSettingsKeys(settings: Record<string, any>): string[] {
    try {
      return Object.keys(settings).slice(0, 15);
    } catch {
      return [];
    }
  }

  shouldSkipPlugin(info: PluginInfo): boolean {
    return info.commands.length === 0 && info.settingsKeys.length === 0;
  }

  // ---------- Frontmatter（代码生成，不交给 LLM） ----------

  private buildFrontmatter(info: PluginInfo, llmDesc?: string): string {
    const name = `plugin-${info.id}`;
    const desc = (llmDesc || info.description || info.name).slice(0, 150);
    const keywords = this.extractKeywords(info);
    const tools = this.inferTools(info);
    return [
      '---',
      `name: ${name}`,
      `description: ${desc}`,
      'triggers:',
      `  keywords: ${JSON.stringify(keywords)}`,
      `tools: ${JSON.stringify(tools)}`,
      '---',
    ].join('\n');
  }

  /** 从插件名称和描述中提取关键词 */
  private extractKeywords(info: PluginInfo): string[] {
    const kw = new Set<string>();
    // 插件名（去掉 obsidian- 前缀）
    const shortName = info.name.replace(/^obsidian[\s-]*/i, '').trim();
    if (shortName) kw.add(shortName);
    // 从描述中提取有意义的词（过滤停用词）
    const descWords = (info.description || '')
      .replace(/[.,;:!?()[\]{}'"]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && w.length < 20)
      .filter(w => !STOP_WORDS.has(w.toLowerCase()))
      .slice(0, 5);
    for (const w of descWords) kw.add(w.toLowerCase());
    // 加入语法标识符作为关键词
    for (const h of info.syntaxHints.slice(0, 3)) kw.add(h);
    return [...kw].slice(0, 8);
  }

  /** 根据插件命令推断需要的工具 */
  private inferTools(info: PluginInfo): string[] {
    const tools = new Set<string>();
    if (info.commands.length > 0) {
      tools.add('execute_plugin_command');
    }
    // 大多数插件 skill 都需要读写笔记来配合
    tools.add('read_note');
    tools.add('append_to_note');
    tools.add('search_vault');
    return [...tools];
  }

  // ---------- Prompt（只让 LLM 生成 body） ----------

  buildPrompt(info: PluginInfo): string {
    const aiCmds = info.commands.filter(c => c.aiUsable);
    const uiCmds = info.commands.filter(c => !c.aiUsable);

    const aiCmdList = aiCmds.length > 0
      ? aiCmds.map(c => `- ${c.id} — ${c.name}`).join('\n')
      : '（无）';
    const uiCmdList = uiCmds.length > 0
      ? uiCmds.map(c => `- ${c.id} — ${c.name}（${c.reason}）`).join('\n')
      : '（无）';
    const settingsList = info.settingsKeys.length > 0
      ? info.settingsKeys.join(', ')
      : '（无可读设置）';
    const syntaxSection = info.syntaxHints.length > 0
      ? `\n## 插件使用的 Markdown 语法标识符\n${info.syntaxHints.map(h => `- \`${h}\``).join('\n')}\n这些标识符通常用于代码块（如 \`\`\`${info.syntaxHints[0]}\`\`\`）或 frontmatter 字段。`
      : '';
    const webSection = info.webContext
      ? `\n## 网络搜索补充信息\n${info.webContext}`
      : '';

    return `请为以下插件生成操作指南（从 # 标题开始，不要输出 frontmatter）：

## 插件信息
- 名称: ${info.name}
- 描述: ${info.description}

## AI 可直接调用的命令
${aiCmdList}

## 需要 UI 交互的命令（需先 open_file 打开目标笔记）
${uiCmdList}

## 配置项（仅 key 名）
${settingsList}
${syntaxSection}
${webSection}

## 可用的 vault 工具签名
- read_note(path: string) — 读取笔记
- create_note(path: string, content: string) — 创建笔记
- update_note(path: string, content: string) — 覆盖更新笔记
- append_to_note(path: string, content: string) — 追加内容
- search_vault(query: string) — 搜索文件
- list_notes(folder?: string) — 列出笔记
- open_file(path: string) — 打开文件（配合需要 UI 的命令）
- execute_plugin_command(commandId: string) — 执行命令（只接受 commandId）

请生成操作指南，重点写 AI 如何用 vault 工具配合插件完成任务。`;
  }

  // ---------- 生成 + 拼装 + 校验 ----------

  async generateSkillMd(info: PluginInfo): Promise<string> {
    const prompt = this.buildPrompt(info);
    const response = await this.modelService.generate(prompt, SYSTEM_PROMPT);
    let body = response.trim();

    // 去掉可能的 code block 包裹
    const codeBlockMatch = body.match(
      /```(?:yaml|markdown|md)?\s*\n([\s\S]*?)```/
    );
    if (codeBlockMatch) body = codeBlockMatch[1].trim();

    // 去掉 LLM 可能输出的 frontmatter（我们自己生成）
    if (body.startsWith('---')) {
      const endIdx = body.indexOf('---', 3);
      if (endIdx > 0) {
        body = body.slice(endIdx + 3).trim();
      }
    }

    // 提取 LLM 生成的描述
    let llmDesc = '';
    const descMatch = body.match(/^<!--\s*DESC:\s*(.+?)\s*-->/);
    if (descMatch) {
      llmDesc = descMatch[1].slice(0, 150);
      body = body.slice(descMatch[0].length).trim();
    }

    // 确保 body 以 # 开头
    if (!body.startsWith('#')) {
      body = `# ${info.name}\n\n${body}`;
    }

    // 空内容兜底：body 去掉标题后不足 50 字符，用模板替代
    const bodyWithoutTitle = body.replace(/^#[^\n]*\n*/, '').trim();
    if (bodyWithoutTitle.length < 50) {
      const firstCmd = info.commands[0]?.id || `${info.id}:command`;
      body = `# ${info.name}\n\n## 操作指南\n1. 执行插件命令：execute_plugin_command("${firstCmd}")\n2. 搜索相关笔记：search_vault("${info.name}")\n3. 读取笔记内容：read_note(path) 获取文件内容后分析`;
      console.warn(`[SkillGenerator] Body too short for ${info.id}, using fallback template`);
    }

    // 校验
    const warnings = this.validateBody(body);
    if (warnings.length > 0) {
      console.warn(
        `[SkillGenerator] Validation warnings for ${info.id}:`,
        warnings.join('; '),
      );
    }

    // 用 LLM 描述（如果有）覆盖 manifest 描述
    const frontmatter = this.buildFrontmatter(info, llmDesc);
    return `${frontmatter}\n\n${body}`;
  }

  /** 校验生成的 body 内容 */
  private validateBody(body: string): string[] {
    const warnings: string[] = [];
    // 检查编造参数
    const fakeParams = ['path=', 'content=', 'task_identifier=', 'target_folder='];
    for (const p of fakeParams) {
      if (body.includes(p)) {
        warnings.push(`可能包含编造参数: ${p}`);
      }
    }
    // 检查是否泄漏了约束/系统提示
    const leakPatterns = ['关键原则', '不要输出', '禁止编造', '严格按以下'];
    for (const p of leakPatterns) {
      if (body.includes(p)) {
        warnings.push(`可能泄漏系统提示: "${p}"`);
      }
    }
    return warnings;
  }

  // ---------- 文件操作 ----------

  async writeSkillFile(pluginId: string, content: string): Promise<string> {
    const resolvedDirPath = pluginSkillDirPath(pluginId, USER_SKILLS_DIR);
    const resolvedFilePath = pluginSkillFilePath(pluginId, USER_SKILLS_DIR);
    const adapter = this.app.vault.adapter;

    await ensureDirectory(adapter, resolvedDirPath);
    if (await adapter.exists(resolvedFilePath)) return resolvedFilePath;
    await adapter.write(resolvedFilePath, content);
    return resolvedFilePath;

      // .obsidian 目录下 getAbstractFileByPath 不可靠，文件可能已存在
  }

  skillDirPath(pluginId: string): string {
    return pluginSkillDirPath(pluginId, USER_SKILLS_DIR);
  }

  skillFilePath(pluginId: string): string {
    return pluginSkillFilePath(pluginId, USER_SKILLS_DIR);
  }
}
