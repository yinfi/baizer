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

  await test('loading a skill whose declared tools do not all resolve warns at load time, without changing what the skill gets', async () => {
    const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    const toolRegistry = new ToolRegistry({} as any, settings);
    toolRegistry.register({
      name: 'real_tool',
      description: 'A registered tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ ok: true }),
    });
    const registry = new SkillRegistry(toolRegistry);

    // 只加载，不激活——这是绝大多数 skill 一生的全部（无斜杠命令则永不激活）。
    // typo-skill 只有 keywords，正是"打错了工具名却永远没人告警"的那种形状。
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
    let loaded: boolean;
    try {
      loaded = registry.registerUserFromMd(`---
name: typo-skill
description: Declares one real tool and one typo
triggers:
  keywords: ["typo"]
tools: ["real_tool", "raed_note"]
---
Instructions.`, '.obsidian/baizer/skills/typo-skill/SKILL.md');
      // 内置 skill 走另一个注册入口，同样要在加载时告警。
      registry.registerBuiltinFromMd(`---
name: builtin-typo
description: Builtin declaring a typo
tools: ["raed_skill"]
---
Instructions.`, { execute: async () => ({ ok: true }) });
      // 声明名全部解析得到的 skill 不该被误报。
      registry.registerUserFromMd(`---
name: clean-skill
description: Declares only tools that resolve
tools: ["real_tool"]
---
Instructions.`, '.obsidian/baizer/skills/clean-skill/SKILL.md');
    } finally {
      console.warn = originalWarn;
    }

    // 告警须点名 skill 与未解析的工具名，两个入口各一条，解析成功的不点名。
    expect(warnings.length).toEqual(2);
    expect(warnings[0].includes('typo-skill') && warnings[0].includes('raed_note')).toEqual(true);
    expect(warnings[1].includes('builtin-typo') && warnings[1].includes('raed_skill')).toEqual(true);
    expect(warnings.some(w => w.includes('real_tool'))).toEqual(false);
    expect(warnings.some(w => w.includes('clean-skill'))).toEqual(false);
    // 行为不变：skill 照旧加载、照旧被提供给模型。
    expect(loaded).toEqual(true);
    expect(registry.getSkillSummaries().map(s => s.name)).toEqual(['typo-skill', 'builtin-typo', 'clean-skill']);
    // 工具子集只在激活时成形，仍是"解析成功的那些"，未解析的仍被丢弃。
    expect(registry.activateSkill('typo-skill')?.tools.map(t => t.name)).toEqual(['real_tool']);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
