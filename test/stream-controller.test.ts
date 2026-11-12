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
  console.log('=== Stream Controller Tests ===');
  const { StreamController } = await import('../src/ui/controllers/stream-controller');

  await test('handleEvent dispatches stream events to the correct handlers in order', () => {
    const calls: string[] = [];
    const controller = new StreamController({
      onThinking: (content) => calls.push(`thinking:${content}`),
      onToolCall: (name) => calls.push(`tool_call:${name}`),
      onToolResult: (name) => calls.push(`tool_result:${name}`),
      onTextDelta: (content) => calls.push(`text:${content}`),
      onStepBoundary: () => calls.push('step'),
      onDone: () => calls.push('done'),
      onError: (message) => calls.push(`error:${message}`),
    });

    controller.handleEvent({ type: 'step_boundary' });
    controller.handleEvent({ type: 'thinking', content: 'plan' });
    controller.handleEvent({ type: 'tool_call', name: 'search_vault', args: {} });
    controller.handleEvent({ type: 'tool_result', name: 'search_vault', result: {} });
    controller.handleEvent({ type: 'text_delta', content: 'hello' });
    controller.handleEvent({ type: 'done', text: 'hello' });

    // 滚动不再由「每个事件之后」无条件触发:每个内容增长点自己捕获增长前 token,
    // 由 ScrollFollowController 校验会话身份/渲染代次后决定是否贴底。
    expect(calls).toEqual([
      'step',
      'thinking:plan',
      'tool_call:search_vault',
      'tool_result:search_vault',
      'text:hello',
      'done',
    ]);
  });

  // 论断5:done 必须把 runtime 定型后的最终文本透传给 onDone。runtime 可能在结束前
  // 替换正文(如 generation quality failure),该文本才是入库/重建所见,UI 须用它定型
  // DOM,而非逐字累计的 streamAccumulatedText,否则屏幕与保存不一致。
  await test('done forwards the final text to onDone so the DOM matches what is saved', () => {
    const received: (string | undefined)[] = [];
    const controller = new StreamController({
      onThinking: () => { },
      onToolCall: () => { },
      onToolResult: () => { },
      onTextDelta: () => { },
      onDone: (finalText) => received.push(finalText),
      onError: () => { },
    });

    controller.handleEvent({ type: 'text_delta', content: 'streamed body' });
    controller.handleEvent({ type: 'done', text: 'Generation quality check failed:\n- too short' });

    expect(received).toEqual(['Generation quality check failed:\n- too short']);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
