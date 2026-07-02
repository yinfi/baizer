// test/permission-service.test.ts — 权限决策矩阵（Stage 2）
import { DEFAULT_SETTINGS } from '../src/mcp/types';
import {
  checkWriteScope,
  checkFileCapability,
  checkPluginControl,
  needsApproval,
  canWriteToVaultTarget,
} from '../src/permissions/permission-service';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
      }
    },
  };
}

async function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

function settings(overrides: Record<string, any> = {}) {
  return { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...overrides };
}

async function runTests() {
  console.log('=== PermissionService Tests ===');

  // ---- needsApproval：策略只来自 confirmExecutions + risk ----
  await test('needsApproval: confirmExecutions off => no approval for any risk', () => {
    const s = settings({ confirmExecutions: false });
    expect(needsApproval('write', s)).toBe(false);
    expect(needsApproval('plugin-control', s)).toBe(false);
  });

  await test('needsApproval: confirmExecutions on => write & plugin-control need approval', () => {
    const s = settings({ confirmExecutions: true });
    expect(needsApproval('write', s)).toBe(true);
    expect(needsApproval('plugin-control', s)).toBe(true);
  });

  await test('needsApproval: read & network never need approval', () => {
    const s = settings({ confirmExecutions: true });
    expect(needsApproval('read', s)).toBe(false);
    expect(needsApproval('network', s)).toBe(false);
  });

  // ---- checkFileCapability：按操作类别读对应开关 ----
  await test('checkFileCapability: create gated by allowFileCreation', () => {
    expect(checkFileCapability('create', settings({ allowFileCreation: false }))).toBe('File creation is disabled');
    expect(checkFileCapability('create', settings({ allowFileCreation: true }))).toBe(null);
  });

  await test('checkFileCapability: modify gated by allowFileModification', () => {
    expect(checkFileCapability('modify', settings({ allowFileModification: false }))).toBe('File modification is disabled');
    expect(checkFileCapability('modify', settings({ allowFileModification: true }))).toBe(null);
  });

  // ---- checkPluginControl ----
  await test('checkPluginControl gated by allowPluginControl', () => {
    expect(checkPluginControl(settings({ allowPluginControl: false }))).toBe('Permission denied');
    expect(checkPluginControl(settings({ allowPluginControl: true }))).toBe(null);
  });

  // ---- checkWriteScope × vaultWriteScope ----
  await test('checkWriteScope: read-only blocks all writes', () => {
    expect(checkWriteScope('Notes/a.md', settings({ vaultWriteScope: 'read-only' }))).toBe('Write not allowed for path: Notes/a.md');
  });

  await test('checkWriteScope: all-vault allows any path', () => {
    expect(checkWriteScope('Any/where.md', settings({ vaultWriteScope: 'all-vault' }))).toBe(null);
  });

  await test('checkWriteScope: configured-folders only allows inside folders', () => {
    const s = settings({ vaultWriteScope: 'configured-folders', vaultWriteAllowedFolders: ['Inbox'] });
    expect(checkWriteScope('Inbox/note.md', s)).toBe(null);
    expect(checkWriteScope('Other/note.md', s)).toBe('Write not allowed for path: Other/note.md');
  });

  await test('checkWriteScope: current-note only allows the active note', () => {
    const s = settings({ vaultWriteScope: 'current-note' });
    expect(checkWriteScope('A.md', s, 'A.md')).toBe(null);
    expect(checkWriteScope('B.md', s, 'A.md')).toBe('Write not allowed for path: B.md');
  });

  // ---- canWriteToVaultTarget 直接契约（test/vault-permissions 也依赖它经 vault-ops 再导出）----
  await test('canWriteToVaultTarget normalizes Windows backslashes', () => {
    expect(canWriteToVaultTarget({
      scope: 'configured-folders', target: 'Inbox\\sub\\n.md', configuredFolders: ['Inbox'],
    })).toBe(true);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
