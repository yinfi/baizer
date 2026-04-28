// src/skills/skill-loader.ts - SKILL.md parser
import { App } from 'obsidian';
import { ToolDefinition } from '../models/interfaces';
import { listSkillFilePaths } from './skill-files';
import { Skill, SkillTriggers, ToolContext } from './types';
import { ToolRegistry } from './tool-registry';

interface SkillFrontmatter {
  name: string;
  description: string;
  triggers?: SkillTriggers;
  tools?: string[];
  enabled?: boolean;
}

class UserSkill implements Skill {
  name: string;
  description: string;
  triggers?: SkillTriggers;
  enabled?: boolean;
  executionMode: 'instructions' = 'instructions';

  private instructions: string;
  private toolNames: string[];
  private toolRegistry: ToolRegistry;

  constructor(
    frontmatter: SkillFrontmatter,
    instructions: string,
    toolRegistry: ToolRegistry,
  ) {
    this.name = frontmatter.name;
    this.description = frontmatter.description;
    this.triggers = frontmatter.triggers;
    this.enabled = frontmatter.enabled ?? true;
    this.instructions = instructions;
    this.toolNames = frontmatter.tools ?? [];
    this.toolRegistry = toolRegistry;
  }

  getInstructions(): string {
    return this.instructions;
  }

  getTools(): ToolDefinition[] {
    return this.toolRegistry.getDefinitions(this.toolNames);
  }

  async execute(args: any, ctx: ToolContext): Promise<any> {
    return {
      instructions: this.instructions,
      tools: this.toolNames,
      message: `Skill "${this.name}" activated. Follow the instructions above.`,
    };
  }
}

export class SkillLoader {
  constructor(
    private app: App,
    private toolRegistry: ToolRegistry,
  ) {}

  async loadFromDirectory(dirPath: string): Promise<Skill[]> {
    const skills: Skill[] = [];
    const filePaths = await listSkillFilePaths(this.app.vault.adapter, dirPath);

    if (filePaths.length === 0) {
      console.log(`[SkillLoader] Skills directory not found: ${dirPath}`);
      return skills;
    }

    for (const filePath of filePaths) {
      const skill = await this.loadSkillFile(filePath);
      if (skill) skills.push(skill);
    }

    console.log(`[SkillLoader] Loaded ${skills.length} user skills from ${dirPath}`);
    return skills;
  }

  private async loadSkillFile(filePath: string): Promise<Skill | null> {
    try {
      const content = await this.app.vault.adapter.read(filePath);
      return this.parseSkillMd(content);
    } catch (e: any) {
      console.error(`[SkillLoader] Failed to load ${filePath}:`, e);
      return null;
    }
  }

  parseSkillMd(content: string): Skill | null {
    const { frontmatter, body } = this.extractFrontmatter(content);
    if (!frontmatter) return null;

    if (!frontmatter.name || !frontmatter.description) {
      console.warn('[SkillLoader] SKILL.md missing required fields: name, description');
      return null;
    }

    if (!/^[a-z0-9-]+$/.test(frontmatter.name) || frontmatter.name.length > 64) {
      console.warn(`[SkillLoader] Invalid skill name: "${frontmatter.name}"`);
      return null;
    }

    return new UserSkill(frontmatter, body.trim(), this.toolRegistry);
  }

  private extractFrontmatter(content: string): {
    frontmatter: SkillFrontmatter | null;
    body: string;
  } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
      return { frontmatter: null, body: content };
    }

    try {
      const yaml = this.parseSimpleYaml(match[1]);
      const frontmatter: SkillFrontmatter = {
        name: yaml.name ?? '',
        description: yaml.description ?? '',
        enabled: yaml.enabled,
        tools: yaml.tools,
        triggers: yaml.triggers,
      };
      return { frontmatter, body: match[2] };
    } catch (e: any) {
      console.error('[SkillLoader] YAML parse error:', e);
      return { frontmatter: null, body: content };
    }
  }

  private parseSimpleYaml(yaml: string): Record<string, any> {
    const result: Record<string, any> = {};
    let currentKey = '';
    let currentObj: Record<string, any> | null = null;

    for (const line of yaml.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      if (line.startsWith('  ') && currentKey && currentObj !== null) {
        const subMatch = trimmed.match(/^(\w+):\s*(.*)$/);
        if (subMatch) {
          currentObj[subMatch[1]] = this.parseYamlValue(subMatch[2]);
          result[currentKey] = currentObj;
          continue;
        }
      }

      const topMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (topMatch) {
        const key = topMatch[1];
        const rawValue = topMatch[2];

        if (rawValue === '' || rawValue === undefined) {
          currentKey = key;
          currentObj = {};
        } else {
          result[key] = this.parseYamlValue(rawValue);
          currentKey = '';
          currentObj = null;
        }
      }
    }

    return result;
  }

  private parseYamlValue(raw: string): any {
    if (!raw) return '';

    if (raw === 'true') return true;
    if (raw === 'false') return false;

    if (raw.startsWith('[') && raw.endsWith(']')) {
      const inner = raw.slice(1, -1);
      if (!inner.trim()) return [];
      return inner.split(',').map(s => {
        const v = s.trim();
        if ((v.startsWith('"') && v.endsWith('"')) ||
            (v.startsWith("'") && v.endsWith("'"))) {
          return v.slice(1, -1);
        }
        return v;
      });
    }

    if ((raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1);
    }

    if (/^\d+$/.test(raw)) return parseInt(raw, 10);

    return raw;
  }
}
