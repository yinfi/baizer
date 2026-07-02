// src/skills/pi-skill-source.ts
// 把内置 SKILL.md（esbuild text-loader 打进 bundle 的字符串）解析成
// pi 原生 Skill + Baizer sidecar。
//
// 为什么不用 pi 的 loadSkills：那是从 ExecutionEnv 读文件的目录加载器，
// 而内置 skill 是编译期字符串（非 vault 文件），落盘只会污染 vault。
// 用户自定义 skill（真实 vault 文件）在 Stage 3 才改走 pi loadSkills。
//
// sidecar 承载 pi Skill 刻意不建模的三件事：
//   - tools:    该 skill 的工具准入白名单（交给权限层，非 skill 本身）
//   - triggers: 斜杠命令 / 关键词路由（Baizer 特有的发现机制）
//   - executionMode: direct（execute 直接返回）| instructions（注入指引）

import { parse } from 'yaml';
import type { Skill as PiSkill } from '@earendil-works/pi-agent-core';

export interface SkillSidecar {
  /** 工具准入白名单：激活该 skill 时允许调用的工具名。空 = 无限制声明。 */
  tools: string[];
  /** 触发条件：斜杠命令与意图关键词。 */
  triggers?: { commands?: string[]; keywords?: string[] };
  /** 执行模式：simple → direct（execute 返回结果）；否则 instructions（注入指引）。 */
  executionMode: 'direct' | 'instructions';
}

/** pi Skill + Baizer sidecar 的组合，SkillRegistry 内部统一存这个。 */
export interface LoadedSkill {
  skill: PiSkill;
  sidecar: SkillSidecar;
}

/**
 * 解析内置 SKILL.md 字符串 → LoadedSkill。
 *
 * frontmatter 语义对齐 pi loadSkillFromFile：
 *   - name / description 必填，缺任一返回 null（跳过该 skill）
 *   - body 为 Level 2 instructions（触发时才进 context）
 *   - disable-model-invocation → pi Skill.disableModelInvocation
 * Baizer 扩展字段（tools / triggers / mode）进 sidecar，不进 pi Skill。
 *
 * @param md        bundled SKILL.md 原文
 * @param filePath  该 skill 的虚拟路径（供 pi 格式化器的 location 引用）
 */
export function parseBuiltinSkill(md: string, filePath: string): LoadedSkill | null {
  const normalized = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  let fm: Record<string, any> = {};
  let body = normalized.trim();
  if (match) {
    try {
      fm = parse(match[1]) ?? {};
    } catch {
      // frontmatter YAML 解析失败：视为无 frontmatter，全文作 body。
      fm = {};
    }
    body = match[2].trim();
  }

  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  const description = typeof fm.description === 'string' ? fm.description.trim() : '';
  if (!name || !description) return null;

  // name 校验（保 SkillLoader parity）：小写字母/数字/连字符，≤64。
  // 内置与用户 skill 统一走此校验；非法名返回 null（避免污染 commandIndex / read_skill 路由）。
  if (!/^[a-z0-9-]+$/.test(name) || name.length > 64) {
    console.warn(`[pi-skill-source] Invalid skill name: "${name}"`);
    return null;
  }

  return {
    skill: {
      name,
      description,
      content: body,
      filePath,
      disableModelInvocation: fm['disable-model-invocation'] === true,
    },
    sidecar: {
      tools: Array.isArray(fm.tools) ? fm.tools : [],
      triggers: normalizeTriggers(fm.triggers),
      executionMode: fm.mode === 'simple' ? 'direct' : 'instructions',
    },
  };
}

/** 归一化 triggers：只保留 commands / keywords 的字符串数组，其余丢弃。 */
function normalizeTriggers(raw: any): SkillSidecar['triggers'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const commands = Array.isArray(raw.commands) ? raw.commands.filter((c: any) => typeof c === 'string') : undefined;
  const keywords = Array.isArray(raw.keywords) ? raw.keywords.filter((k: any) => typeof k === 'string') : undefined;
  if (!commands?.length && !keywords?.length) return undefined;
  return { commands, keywords };
}

