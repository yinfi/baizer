// src/skills/builtin/read-skill.ts — B 方案的通用 skill 读取工具
//
// pi 原生激活机制：系统提示用 formatSkillsForSystemPrompt 列出 skill 清单 + location，
// 模型匹配到场景时调 read_skill(name) 拿完整指令正文。
//
// 为什么单独一个工具而非复用 read_note/read_file：
// skill 物化在 .obsidian 隐藏目录，Obsidian 的 metadataCache / getAbstractFileByPath
// 看不到点目录，那两个工具读不到。read_skill 走 vault.adapter.read（能读点目录），
// 并对内置 / 用户 / 未来任何 skill 统一生效——正是“通用激活”的读取端。

import type { Tool } from '../types';
import type { ToolRegistry } from '../tool-registry';
import type { SkillRegistry } from '../skill-registry';

/**
 * 注册 read_skill 工具。需要 skillRegistry 解析 skill 名 → 物化路径，
 * 故用工厂闭包注入（与 registerWebClipperTools 注入 modelService 同模式）。
 */
export function registerSkillReadTool(
  toolRegistry: ToolRegistry,
  skillRegistry: SkillRegistry,
): void {
  const readSkill: Tool = {
    name: 'read_skill',
    description:
      'Read the full instructions of a skill listed in <available_skills>. '
      + 'Call this when the current task matches a skill\'s description, then follow the returned instructions.',
    executionMode: 'parallel',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill name, e.g. "web-search"' },
      },
      required: ['name'],
    },
    async execute(args, ctx) {
      const name = typeof args?.name === 'string' ? args.name.trim() : '';
      if (!name) return { error: 'Missing skill name' };

      const resolved = skillRegistry.resolveForRead(name);
      if (!resolved) return { error: `Skill "${name}" not found or disabled` };

      // 优先读磁盘文件（用户 skill 的原件、内置 skill 每次启动被 materializeBuiltins
      // 从 bundle 覆写后的副本——内置由代码持有，手工编辑不会保留）；读不到则回退
      // 内存中的 pi formatSkillInvocation 结果（点目录读取异常时的兜底）。
      if (resolved.filePath) {
        try {
          const fileContent = await ctx.app.vault.adapter.read(resolved.filePath);
          if (fileContent?.trim()) {
            return { name, location: resolved.filePath, instructions: fileContent };
          }
        } catch {
          // 落到下方内存兜底。
        }
      }
      return { name, location: resolved.filePath, instructions: resolved.instructions };
    },
  };

  toolRegistry.register(readSkill);
}
