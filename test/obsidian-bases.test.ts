import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_SETTINGS } from '../src/mcp/types';
import { registerVaultTools } from '../src/skills/builtin/vault-ops';
import { SkillRegistry } from '../src/skills/skill-registry';
import { ToolRegistry } from '../src/skills/tool-registry';

function expect(condition: boolean, label: string) {
  if (!condition) throw new Error(label);
}

function expectIncludes(values: string[], expected: string, label: string) {
  if (!values.some(value => value.includes(expected))) {
    throw new Error(`${label}: expected one error to include "${expected}", got ${JSON.stringify(values)}`);
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
  console.log('=== Obsidian Bases Tests ===');
  const { registerTools: registerObsidianBasesTools, executor } = await import(
    '../src/skills/builtin/obsidian-bases/executor'
  );

  await test('registers as a routable skill scoped to base file tools', async () => {
    const skillMd = readFileSync(
      join(process.cwd(), 'src/skills/builtin/obsidian-bases/SKILL.md'),
      'utf8',
    );
    const toolRegistry = new ToolRegistry({} as any, DEFAULT_SETTINGS);
    registerVaultTools(toolRegistry);
    registerObsidianBasesTools(toolRegistry);
    const registry = new SkillRegistry(toolRegistry);

    registry.registerBuiltinFromMd(skillMd, executor);

    const matched = registry.resolveByIntent('Create a base table view for active tasks');
    expect(matched?.name === 'obsidian-bases', 'base table request should route to obsidian-bases');

    const activated = registry.activateSkill('obsidian-bases');
    expect(!!activated, 'obsidian-bases should activate');
    const toolNames = activated!.tools.map(tool => tool.name).sort();
    expect(JSON.stringify(toolNames) === JSON.stringify([
      'create_file',
      'open_file',
      'read_file',
      'search_vault',
      'update_file',
      'validate_base_yaml',
    ]), `unexpected tool scope: ${JSON.stringify(toolNames)}`);
  });

  await test('validate_base_yaml accepts a valid base file', async () => {
    const toolRegistry = new ToolRegistry({} as any, DEFAULT_SETTINGS);
    registerObsidianBasesTools(toolRegistry);

    const result = await toolRegistry.execute('validate_base_yaml', {
      content: [
        'filters:',
        '  and:',
        '    - file.hasTag("task")',
        'formulas:',
        '  days_until_due: \'if(due, (date(due) - today()).days, "")\'',
        'properties:',
        '  formula.days_until_due:',
        '    displayName: "Days Until Due"',
        'views:',
        '  - type: table',
        '    name: "Active Tasks"',
        '    order:',
        '      - file.name',
        '      - status',
        '      - formula.days_until_due',
      ].join('\n'),
    });

    expect(result.success === true, `valid base should pass: ${JSON.stringify(result)}`);
    expect(Array.isArray(result.errors) && result.errors.length === 0, 'valid base should have no errors');
  });

  await test('validate_base_yaml reports yaml syntax and undefined formula references', async () => {
    const toolRegistry = new ToolRegistry({} as any, DEFAULT_SETTINGS);
    registerObsidianBasesTools(toolRegistry);

    const syntaxResult = await toolRegistry.execute('validate_base_yaml', {
      content: 'views:\n  - type: table\n    name: "Broken',
    });
    expect(syntaxResult.success === false, `invalid YAML should fail: ${JSON.stringify(syntaxResult)}`);
    expectIncludes(syntaxResult.errors, 'Invalid YAML', 'should report YAML syntax errors');

    const referenceResult = await toolRegistry.execute('validate_base_yaml', {
      content: [
        'views:',
        '  - type: table',
        '    name: "Broken Reference"',
        '    order:',
        '      - file.name',
        '      - formula.missing_total',
      ].join('\n'),
    });

    expect(referenceResult.success === false, `undefined formula should fail: ${JSON.stringify(referenceResult)}`);
    expectIncludes(referenceResult.errors, 'formula.missing_total', 'should report undefined formula references');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
