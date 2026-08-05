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
  keywords: ["search", "web"]
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

  // ---- F1-2: 泛词不再单次命中即路由 ----

  await test('resolveByIntent does not route bare generic keywords like knowledge/clip', async () => {
    const toolRegistry = new ToolRegistry({} as any, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    const registry = new SkillRegistry(toolRegistry);

    registry.registerBuiltinFromMd(`---
name: knowledge
description: Knowledge base
triggers:
  keywords: ["知识库", "knowledge", "wiki"]
tools: []
---
Knowledge instructions.`, {
      execute: async () => ({ ok: true }),
    });

    // 泛词 "知识" 不再命中（已从关键词移除）；单次 "knowledge" 命中不足阈值。
    expect(registry.resolveByIntent('请分享你的知识')).toBeNull();
    expect(registry.resolveByIntent('I have some knowledge about this')).toBeNull();
    // 多个关键词才激活
    expect(registry.resolveByIntent('搜索我的知识库 wiki')?.name === 'knowledge').toBe(true);
  });

  await test('resolveByIntent routes web-clipper only on strong signals, not bare URLs', async () => {
    const { readFile } = await import('node:fs/promises');
    const toolRegistry = new ToolRegistry({} as any, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    const registry = new SkillRegistry(toolRegistry);

    const skillMd = await readFile('src/skills/builtin/web-clipper/SKILL.md', 'utf8');
    registry.registerBuiltinFromMd(skillMd, {
      execute: async () => ({ ok: true }),
    });

    // 裸 URL 不再触发（http:// 已从关键词移除）
    expect(registry.resolveByIntent('https://example.com 帮我总结一下')).toBeNull();
    // 明确剪藏意图（剪藏 + 网页 双命中）仍触发
    expect(registry.resolveByIntent('帮我剪藏这个网页 https://x.com')?.name === 'web-clipper').toBe(true);
    // 短语 "保存这个视频" 加权命中
    expect(registry.resolveByIntent('帮我保存这个视频到 vault')?.name === 'web-clipper').toBe(true);
  });

  await test('resolveByIntent ignores skills that disable model invocation', async () => {
    const toolRegistry = new ToolRegistry({} as any, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    const registry = new SkillRegistry(toolRegistry);
    registry.registerBuiltinFromMd(`---
name: manual-only
description: Manual activation only
disable-model-invocation: true
triggers:
  keywords: ["manual workflow"]
tools: []
---
Manual instructions.`, { execute: async () => ({ ok: true }) });

    expect(registry.resolveByIntent('Run the manual workflow')).toBeNull();
  });

  await test('command collisions keep the first owner when another skill is removed', async () => {
    const collisionSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    const toolRegistry = new ToolRegistry({} as any, collisionSettings);
    const registry = new SkillRegistry(toolRegistry);
    const skillMd = (name: string) => `---
name: ${name}
description: ${name}
triggers:
  commands: ["/same"]
tools: []
---
Instructions.`;
    registry.registerBuiltinFromMd(skillMd('first-skill'), { execute: async () => ({ ok: true }) });
    registry.registerBuiltinFromMd(skillMd('second-skill'), { execute: async () => ({ ok: true }) });

    expect(registry.resolveByCommand('/same')?.name).toBe('first-skill');
    expect(registry.listCommandEntries().length).toBe(1);
    expect(registry.listCommandEntries()[0].skillName).toBe('first-skill');
    collisionSettings.disabledSkills = ['first-skill'];
    expect(registry.resolveByCommand('/same')?.name).toBe('second-skill');
    expect(registry.listCommandEntries()[0].skillName).toBe('second-skill');
    collisionSettings.disabledSkills = [];
    registry.unregisterSkill('second-skill');
    expect(registry.resolveByCommand('/same')?.name).toBe('first-skill');

    const fallbackRegistry = new SkillRegistry(toolRegistry);
    fallbackRegistry.registerBuiltinFromMd(skillMd('first-skill'), { execute: async () => ({ ok: true }) });
    fallbackRegistry.registerBuiltinFromMd(skillMd('second-skill'), { execute: async () => ({ ok: true }) });
    fallbackRegistry.unregisterSkill('first-skill');
    expect(fallbackRegistry.resolveByCommand('/same')?.name).toBe('second-skill');
  });

  await test('registerUserFromMd warns about unknown tool names without rejecting the skill', async () => {
    const toolRegistry = new ToolRegistry({} as any, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    const registry = new SkillRegistry(toolRegistry);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    let registered = false;
    try {
      console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
      registered = registry.registerUserFromMd(`---
name: invalid-tools
description: Invalid tools
tools: [missing_tool]
---
Instructions.`, '/invalid/SKILL.md');
    } finally {
      console.warn = originalWarn;
    }

    expect(registered).toBe(true);
    expect(warnings.some(message => message.includes('missing_tool'))).toBe(true);
    expect(registry.activateSkill('invalid-tools')?.tools.length).toBe(0);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
