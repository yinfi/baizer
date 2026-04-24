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

  await test('listCommandEntries returns enabled slash commands with skill metadata', async () => {
    const toolRegistry = new ToolRegistry({} as any, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
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
    }, () => false);

    expect(registry.listCommandEntries()).toEqual([
      {
        command: '/save',
        skillName: 'web-clipper',
        description: 'Save webpage to vault',
      },
    ]);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
