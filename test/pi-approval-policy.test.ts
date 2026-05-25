function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to contain ${expected}`);
      }
    },
  };
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== Pi Approval Policy Tests ===');
  const {
    createPiFileWriteState,
    formatPiApprovalMessage,
    isPiApprovalResponse,
    recordPiFileWriteResult,
    resolvePiFinalText,
  } = await import('../src/runtime/pi/pi-approval-policy');

  await test('formats approval-required responses with action and target', () => {
    expect(formatPiApprovalMessage({
      approval_required: true,
      action: 'create_file',
      target: 'Assets/a.canvas',
    })).toBe('Approval required to create_file: Assets/a.canvas');
  });

  await test('prefers explicit approval messages', () => {
    expect(formatPiApprovalMessage({
      approval_required: true,
      action: 'create_file',
      target: 'Assets/a.canvas',
      message: 'Please approve canvas creation',
    })).toBe('Please approve canvas creation');
  });

  await test('returns model text when file writes are not required', () => {
    const state = createPiFileWriteState(false);

    expect(resolvePiFinalText(state, 'done')).toBe('done');
  });

  await test('returns model text after a required write succeeds', () => {
    const state = createPiFileWriteState(true);
    recordPiFileWriteResult(state, 'create_file', { success: true, path: 'A.md' });

    expect(resolvePiFinalText(state, 'created A.md')).toBe('created A.md');
  });

  await test('warns when a required write is attempted but fails', () => {
    const state = createPiFileWriteState(true);
    recordPiFileWriteResult(state, 'create_file', {
      success: false,
      error: 'Unsafe vault path',
    });
    const text = resolvePiFinalText(state, 'created A.md');

    expect(text).toContain('No file was created or modified');
    expect(text).toContain('Unsafe vault path');
  });

  await test('warns when a required write never runs', () => {
    const state = createPiFileWriteState(true);
    const text = resolvePiFinalText(state, 'created A.md');

    expect(text).toContain('No file was created or modified');
    expect(text).toContain('no vault write tool ran');
  });

  await test('ignores non-write tool results for required write state', () => {
    const state = createPiFileWriteState(true);
    recordPiFileWriteResult(state, 'search_vault', {
      success: true,
      path: 'A.md',
    });

    expect(resolvePiFinalText(state, 'found A.md')).toContain('no vault write tool ran');
  });

  await test('detects approval responses only when approval is required', () => {
    expect(isPiApprovalResponse({ approval_required: true })).toBe(true);
    expect(isPiApprovalResponse({ success: true })).toBe(false);
    expect(isPiApprovalResponse(null)).toBe(false);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
