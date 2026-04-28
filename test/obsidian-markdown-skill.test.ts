import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_SETTINGS } from '../src/mcp/types';
import { registerVaultTools } from '../src/skills/builtin/vault-ops';
import { ToolRegistry } from '../src/skills/tool-registry';
import { SkillRegistry } from '../src/skills/skill-registry';

function expect(condition: boolean, label: string) {
  if (!condition) throw new Error(label);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
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
  console.log('=== Obsidian Markdown Skill Tests ===');

  await test('registers as a routable skill scoped to note editing tools', async () => {
    const skillMd = readFileSync(
      join(process.cwd(), 'src/skills/builtin/obsidian-markdown/SKILL.md'),
      'utf8',
    );

    const toolRegistry = new ToolRegistry({} as any, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    registerVaultTools(toolRegistry);
    const registry = new SkillRegistry(toolRegistry);

    registry.registerBuiltinFromMd(skillMd, {
      execute: async () => ({ ok: true }),
    });

    const matched = registry.resolveByIntent('Add a warning callout and wikilinks to this note');
    expect(matched?.name === 'obsidian-markdown', 'callout/wikilinks request should route to obsidian-markdown');

    const activated = registry.activateSkill('obsidian-markdown');
    expect(!!activated, 'obsidian-markdown should activate');
    expect(activated!.instructions.includes('Obsidian Flavored Markdown'), 'instructions should describe Obsidian markdown');
    expect(activated!.instructions.includes('> [!warning]'), 'instructions should include callout syntax');

    const toolNames = activated!.tools.map(tool => tool.name).sort();
    expectEqual(
      toolNames,
      [
        'append_to_note',
        'create_note',
        'list_notes',
        'open_file',
        'read_note',
        'search_vault',
        'update_note',
      ],
      'obsidian-markdown should expose only note-editing vault tools',
    );
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
