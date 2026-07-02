import { DEFAULT_SETTINGS } from '../src/mcp/types';

function expect(actual: any) {
  return {
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
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
  console.log('=== SkillRegistry Tests ===');
  const { ToolRegistry } = await import('../src/skills/tool-registry');
  const { SkillRegistry } = await import('../src/skills/skill-registry');

  await test('listCommandEntries returns commands, excluding skills disabled via settings.disabledSkills', async () => {
    const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    // B 方案：skill 可用性由 settings.disabledSkills 控制（与权限正交），
    // 不再有 registerBuiltinFromMd 的 enabledFn 参数。
    settings.disabledSkills = ['hidden-skill'];
    const toolRegistry = new ToolRegistry({} as any, settings);
    const registry = new SkillRegistry(toolRegistry);

    registry.registerBuiltinFromMd(`---
name: web-clipper
description: Save webpage to vault
triggers:
  commands: ["/save"]
tools: []
---
Save webpage instructions.`, {
      execute: async () => ({ ok: true }),
    });

    registry.registerBuiltinFromMd(`---
name: hidden-skill
description: Hidden command
triggers:
  commands: ["/hidden"]
tools: []
---
Hidden instructions.`, {
      execute: async () => ({ ok: true }),
    });

    expect(registry.listCommandEntries()).toEqual([
      {
        command: '/save',
        skillName: 'web-clipper',
        description: 'Save webpage to vault',
      },
    ]);
  });

  await test('getAllSkillSummaries lists disabled skills too (for settings toggles)', async () => {
    const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    settings.disabledSkills = ['hidden-skill'];
    const toolRegistry = new ToolRegistry({} as any, settings);
    const registry = new SkillRegistry(toolRegistry);
    registry.registerBuiltinFromMd(`---
name: hidden-skill
description: Hidden command
tools: []
---
x`, { execute: async () => ({ ok: true }) });

    const names = registry.getAllSkillSummaries().map(s => s.name);
    expect(names).toEqual(['hidden-skill']);
    // 被禁用则不进 enabled 清单
    expect(registry.getSkillSummaries().map(s => s.name)).toEqual([]);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
