(global as any).window = {
  setInterval,
  clearInterval,
};

(global as any).localStorage = {
  getItem: () => null,
  setItem: () => { },
  removeItem: () => { },
  key: () => null,
  length: 0,
};

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
    toEqual: (expected: any) => {
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expected);
      if (actualStr !== expectedStr) {
        throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
      }
    },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected "${actual}" to contain "${expected}"`);
      }
    },
    toBeUndefined: () => {
      if (actual !== undefined) {
        throw new Error(`Expected undefined but got ${JSON.stringify(actual)}`);
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

function approvalMessage(overrides: any = {}) {
  return {
    id: 'msg-1',
    role: 'system',
    content: 'Approval required to delete note: Docs/a.md',
    timestamp: 1,
    approval: {
      id: 'req-1',
      conversationId: 'conv-1',
      action: 'delete_note',
      target: 'Docs/a.md',
      args: { path: 'Docs/a.md' },
      message: 'Approval required to delete note: Docs/a.md',
      ...overrides.approval,
    },
    approvalState: overrides.approvalState,
  } as any;
}

async function createController(api: any, conversationId = 'conv-1') {
  const { ChatController } = await import('../src/ui/chat-controller');
  const messages: any[] = [];
  const controller = new ChatController({
    app: {} as any,
    api: {
      executeApprovedAction: async () => ({ success: true }),
      reconcileApprovedAction: async () => null,
      ...api,
    } as any,
    conversationId,
    onMessageAdded: (message: any) => messages.push(message),
    onMessageUpdated: (message: any) => {
      const index = messages.findIndex(item => item.id === message.id);
      if (index >= 0) messages[index] = message;
      else messages.push(message);
    },
  });
  return { controller, messages };
}

async function runTests() {
  console.log('=== Approval Lifecycle Tests ===');
  const { setLocaleForTesting } = await import('../src/i18n/zh');
  setLocaleForTesting(false);
  const { ApprovalExecutionRegistry } = await import('../src/services/approval-execution');

  await test('double approval only executes once and keeps the card in a running state', async () => {
    let calls = 0;
    let resolveExecution: ((value: any) => void) | null = null;
    const { controller, messages } = await createController({
      executeApprovedAction: async () => {
        calls += 1;
        return await new Promise(resolve => { resolveExecution = resolve; });
      },
    });

    controller.adoptMessages([approvalMessage()]);
    const first = controller.approveApproval('msg-1');
    const second = controller.approveApproval('msg-1');

    expect(calls).toBe(1);
    expect(messages[0].approvalState.status).toBe('running');
    expect(messages[0].approval).toEqual(approvalMessage().approval);
    expect(messages[0].content).toBe(approvalMessage().content);

    resolveExecution?.({
      kind: 'approval-execution',
      status: 'succeeded',
      detail: 'Deleted',
      target: 'Docs/a.md',
      completedAt: 2,
      retryable: false,
    });
    await first;
    await second;

    expect(calls).toBe(1);
    expect(messages[0].approvalState.status).toBe('succeeded');
    expect(messages[0].approvalState.outcome.detail).toBe('Deleted');

    controller.cleanup();
  });

  await test('a failed execution records the reason and a retry executes once more', async () => {
    let calls = 0;
    const { controller, messages } = await createController({
      executeApprovedAction: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            kind: 'approval-execution',
            status: 'failed',
            error: 'File is locked',
            detail: 'File is locked',
            completedAt: 2,
            retryable: true,
          };
        }
        return {
          kind: 'approval-execution',
          status: 'succeeded',
          detail: 'Deleted',
          completedAt: 3,
          retryable: false,
        };
      },
    });

    controller.adoptMessages([approvalMessage()]);
    await controller.approveApproval('msg-1');
    expect(messages[0].approvalState.status).toBe('failed');
    expect(messages[0].approvalState.outcome.error).toBe('File is locked');
    expect(messages[0].approvalState.outcome.retryable).toBe(true);

    await controller.retryApproval('msg-1');
    expect(calls).toBe(2);
    expect(messages[0].approvalState.status).toBe('succeeded');

    // 成功后再点重试/批准都是幂等空操作。
    await controller.retryApproval('msg-1');
    await controller.approveApproval('msg-1');
    expect(calls).toBe(2);

    controller.cleanup();
  });

  await test('rejecting never calls the execution API and leaves a rejected record', async () => {
    let calls = 0;
    const { controller, messages } = await createController({
      executeApprovedAction: async () => {
        calls += 1;
        return { success: true };
      },
    });

    controller.adoptMessages([approvalMessage()]);
    controller.rejectApproval('msg-1');

    expect(calls).toBe(0);
    expect(messages[0].approvalState.status).toBe('rejected');
    expect(messages[0].approvalState.outcome.detail).toBe('No write was performed.');
    expect(messages[0].content).toBe(approvalMessage().content);

    controller.cleanup();
  });

  await test('an already-succeeded approval restored from a snapshot is not executed again', async () => {
    let calls = 0;
    const { controller } = await createController({
      executeApprovedAction: async () => {
        calls += 1;
        return { success: true };
      },
    });

    controller.adoptMessages([approvalMessage({
      approvalState: {
        status: 'succeeded',
        outcome: { status: 'succeeded', detail: 'Deleted', completedAt: 2 },
      },
    })]);
    await controller.approveApproval('msg-1');
    expect(calls).toBe(0);

    controller.cleanup();
  });

  await test('a running approval restored from a snapshot is reconciled without re-executing', async () => {
    let executeCalls = 0;
    let reconcileCalls = 0;
    const { controller, messages } = await createController({
      executeApprovedAction: async () => {
        executeCalls += 1;
        return { success: true };
      },
      reconcileApprovedAction: async () => {
        reconcileCalls += 1;
        return {
          kind: 'approval-execution',
          status: 'succeeded',
          detail: 'Deleted',
          completedAt: 4,
        };
      },
    });

    controller.adoptMessages([approvalMessage({ approvalState: { status: 'running' } })]);
    await Promise.resolve();
    await Promise.resolve();

    expect(executeCalls).toBe(0);
    expect(reconcileCalls).toBe(1);
    expect(messages[0].approvalState.status).toBe('succeeded');

    controller.cleanup();
  });

  await test('an approval from another conversation is refused instead of executed', async () => {
    let calls = 0;
    const { controller, messages } = await createController({
      executeApprovedAction: async () => {
        calls += 1;
        return { success: true };
      },
    }, 'conv-2');

    controller.adoptMessages([approvalMessage()]);
    await controller.approveApproval('msg-1');

    expect(calls).toBe(0);
    expect(messages[0].approvalState.status).toBe('failed');
    expect(messages[0].approvalState.outcome.detail).toContain('another conversation');

    controller.cleanup();
  });

  await test('execution registry reuses an in-flight promise and never replays success', async () => {
    const registry = new ApprovalExecutionRegistry();
    let calls = 0;
    let resolveExecution: ((value: any) => void) | null = null;
    const execute = async () => {
      calls += 1;
      return await new Promise(resolve => { resolveExecution = resolve; });
    };

    const first = registry.run('req-registry', execute as any);
    const second = registry.run('req-registry', execute as any);
    expect(calls).toBe(1);

    resolveExecution?.({
      kind: 'approval-execution',
      status: 'succeeded',
      completedAt: 1,
    });
    const firstResult = await first;
    const secondResult = await second;
    expect(firstResult).toBe(secondResult);

    await registry.run('req-registry', execute as any, { retry: true });
    expect(calls).toBe(1);
  });

  await test('execution registry allows an explicit retry only after a failure', async () => {
    const registry = new ApprovalExecutionRegistry();
    let calls = 0;
    const execute = async () => {
      calls += 1;
      return {
        kind: 'approval-execution' as const,
        status: calls === 1 ? 'failed' as const : 'succeeded' as const,
        completedAt: calls,
        retryable: calls === 1,
      };
    };

    const first = await registry.run('req-retry', execute);
    expect(first.status).toBe('failed');
    const second = await registry.run('req-retry', execute, { retry: true });
    expect(second.status).toBe('succeeded');
    expect(calls).toBe(2);
  });

  await test('unknown → recheck → retry really executes the tool a second time (#76 P1)', async () => {
    const { ApprovalExecutionRegistry } = await import('../src/services/approval-execution');
    const { ModelService } = await import('../src/services/model-service');

    // 内存审计替身：与真实 OperationAuditLog 同形状（请求状态 + 操作记录）。
    const operations: any[] = [];
    const requests = new Map<string, any>();
    const auditLog = {
      record: async (input: any) => { operations.unshift({ ...input, timestamp: Date.now() }); },
      list: async () => operations.slice(),
      beginRequest: async (input: any) => {
        requests.set(input.id, {
          id: input.id, action: input.action, target: input.target,
          state: 'attempting', timestamp: Date.now(), updatedAt: Date.now(),
        });
      },
      finishRequest: async (input: any) => {
        operations.unshift({ ...input, timestamp: Date.now() });
        const previous = requests.get(input.id);
        requests.set(input.id, {
          id: input.id, action: input.action, target: input.target,
          state: input.outcome, timestamp: previous?.timestamp ?? Date.now(), updatedAt: Date.now(),
        });
      },
      getRequestState: async (id: string) => requests.get(id),
      getPrunedRequestBefore: async () => 0,
    };

    const service: any = Object.create(ModelService.prototype);
    service.approvalExecutionRegistry = new ApprovalExecutionRegistry();
    service.operationAuditLog = auditLog;
    service.settings = { activeProvider: 'openai' };
    service.getActiveProviderConfig = () => ({ model: 'gpt-4o' });
    service.sessionManager = null;

    let calls = 0;
    service.toolRegistry = {
      execute: async () => {
        calls += 1;
        if (calls === 1) throw new Error('vault adapter crashed');
        return { success: true, path: 'Docs/a.md', message: 'Deleted' };
      },
    };

    const { controller, messages } = await createController({
      executeApprovedAction: (...args: any[]) => service.executeApprovedAction(...args),
      reconcileApprovedAction: (...args: any[]) => service.reconcileApprovedAction(...args),
    });

    controller.adoptMessages([approvalMessage()]);

    // 1) 工具抛错 → unknown 且不可重试。
    await controller.approveApproval('msg-1');
    expect(messages[0].approvalState.status).toBe('unknown');
    expect(messages[0].approvalState.outcome.retryable).toBe(false);
    expect(calls).toBe(1);

    // 2) 台账里只有 unknown 时，「检查结果」必须产生新信息：核实为可重试的失败。
    await controller.recheckApproval('msg-1');
    expect(messages[0].approvalState.status).toBe('failed');
    expect(messages[0].approvalState.outcome.retryable).toBe(true);
    expect(calls).toBe(1);

    // 3) 重试真的第二次调用工具，并落到成功终态（不再回弹 unknown）。
    await controller.retryApproval('msg-1');
    expect(calls).toBe(2);
    expect(messages[0].approvalState.status).toBe('succeeded');
    expect(messages[0].approvalState.outcome.detail).toBe('Deleted');

    // 4) 成功后依旧不可重放。
    await controller.retryApproval('msg-1');
    await controller.approveApproval('msg-1');
    expect(calls).toBe(2);

    controller.cleanup();
  });

  await test('execution registry caps finished successes and keeps actionable records (#76 P3)', async () => {
    const registry = new ApprovalExecutionRegistry({ maxRecords: 2 } as any);
    const succeed = async (at: number) => ({
      kind: 'approval-execution' as const,
      status: 'succeeded' as const,
      completedAt: at,
    });

    await registry.run('req-a', () => succeed(1));
    await registry.run('req-b', () => succeed(2));
    await registry.run('req-c', () => succeed(3));

    // 只淘汰最早的成功记录，最近两条仍可查到（成功不可重放）。
    expect(registry.peek('req-a')).toBeUndefined();
    expect(registry.peek('req-b') !== undefined).toBe(true);
    expect(registry.peek('req-c') !== undefined).toBe(true);

    const unknownRegistry = new ApprovalExecutionRegistry({ maxRecords: 1 } as any);
    await unknownRegistry.run('req-unknown', async () => { throw new Error('crash'); });
    await unknownRegistry.run('req-ok', () => succeed(4));
    // 未知记录仍要留给核实/重试，不能被上限淘汰。
    expect(unknownRegistry.peek('req-unknown') !== undefined).toBe(true);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
