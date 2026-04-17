// src/skills/builtin/plugin-ctrl/skill-generator.ts
import { App } from 'obsidian';
import { PluginSettings } from '../../../mcp/types';

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
2. Markdown body：插件能力、文件格式、操作指南

关键原则：
- name 格式：plugin-{pluginId}，小写+连字符
- description 简洁（<200字符），说明插件能做什么、什么时候用
- keywords 包含中英文触发词
- tools 必须包含实际要用的 vault 工具（read_note, create_note, append_to_note, update_note, search_vault）和 execute_plugin_command
- 只输出 SKILL.md 的内容，不要包含其他说明文字

最重要的原则 — 文件操作指南必须具体：
- AI 助手通过 vault 工具操作文件来完成任务，不是通过 UI 交互
- 必须说明：用哪个工具（如 append_to_note）、写什么格式的内容、写到哪个文件路径
- 如果插件通过特定 Markdown 格式工作（如 checkbox 任务、kanban 列表），必须给出完整的格式示例
- 如果插件有默认文件夹或文件路径（从 settings 中读取），必须说明
- 操作指南中的每个步骤都要包含具体的工具调用示例，例如：
  "用 append_to_note 追加到 Daily/2026-04-18.md：\`- [ ] 任务内容 📅 2026-04-18\`"
- 如果不确定目标文件路径，说明默认策略（如"追加到今日 Daily Note，路径格式 Daily/YYYY-MM-DD.md"）`;

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

    // 收集 vault 顶层目录结构，帮助 AI 判断文件该放哪里
    const vaultFolders = this.getVaultTopFolders();
    const folderList = vaultFolders.length > 0
      ? vaultFolders.join(', ')
      : '（无法获取）';

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

## Vault 顶层目录
${folderList}

## AI 助手可用的 vault 工具
- read_note(path) — 读取笔记内容
- create_note(path, content) — 创建新笔记
- update_note(path, content) — 覆盖更新笔记
- append_to_note(path, content) — 追加内容到笔记末尾
- search_vault(query) — 搜索 vault 中的文件
- list_notes(folder) — 列出文件夹中的笔记
- execute_plugin_command(commandId) — 执行插件命令

请生成完整的 SKILL.md 内容（以 --- frontmatter --- 开头）。
操作指南中每个步骤必须包含具体的工具调用和文件路径示例。`;
  }

  /** 获取 vault 顶层文件夹名称 */
  private getVaultTopFolders(): string[] {
    try {
      const root = this.app.vault.getRoot();
      if (!root || !root.children) return [];
      return root.children
        .filter((f: any) => f.children !== undefined) // 只取文件夹
        .filter((f: any) => !f.name.startsWith('.'))   // 排除隐藏目录
        .map((f: any) => f.name)
        .slice(0, 20); // 最多 20 个
    } catch {
      return [];
    }
  }

  async generateSkillMd(info: PluginInfo): Promise<string> {
    const prompt = this.buildPrompt(info);
    // 用 generate（无状态单次生成），不走 chat（避免污染对话历史和触发 function calling）
    const response = await this.modelService.generate(
      prompt, SYSTEM_PROMPT,
    );
    let content = response.trim();
    const codeBlockMatch = content.match(
      /```(?:yaml|markdown|md)?\s*\n([\s\S]*?)```/
    );
    if (codeBlockMatch) content = codeBlockMatch[1].trim();
    if (!content.startsWith('---')) {
      throw new Error('Generated content missing frontmatter');
    }
    return content;
  }

  async writeSkillFile(pluginId: string, content: string): Promise<string> {
    const dirPath = `${SKILL_DIR}/plugin-${pluginId}`;
    const filePath = `${dirPath}/SKILL.md`;
    // 确保目录存在（忽略已存在错误）
    if (!this.app.vault.getAbstractFileByPath(dirPath)) {
      try { await this.app.vault.createFolder(dirPath); } catch (_) {}
    }
    // 如果文件已存在，跳过（不覆盖）
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing) {
      return filePath;
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
