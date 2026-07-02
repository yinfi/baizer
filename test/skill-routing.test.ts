import { DEFAULT_SETTINGS } from '../src/mcp/types';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
    toBeNull: () => {
      if (actual !== null) {
        throw new Error(`Expected null but got ${JSON.stringify(actual)}`);
      }
    },
  };
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== Skill Routing Tests ===');
  const { ToolRegistry } = await import('../src/skills/tool-registry');
  const { SkillRegistry } = await import('../src/skills/skill-registry');

  await test('resolveByIntent prefers the enabled skill with the strongest keyword match', async () => {
    const toolRegistry = new ToolRegistry({} as any, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    const registry = new SkillRegistry(toolRegistry);

    registry.registerBuiltinFromMd(`---
name: web-clipper
description: Save webpages and videos
triggers:
  keywords: ["save", "clip", "webpage"]
tools: []
---
Web clipper instructions.`, {
      execute: async () => ({ ok: true }),
    });

    registry.registerBuiltinFromMd(`---
name: web-search
description: Search the web
triggers:
  keywords: ["search", "latest", "news"]
tools: []
---
Web search instructions.`, {
      execute: async () => ({ ok: true }),
    });

    const matched = registry.resolveByIntent('Please search the web for the latest Obsidian news');

    expect(matched?.name).toBe('web-search');
  });

  await test('resolveByIntent returns null when the only matching skill is disabled via settings', async () => {
    const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    // B 方案：禁用走 settings.disabledSkills，不再有 registerBuiltinFromMd 的 enabledFn。
    settings.disabledSkills = ['disabled-search'];
    const toolRegistry = new ToolRegistry({} as any, settings);
    const registry = new SkillRegistry(toolRegistry);

    registry.registerBuiltinFromMd(`---
name: disabled-search
description: Search the web
triggers:
  keywords: ["search"]
tools: []
---
Disabled instructions.`, {
      execute: async () => ({ ok: true }),
    });

    const matched = registry.resolveByIntent('Please search the web for something');

    expect(matched).toBeNull();
  });

  await test('resolveByIntent does not route generic file saves to web-clipper', async () => {
    const { readFile } = await import('node:fs/promises');
    const toolRegistry = new ToolRegistry({} as any, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    const registry = new SkillRegistry(toolRegistry);

    const skillMd = await readFile('src/skills/builtin/web-clipper/SKILL.md', 'utf8');
    registry.registerBuiltinFromMd(skillMd, {
      execute: async () => ({ ok: true }),
    });

    const matched = registry.resolveByIntent('保存文件到工作区');

    expect(matched).toBeNull();
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
