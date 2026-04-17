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
