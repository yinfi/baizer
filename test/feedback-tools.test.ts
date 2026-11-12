// test/feedback-tools.test.ts — 四个反馈工具的可见范围与提交契约
//
// 三条断言是 BR1.1 / 决策表 6 的验收依据：
//   ① 禁用 feedback 技能 → 反馈会话拿不到任何 vault 读工具（fail-closed）
//   ② 四个工具注册时确实带 visibility: 'feedback-session'（缺省是 fail-open，漏写无人守）
//   ③ 非反馈会话的工具集不含这四个工具

import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_SETTINGS } from '../src/mcp/types';
import { registerVaultTools } from '../src/skills/builtin/vault-ops';
import { registerSkillReadTool } from '../src/skills/builtin/read-skill';
import { ToolRegistry } from '../src/skills/tool-registry';
import { SkillRegistry } from '../src/skills/skill-registry';
import { FEEDBACK_SKILL_NAME, FEEDBACK_TOOL_NAMES } from '../src/skills/types';
import { createChatRuntime } from '../src/runtime/runtime-factory';
import { FeedbackDraftStore } from '../src/feedback/drafts';
import { GithubClient } from '../src/feedback/github';
import { registerFeedbackTools } from '../src/feedback/tools';

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

const VAULT_READ_TOOLS = [
  'read_note', 'read_file', 'search_vault', 'open_file', 'list_notes',
];

interface Harness {
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  drafts: FeedbackDraftStore;
  requests: Array<{ url: string; method: string; body?: string }>;
  respond: (status: number, payload: unknown, headers?: Record<string, string>) => void;
}

function buildHarness(options: { disabledSkills?: string[] } = {}): Harness {
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings.disabledSkills = options.disabledSkills ?? [];

  const toolRegistry = new ToolRegistry({} as any, settings);
  registerVaultTools(toolRegistry);
  const skillRegistry = new SkillRegistry(toolRegistry);
  registerSkillReadTool(toolRegistry, skillRegistry);

  const drafts = new FeedbackDraftStore({ persist: () => undefined });
  const requests: Harness['requests'] = [];
  let nextResponse: { status: number; payload: unknown; headers?: Record<string, string> } = {
    status: 201,
    payload: { number: 42, html_url: 'https://github.com/yinfi/baizer/issues/42' },
  };
  const client = new GithubClient({
    repo: 'yinfi/baizer',
    token: () => 'test-token',
    request: async (req) => {
      requests.push({ url: req.url, method: req.method ?? 'GET', body: req.body });
      return { status: nextResponse.status, text: JSON.stringify(nextResponse.payload), headers: nextResponse.headers };
    },
    wait: async () => undefined,
  });
  registerFeedbackTools(toolRegistry, {
    client,
    drafts,
    // 单测环境里构建期 define 不存在，凭据恒为「未配置」——这里显式注入，
    // 才能走到确认与提交路径（「未配置」本身另有断言）。
    isConfigured: () => true,
  });

  const feedbackSkillMd = readFileSync(
    join(process.cwd(), 'src/skills/builtin/feedback/SKILL.md'),
    'utf8',
  );
  skillRegistry.registerBuiltinFromMd(feedbackSkillMd, { execute: async () => ({ ok: true }) });

  return {
    toolRegistry,
    skillRegistry,
    drafts,
    requests,
    respond: (status, payload, headers) => { nextResponse = { status, payload, headers }; },
  };
}

function buildRuntime(harness: Harness) {
  return createChatRuntime({
    memoryManager: null,
    toolRegistry: harness.toolRegistry,
    skillRegistry: harness.skillRegistry,
  });
}

async function runTests() {
  console.log('=== Feedback Tools Tests ===');

  await test('the four feedback tools declare visibility: feedback-session', async () => {
    const harness = buildHarness();
    for (const name of FEEDBACK_TOOL_NAMES) {
      const tool = harness.toolRegistry.get(name);
      expect(!!tool, `tool ${name} must be registered`);
      expectEqual(tool?.visibility, 'feedback-session', `visibility of ${name}`);
    }
  });

  await test('a non-feedback conversation never sees the four feedback tools', async () => {
    const harness = buildHarness();
    const runtime = buildRuntime(harness);
    const prepared = await runtime.prepareTurn({ userMessage: 'hello', contextItems: [] });
    const names = prepared.tools.map(tool => tool.name);
    for (const name of FEEDBACK_TOOL_NAMES) {
      expect(!names.includes(name), `${name} must not be visible in a normal conversation`);
    }
    // 既有工具仍在（隔离不能顺手把普通对话的能力砍掉）。
    expect(names.includes('read_note'), 'vault tools must remain available in a normal conversation');
  });

  await test('getAllDefinitions() excludes feedback tools by default (fail-closed)', async () => {
    const harness = buildHarness();
    const byDefault = harness.toolRegistry.getAllDefinitions().map(tool => tool.name);
    const withFeedback = harness.toolRegistry
      .getAllDefinitions({ includeFeedbackTools: true })
      .map(tool => tool.name);
    for (const name of FEEDBACK_TOOL_NAMES) {
      expect(!byDefault.includes(name), `${name} must be excluded by default`);
      expect(withFeedback.includes(name), `${name} must be included when asked`);
    }
  });

  await test('an enabled feedback skill narrows the feedback session to the four tools plus read_skill', async () => {
    const harness = buildHarness();
    const runtime = buildRuntime(harness);
    const prepared = await runtime.prepareTurn({
      userMessage: 'the sidebar is blank',
      contextItems: [],
      isolatedContext: true,
      forcedSkillName: FEEDBACK_SKILL_NAME,
    });
    const names = prepared.tools.map(tool => tool.name).sort();
    expectEqual(names, [...FEEDBACK_TOOL_NAMES, 'read_skill'].sort(), 'feedback session tool set');
    expectEqual(prepared.blockedReason, undefined, 'a resolvable skill must not block the turn');
  });

  await test('disabling the feedback skill blocks the turn and grants no vault read tools', async () => {
    const harness = buildHarness({ disabledSkills: [FEEDBACK_SKILL_NAME] });
    const runtime = buildRuntime(harness);
    const prepared = await runtime.prepareTurn({
      userMessage: 'the sidebar is blank',
      contextItems: [],
      isolatedContext: true,
      forcedSkillName: FEEDBACK_SKILL_NAME,
    });
    const names = prepared.tools.map(tool => tool.name);
    for (const name of VAULT_READ_TOOLS) {
      expect(!names.includes(name), `${name} must never reach a feedback session (fail-open regression)`);
    }
    expectEqual(names.sort(), [...FEEDBACK_TOOL_NAMES, 'read_skill'].sort(), 'fail-closed tool set');
    expect(!!prepared.blockedReason, 'the turn must be blocked rather than run without the skill');
  });

  await test('an isolated turn carries the isolation flag through to PreparedChatTurn', async () => {
    const harness = buildHarness();
    const runtime = buildRuntime(harness);
    const prepared = await runtime.prepareTurn({
      userMessage: 'x', contextItems: [], isolatedContext: true, forcedSkillName: FEEDBACK_SKILL_NAME,
    });
    expectEqual(prepared.isolatedContext, true, 'isolatedContext must reach the retain short-circuit');
  });

  await test('create_github_issue renders a payload and asks for approval without publishing', async () => {
    const harness = buildHarness();
    const result = await harness.toolRegistry.execute('create_github_issue', {
      type: 'bug',
      title: 'Sidebar\nis blank',
      whatHappened: 'The sidebar shows nothing after opening the workbench.',
      repro: '1. Open the workbench\n2. Look at the sidebar',
      surface: 'Workbench (chat)',
    }, undefined, { conversationId: 'tab-1' });

    expect(result.approval_required === true, 'the first call must require approval');
    expectEqual(harness.requests.length, 0, 'nothing may be published before approval');
    const args = result.args as Record<string, unknown>;
    expectEqual(args.title, 'Sidebar is blank', 'the title must be folded to a single line');
    expectEqual(args.labels, ['bug'], 'labels come from the type');
    expectEqual(args.draftId !== '', true, 'the payload must carry the draft id');
    expect(typeof args.body === 'string' && (args.body as string).includes('### Steps to reproduce'),
      'the body must be rendered from the repository template fields');
  });

  await test('an approved payload publishes exactly once and a second approval is refused', async () => {
    const harness = buildHarness();
    const first = await harness.toolRegistry.execute('create_github_issue', {
      type: 'bug', title: 'Crash', whatHappened: 'It crashes.', repro: 'Open it.',
    }, undefined, { conversationId: 'tab-1' });
    const payload = first.args as Record<string, unknown>;
    expect(typeof payload.draftId === 'string' && payload.draftId.length > 0,
      `the approval payload must carry a draft id (${JSON.stringify(first)})`);

    const approved = await harness.toolRegistry.execute('create_github_issue', {
      ...payload, approved: true,
    }, undefined, { conversationId: 'tab-1' });
    expectEqual(approved.success, true, `the approved submission must succeed (${JSON.stringify(approved)})`);
    expectEqual(harness.requests.length, 1, 'exactly one POST must be sent');
    expectEqual(harness.requests[0].method, 'POST', 'the write must be a POST');

    // 同一张草稿再批准一次：③ 同步原子认领挡下（草稿已是 submitted）。
    const again = await harness.toolRegistry.execute('create_github_issue', {
      ...payload, approved: true,
    }, undefined, { conversationId: 'tab-1' });
    expectEqual(harness.requests.length, 1, 'a repeated approval must not publish again');
    expectEqual(again.alreadySubmitted, true, 'the repeat must echo the existing result');
  });

  await test('the same content reuses one draft instead of creating a second card', async () => {
    const harness = buildHarness();
    const input = { type: 'bug', title: 'Crash', whatHappened: 'It crashes.', repro: 'Open it.' };
    const a = await harness.toolRegistry.execute('create_github_issue', input, undefined, { conversationId: 'tab-1' });
    const b = await harness.toolRegistry.execute('create_github_issue', input, undefined, { conversationId: 'tab-1' });
    expectEqual((a.args as Record<string, unknown>).draftId, (b.args as Record<string, unknown>).draftId,
      'identical content must reuse the same draft');
    expectEqual(harness.drafts.list().length, 1, 'only one draft may exist');
  });

  await test('a failed submission is stored for retry with a classified reason', async () => {
    const harness = buildHarness();
    const first = await harness.toolRegistry.execute('create_github_issue', {
      type: 'enhancement', title: 'Add export', problem: 'No way to export.',
    }, undefined, { conversationId: 'tab-1' });
    harness.respond(401, { message: 'Bad credentials' });

    const approved = await harness.toolRegistry.execute('create_github_issue', {
      ...(first.args as Record<string, unknown>), approved: true,
    }, undefined, { conversationId: 'tab-1' });
    expectEqual(approved.success, false, 'a 401 must not be reported as success');
    const draft = harness.drafts.list()[0];
    expectEqual(draft.status, 'failed', 'the draft must be kept for retry');
    expectEqual(draft.lastError?.category, 'credentials', 'the failure must be classified');
  });

  await test('add_issue_comment goes through the same approval gate', async () => {
    const harness = buildHarness();
    const first = await harness.toolRegistry.execute('add_issue_comment', {
      issueNumber: 7, body: 'Same thing happens here.',
    }, undefined, { conversationId: 'tab-1' });
    expect(first.approval_required === true, 'commenting must require approval');
    expectEqual(harness.requests.length, 0, 'nothing may be published before approval');

    const approved = await harness.toolRegistry.execute('add_issue_comment', {
      ...(first.args as Record<string, unknown>), approved: true,
    }, undefined, { conversationId: 'tab-1' });
    expectEqual(approved.success, true, 'the approved comment must succeed');
    expect(harness.requests[0].url.endsWith('/issues/7/comments'), 'the comment must target the issue');
  });

  await test('a submission without a conversation id is refused instead of guessing', async () => {
    const harness = buildHarness();
    const result = await harness.toolRegistry.execute('create_github_issue', {
      type: 'bug', title: 'Crash', whatHappened: 'It crashes.', repro: 'Open it.',
    });
    expectEqual(result.success, false, 'a missing conversation id must be refused');
  });

  await test('get_plugin_diagnostics takes no arguments and returns the fixed field set', async () => {
    const { clearFeedbackErrors } = await import('../src/feedback/diagnostics');
    // 错误缓冲是进程级的，前面用例记过错误——这里清空以断言「无错误时的字段集合」。
    clearFeedbackErrors();
    const harness = buildHarness();
    const tool = harness.toolRegistry.get('get_plugin_diagnostics');
    expectEqual(Object.keys(tool?.parameters.properties ?? {}), [], 'the tool must accept no parameters');
    const result = await harness.toolRegistry.execute('get_plugin_diagnostics', {}, undefined, { conversationId: 'tab-1' });
    expectEqual(
      Object.keys(result).sort(),
      ['generatedAt', 'obsidianVersion', 'platform', 'pluginVersion', 'provider'],
      'the snapshot field set is closed (lastErrorDigest is omitted when there is no error)',
    );
  });

  await test('a recorded error surfaces as a redacted digest in the diagnostics snapshot', async () => {
    const { clearFeedbackErrors, recordFeedbackError } = await import('../src/feedback/diagnostics');
    clearFeedbackErrors();
    recordFeedbackError({ surface: 'shell', message: 'Failed to read C:\\Users\\someone\\vault\\note.md' });
    const harness = buildHarness();
    const result = await harness.toolRegistry.execute('get_plugin_diagnostics', {}, undefined, { conversationId: 'tab-1' });
    const digest = result.lastErrorDigest as string;
    expect(typeof digest === 'string' && digest.length > 0, 'the digest must be present once an error was recorded');
    expect(!digest.includes('someone'), 'the digest must not leak a local path');
    clearFeedbackErrors();
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
