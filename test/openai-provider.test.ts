function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected)) {
        throw new Error(`Expected "${actual}" to contain "${expected}"`);
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

function streamResponse(lines: string[]) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${line}\n\n`));
        }
        controller.close();
      },
    }),
  };
}

async function collect(stream: AsyncGenerator<any, void, unknown>) {
  const events: any[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function runTests() {
  console.log('=== OpenAI Provider Tests ===');
  const { OpenAIProvider } = await import('../src/models/openai');

  await test('streaming tool results reuse the provider tool call id in follow-up messages', async () => {
    const originalFetch = (globalThis as any).fetch;
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        return streamResponse([
          'data: {"choices":[{"delta":{"content":"Reading note."}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_real_123","type":"function","function":{"name":"read_note","arguments":"{\\"path\\":"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"current.md\\"}"}}]}}]}',
          'data: [DONE]',
        ]);
      }
      return streamResponse([
        'data: {"choices":[{"delta":{"content":"Done."}}]}',
        'data: [DONE]',
      ]);
    };

    try {
      const provider = new OpenAIProvider();
      provider.configure({
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.test/v1',
        modelName: 'gpt-test',
      });
      const chat = provider.startChat([
        { name: 'read_note', description: 'Read note', parameters: {} },
      ]);

      await collect(chat.sendMessageStream('read the note'));
      await collect(chat.sendMessageStream([
        { name: 'read_note', response: { content: '# Current' } },
      ]));

      const messages = bodies[1].messages;
      const assistantMessage = messages.find((message: any) => message.role === 'assistant');
      const toolMessage = messages.find((message: any) => message.role === 'tool');

      expect(assistantMessage.tool_calls[0].id).toBe('call_real_123');
      expect(toolMessage.tool_call_id).toBe('call_real_123');
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  await test('streamed reasoning content is sent back on the next user turn', async () => {
    const originalFetch = (globalThis as any).fetch;
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        return streamResponse([
          'data: {"choices":[{"delta":{"reasoning_content":"step-1 "}}]}',
          'data: {"choices":[{"delta":{"reasoning_content":"step-2"}}]}',
          'data: {"choices":[{"delta":{"content":"Hello"}}]}',
          'data: [DONE]',
        ]);
      }
      return streamResponse([
        'data: {"choices":[{"delta":{"content":"Done."}}]}',
        'data: [DONE]',
      ]);
    };

    try {
      const provider = new OpenAIProvider();
      provider.configure({
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.test/v1',
        modelName: 'gpt-test',
      });
      const chat = provider.startChat();

      await collect(chat.sendMessageStream('hello'));
      await collect(chat.sendMessageStream('continue'));

      const secondMessages = bodies[1].messages;
      const assistantMessage = secondMessages.find((message: any) => message.role === 'assistant');

      expect(assistantMessage.content).toBe('Hello');
      expect(assistantMessage.reasoning_content).toBe('step-1 step-2');
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  await test('streamed reasoning content is preserved for tool result follow-up messages', async () => {
    const originalFetch = (globalThis as any).fetch;
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        return streamResponse([
          'data: {"choices":[{"delta":{"reasoning_content":"need-note"}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_reasoned_123","type":"function","function":{"name":"read_note","arguments":"{\\"path\\":"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"current.md\\"}"}}]}}]}',
          'data: [DONE]',
        ]);
      }
      return streamResponse([
        'data: {"choices":[{"delta":{"content":"Done."}}]}',
        'data: [DONE]',
      ]);
    };

    try {
      const provider = new OpenAIProvider();
      provider.configure({
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.test/v1',
        modelName: 'gpt-test',
      });
      const chat = provider.startChat([
        { name: 'read_note', description: 'Read note', parameters: {} },
      ]);

      await collect(chat.sendMessageStream('read the note'));
      await collect(chat.sendMessageStream([
        { name: 'read_note', response: { content: '# Current' } },
      ]));

      const secondMessages = bodies[1].messages;
      const assistantMessage = secondMessages.find((message: any) => message.role === 'assistant');
      const toolMessage = secondMessages.find((message: any) => message.role === 'tool');

      expect(assistantMessage.reasoning_content).toBe('need-note');
      expect(assistantMessage.tool_calls[0].id).toBe('call_reasoned_123');
      expect(toolMessage.tool_call_id).toBe('call_reasoned_123');
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  await test('streaming errors include the response body so 400s are diagnosable', async () => {
    const originalFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"messages with tool_calls require matching tool responses"}}',
    });

    try {
      const provider = new OpenAIProvider();
      provider.configure({
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.test/v1',
        modelName: 'gpt-test',
      });
      const chat = provider.startChat();

      let errorMessage = '';
      try {
        await collect(chat.sendMessageStream('hello'));
      } catch (error: any) {
        errorMessage = error.message;
      }

      expect(errorMessage).toContain('OpenAI API Error: 400');
      expect(errorMessage).toContain('matching tool responses');
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  await test('a new user turn drops unresolved streamed tool calls from a prior approval stop', async () => {
    const originalFetch = (globalThis as any).fetch;
    const bodies: any[] = [];
    (globalThis as any).fetch = async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        return streamResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_pending_approval","type":"function","function":{"name":"update_note","arguments":"{\\"path\\":\\"current.md\\",\\"content\\":\\"new\\"}"}}]}}]}',
          'data: [DONE]',
        ]);
      }
      return streamResponse([
        'data: {"choices":[{"delta":{"content":"Continuing."}}]}',
        'data: [DONE]',
      ]);
    };

    try {
      const provider = new OpenAIProvider();
      provider.configure({
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.test/v1',
        modelName: 'gpt-test',
      });
      const chat = provider.startChat([
        { name: 'update_note', description: 'Update note', parameters: {} },
      ]);

      await collect(chat.sendMessageStream('optimize note'));
      await collect(chat.sendMessageStream('continue'));

      const secondMessages = bodies[1].messages;
      const unresolvedToolCall = secondMessages.find((message: any) => (
        message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_pending_approval'
      ));

      expect(unresolvedToolCall).toBe(undefined);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
