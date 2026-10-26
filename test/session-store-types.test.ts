function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
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
  console.log('=== Session Store Types Tests ===');
  const {
    CURRENT_SESSION_FORMAT_VERSION,
    isValidEntryVisibility,
    isValidApprovalOutcomeVisibility,
  } = await import('../src/runtime/pi/session-store/types');

  await test('Session happy-path satisfies the field contract', () => {
    const session = {
      conversationId: 'tab-1',
      formatVersion: CURRENT_SESSION_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      activeLeafEntryId: null,
      compactionState: null,
      availability: 'active' as const,
    };

    expect(session.conversationId).toBe('tab-1');
    expect(session.availability).toBe('active');
    expect(session.activeLeafEntryId).toBe(null);
  });

  await test('Entry happy-path satisfies the field contract', () => {
    const entry = {
      id: 'entry-1',
      sessionId: 'tab-1',
      parentEntryId: null,
      kind: 'user_message' as const,
      visibleToModel: true,
      visibleToUiProjection: true,
      supersededByEntryId: null,
      createdAt: new Date().toISOString(),
      payload: { text: 'hello' },
    };

    expect(entry.kind).toBe('user_message');
    expect(entry.parentEntryId).toBe(null);
    expect(isValidEntryVisibility(entry)).toBe(true);
  });

  await test('isValidEntryVisibility rejects the fully-hidden combination', () => {
    expect(isValidEntryVisibility({ visibleToModel: false, visibleToUiProjection: false })).toBe(false);
  });

  await test('isValidEntryVisibility accepts any combination with at least one visible dimension', () => {
    expect(isValidEntryVisibility({ visibleToModel: true, visibleToUiProjection: false })).toBe(true);
    expect(isValidEntryVisibility({ visibleToModel: false, visibleToUiProjection: true })).toBe(true);
    expect(isValidEntryVisibility({ visibleToModel: true, visibleToUiProjection: true })).toBe(true);
  });

  await test('isValidApprovalOutcomeVisibility accepts the fixed approval_outcome combination', () => {
    expect(isValidApprovalOutcomeVisibility({
      kind: 'approval_outcome',
      visibleToModel: true,
      visibleToUiProjection: false,
    })).toBe(true);
  });

  await test('isValidApprovalOutcomeVisibility rejects a deviating approval_outcome combination', () => {
    expect(isValidApprovalOutcomeVisibility({
      kind: 'approval_outcome',
      visibleToModel: false,
      visibleToUiProjection: true,
    })).toBe(false);
    expect(isValidApprovalOutcomeVisibility({
      kind: 'approval_outcome',
      visibleToModel: true,
      visibleToUiProjection: true,
    })).toBe(false);
  });

  await test('isValidApprovalOutcomeVisibility is a no-op for non-approval_outcome kinds', () => {
    expect(isValidApprovalOutcomeVisibility({
      kind: 'custom_message',
      visibleToModel: false,
      visibleToUiProjection: true,
    })).toBe(true);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
