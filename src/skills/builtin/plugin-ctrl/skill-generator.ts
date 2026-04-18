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

const SYSTEM_PROMPT = `你是 Obsidian 插件专家。根据插件信息生成 SKILL.md。
这个文件指导 AI 助手用 vault 工具操作文件来完成任务。

严格按以下模板格式输出，不要改变 frontmatter 的结构：

---
name: plugin-{pluginId}
description: 一句话描述，不超过150字符
triggers:
  keywords: ["中文词", "英文词"]
tools: ["read_note", "append_to_note", "execute_plugin_command"]
---

# 插件名称

## 文件格式
（如果插件通过特定 Markdown 格式工作，给出格式示例）

## 操作指南
1. 操作名：工具名(参数) — 说明
2. ...

关键原则：
- frontmatter 中 description 必须是单行字符串，不要用 | 或 > 多行语法
- triggers 必须是嵌套格式（triggers:\n  keywords: [...]），不要用 triggers.keywords
- tools 用 JSON 数组格式 ["tool1", "tool2"]
- 操作指南必须包含具体的工具调用和文件路径示例
- 重点写"AI 怎么用工具操作文件"，不要写功能介绍
- 只输出 SKILL.md 内容`;

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
