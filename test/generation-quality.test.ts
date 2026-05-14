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
  console.log('=== Generation Quality Tests ===');
  const {
    evaluateGenerationQuality,
  } = await import('../src/services/generation-quality');

  await test('rejects rewrite output that only trims or echoes the original text', () => {
    const result = evaluateGenerationQuality({
      originalText: 'This is the original sentence.',
      generatedText: 'This is the original sentence.',
      plan: {
        source: 'selection-menu',
        mode: 'rewrite',
        targetShape: 'replacement',
        previewRequired: true,
        mustPreserveVoice: true,
        mustUseObsidianMarkdown: true,
        qualityChecklist: [],
      },
    });

    expect(result).toEqual({
      ok: false,
      reasons: ['Generated text is too close to the original text.'],
    });
  });

  await test('rejects structure outputs that do not produce outline-shaped markdown', () => {
    const result = evaluateGenerationQuality({
      generatedText: 'Just a flat paragraph with no structure at all.',
      plan: {
        source: 'shell',
        mode: 'structure',
        targetShape: 'outline',
        previewRequired: false,
        mustPreserveVoice: true,
        mustUseObsidianMarkdown: true,
        qualityChecklist: [],
      },
    });

    expect(result).toEqual({
      ok: false,
      reasons: ['Expected outline-shaped markdown with headings or bullet groups.'],
    });
  });

  await test('accepts rewrite and outline outputs that match the requested shape', () => {
    const rewriteResult = evaluateGenerationQuality({
      originalText: 'Bad sentence.',
      generatedText: 'A clearer sentence with the same intent.',
      plan: {
        source: 'selection-menu',
        mode: 'rewrite',
        targetShape: 'replacement',
        previewRequired: true,
        mustPreserveVoice: true,
        mustUseObsidianMarkdown: true,
        qualityChecklist: [],
      },
    });

    const outlineResult = evaluateGenerationQuality({
      generatedText: '## Summary\n- Key point one\n- Key point two',
      plan: {
        source: 'shell',
        mode: 'structure',
        targetShape: 'outline',
        previewRequired: false,
        mustPreserveVoice: true,
        mustUseObsidianMarkdown: true,
        qualityChecklist: [],
      },
    });

    expect(rewriteResult).toEqual({ ok: true, reasons: [] });
    expect(outlineResult).toEqual({ ok: true, reasons: [] });
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
