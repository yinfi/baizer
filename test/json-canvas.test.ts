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
  console.log('=== JSON Canvas Tests ===');
  const { registerTools: registerJsonCanvasTools, executor } = await import(
    '../src/skills/builtin/json-canvas/executor'
  );

  await test('classifies validate_json_canvas as a parallel read-only tool', async () => {
    const toolRegistry = new ToolRegistry({} as any, DEFAULT_SETTINGS);
    registerJsonCanvasTools(toolRegistry);

    const tool = toolRegistry.get('validate_json_canvas');
    expect(!!tool, 'validate_json_canvas should be registered');
    expect(tool!.executionMode === 'parallel', 'validate_json_canvas should run in parallel');
    expect(tool!.risk === 'read', 'validate_json_canvas should be read-only');
  });

  await test('registers as a routable skill scoped to canvas file tools', async () => {
    const skillMd = readFileSync(
      join(process.cwd(), 'src/skills/builtin/json-canvas/SKILL.md'),
      'utf8',
    );
    const toolRegistry = new ToolRegistry({} as any, DEFAULT_SETTINGS);
    registerVaultTools(toolRegistry);
    registerJsonCanvasTools(toolRegistry);
    const registry = new SkillRegistry(toolRegistry);

    registry.registerBuiltinFromMd(skillMd, executor);

    const matched = registry.resolveByIntent('Create a mind map canvas for this project');
    expect(matched?.name === 'json-canvas', 'canvas request should route to json-canvas');

    const activated = registry.activateSkill('json-canvas');
    expect(!!activated, 'json-canvas should activate');
    const toolNames = activated!.tools.map(tool => tool.name).sort();
    expect(JSON.stringify(toolNames) === JSON.stringify([
      'create_file',
      'open_file',
      'read_file',
      'search_vault',
      'update_file',
      'validate_json_canvas',
    ]), `unexpected tool scope: ${JSON.stringify(toolNames)}`);
  });

  await test('validate_json_canvas accepts a valid canvas', async () => {
    const toolRegistry = new ToolRegistry({} as any, DEFAULT_SETTINGS);
    registerJsonCanvasTools(toolRegistry);

    const result = await toolRegistry.execute('validate_json_canvas', {
      content: JSON.stringify({
        nodes: [
          {
            id: '6f0ad84f44ce9c17',
            type: 'text',
            x: 0,
            y: 0,
            width: 300,
            height: 120,
            text: '# Main Idea',
          },
        ],
        edges: [],
      }),
    });

    expect(result.success === true, `valid canvas should pass: ${JSON.stringify(result)}`);
    expect(Array.isArray(result.errors) && result.errors.length === 0, 'valid canvas should have no errors');
  });

  await test('validate_json_canvas reports duplicate ids, dangling edges, and missing fields', async () => {
    const toolRegistry = new ToolRegistry({} as any, DEFAULT_SETTINGS);
    registerJsonCanvasTools(toolRegistry);

    const result = await toolRegistry.execute('validate_json_canvas', {
      content: JSON.stringify({
        nodes: [
          {
            id: 'aaaaaaaaaaaaaaaa',
            type: 'text',
            x: 0,
            y: 0,
            width: 300,
            height: 120,
          },
          {
            id: 'aaaaaaaaaaaaaaaa',
            type: 'file',
            x: 400,
            y: 0,
            width: 300,
            height: 120,
          },
        ],
        edges: [
          {
            id: 'bbbbbbbbbbbbbbbb',
            fromNode: 'aaaaaaaaaaaaaaaa',
            toNode: 'missing-node',
            fromSide: 'diagonal',
          },
        ],
      }),
    });

    expect(result.success === false, `invalid canvas should fail: ${JSON.stringify(result)}`);
    expectIncludes(result.errors, 'Duplicate id', 'should report duplicate ids');
    expectIncludes(result.errors, 'text', 'should report missing text field');
    expectIncludes(result.errors, 'file', 'should report missing file field');
    expectIncludes(result.errors, 'toNode', 'should report dangling edge');
    expectIncludes(result.errors, 'fromSide', 'should report invalid side');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
