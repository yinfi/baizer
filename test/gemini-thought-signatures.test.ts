function expectEqual(actual: unknown, expected: unknown, label: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
}

async function run() {
  const {
    mergeStreamThoughtSignatures,
  } = await import('../src/models/gemini-thought-signatures.ts');

  {
    const aggregatedParts = [
      {
        functionCall: {
          name: 'default_api:search_vault',
          args: { query: '复盘' },
        },
      },
    ];
    const streamedParts = [
      {
        functionCall: {
          name: 'default_api:search_vault',
          args: { query: '复盘' },
        },
        thoughtSignature: 'sig-1',
      },
    ];

    expectEqual(
      mergeStreamThoughtSignatures(aggregatedParts, streamedParts),
      [
        {
          functionCall: {
            name: 'default_api:search_vault',
            args: { query: '复盘' },
          },
          thoughtSignature: 'sig-1',
        },
      ],
      'should restore thoughtSignature onto aggregated functionCall parts',
    );
  }

  {
    const aggregatedParts = [
      {
        functionCall: {
          name: 'get_weather',
          args: { location: 'Paris' },
        },
      },
      {
        functionCall: {
          name: 'get_weather',
          args: { location: 'London' },
        },
      },
    ];
    const streamedParts = [
      {
        functionCall: {
          name: 'get_weather',
          args: { location: 'Paris' },
        },
        thoughtSignature: 'sig-a',
      },
      {
        functionCall: {
          name: 'get_weather',
          args: { location: 'London' },
        },
      },
    ];

    expectEqual(
      mergeStreamThoughtSignatures(aggregatedParts, streamedParts),
      [
        {
          functionCall: {
            name: 'get_weather',
            args: { location: 'Paris' },
          },
          thoughtSignature: 'sig-a',
        },
        {
          functionCall: {
            name: 'get_weather',
            args: { location: 'London' },
          },
        },
      ],
      'should only attach signatures to the matching streamed functionCall positions',
    );
  }

  console.log('gemini thought signature tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
