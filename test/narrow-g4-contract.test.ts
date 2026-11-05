import assert from 'node:assert/strict';

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: unknown) {
    console.error(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('=== narrow-g4 (video / skill sources / write contract) Tests ===');
  const contract = await import('../src/utils/file-operation-contract');
  const { parseTranscriptionPayload, decodeWithWebAudio } = await import('../src/services/video-transcription');
  const { parseBuiltinSkill } = await import('../src/skills/pi-skill-source');
  const { readSkillProvenanceFromText, computeSkillBodyHash } = await import('../src/skills/skill-files');
  const { createVideoTranscriptFetcher, extractJsonAssignment } = await import('../src/utils/video_utils');

  // ---- file-operation-contract: result 是外部工具返回值,可能是任意形状 ----
  await test('write-result helpers tolerate non-object results', () => {
    for (const bad of [undefined, null, 'ok', 42, true]) {
      assert.equal(contract.isSuccessfulWriteToolResult(bad), false);
      assert.equal(contract.getFileWriteError(bad), '');
      assert.equal(contract.getFileWriteResultPath('create_file', bad, {}), '');
    }
  });

  await test('getFileWriteError keeps error/message precedence and trimming', () => {
    assert.equal(contract.getFileWriteError({ error: '  boom  ' }), 'boom');
    assert.equal(contract.getFileWriteError({ error: '   ', message: 'm', success: false }), 'm');
    assert.equal(contract.getFileWriteError({ message: ' fail ', status: 'error' }), 'fail');
    assert.equal(contract.getFileWriteError({ message: 'info' }), '');
    assert.equal(contract.getFileWriteError({ error: 5, message: 'x', success: false }), 'x');
  });

  await test('getFileWriteResultPath ignores non-string values and keeps fallback order', () => {
    assert.equal(contract.getFileWriteResultPath('x', { path: 'a', target: 'b' }, { path: 'c' }), 'a');
    assert.equal(contract.getFileWriteResultPath('x', { path: 1, target: 'b' }, { path: 'c' }), 'b');
    assert.equal(contract.getFileWriteResultPath('create_note', {}, { filename: 'f.md', path: 'p' }), 'f.md');
    assert.equal(contract.getFileWriteResultPath('create_note', {}, { filename: 3, path: 'p' }), 'p');
    assert.equal(contract.getFileWriteResultPath('rename_note', {}, { newPath: 'n', path: 'p' }), 'n');
    assert.equal(contract.getFileWriteResultPath('update_note', {}, { newPath: 'n' }), '');
  });

  // ---- parseTranscriptionPayload: 转写端点响应是外部输入 ----
  const win = { startSec: 10, endSec: 20 };

  await test('parseTranscriptionPayload offsets segment times and trims text', () => {
    const parsed = parseTranscriptionPayload(
      { text: ' full ', segments: [{ start: 1, end: 2, text: ' hi ' }, { start: 3, end: 4, text: '   ' }] },
      win,
    );
    assert.deepEqual(parsed.segments, [{ start: 11, end: 12, text: 'hi' }]);
    assert.equal(parsed.text, 'full');
  });

  await test('parseTranscriptionPayload falls back to window bounds for bad timestamps', () => {
    const parsed = parseTranscriptionPayload({ segments: [{ start: 'x', end: undefined, text: 'a' }, null, 7] }, win);
    assert.deepEqual(parsed.segments, [{ start: 10, end: 20, text: 'a' }]);
    assert.equal(parsed.text, 'a');
  });

  await test('parseTranscriptionPayload turns flat text into one window-wide segment', () => {
    const parsed = parseTranscriptionPayload({ text: 'only text', segments: 'nope' }, win);
    assert.deepEqual(parsed.segments, [{ start: 10, end: 20, text: 'only text' }]);
  });

  await test('parseTranscriptionPayload returns empty result for non-object payloads', () => {
    for (const bad of [undefined, null, 'str', 5, [], { text: 5 }]) {
      const parsed = parseTranscriptionPayload(bad, win);
      assert.equal(parsed.text, '');
      assert.deepEqual(parsed.segments, []);
    }
  });

  await test('decodeWithWebAudio rejects when OfflineAudioContext is unavailable', async () => {
    const g = globalThis as Record<string, unknown>;
    const saved = [g.OfflineAudioContext, g.webkitOfflineAudioContext];
    delete g.OfflineAudioContext;
    delete g.webkitOfflineAudioContext;
    try {
      await assert.rejects(
        () => decodeWithWebAudio(new ArrayBuffer(4)),
        /Web Audio \(OfflineAudioContext\) is unavailable in this environment/,
      );
    } finally {
      if (saved[0] !== undefined) g.OfflineAudioContext = saved[0];
      if (saved[1] !== undefined) g.webkitOfflineAudioContext = saved[1];
    }
  });

  await test('decodeWithWebAudio validates decoded buffers', async () => {
    const g = globalThis as Record<string, unknown>;
    const saved = g.OfflineAudioContext;
    const make = (decoded: unknown) => class {
      decodeAudioData(_b: ArrayBuffer, ok: (d: unknown) => void) {
        ok(decoded);
        return undefined;
      }
    };
    try {
      g.OfflineAudioContext = make({ length: 0, getChannelData: () => new Float32Array(0) });
      await assert.rejects(() => decodeWithWebAudio(new ArrayBuffer(4)), /Decoded audio contains no samples/);
      g.OfflineAudioContext = make({ length: 5 });
      await assert.rejects(() => decodeWithWebAudio(new ArrayBuffer(4)), /Decoded audio contains no samples/);
      const good = { length: 5, sampleRate: 16000, channelCount: 1, getChannelData: () => new Float32Array(5) };
      g.OfflineAudioContext = make(good);
      assert.equal(await decodeWithWebAudio(new ArrayBuffer(4)), good);
    } finally {
      if (saved === undefined) delete g.OfflineAudioContext;
      else g.OfflineAudioContext = saved;
    }
  });

  // ---- pi-skill-source: SKILL.md frontmatter 是磁盘输入 ----
  await test('parseBuiltinSkill narrows frontmatter fields', () => {
    const md = [
      '---',
      'name: demo-skill',
      'description: A demo',
      'mode: simple',
      'disable-model-invocation: true',
      'tools: [read_note, 5, create_note]',
      'triggers:',
      '  commands: ["/demo", 3]',
      '  keywords: [alpha, null]',
      '---',
      'Body text',
    ].join('\n');
    const loaded = parseBuiltinSkill(md, 'x/SKILL.md');
    assert.ok(loaded);
    assert.equal(loaded.skill.name, 'demo-skill');
    assert.equal(loaded.skill.disableModelInvocation, true);
    assert.equal(loaded.skill.content, 'Body text');
    assert.equal(loaded.sidecar.executionMode, 'direct');
    assert.deepEqual(loaded.sidecar.tools, ['read_note', 'create_note']);
    assert.deepEqual(loaded.sidecar.triggers, { commands: ['/demo'], keywords: ['alpha'] });
  });

  await test('parseBuiltinSkill rejects non-mapping or incomplete frontmatter', () => {
    assert.equal(parseBuiltinSkill('---\njust a string\n---\nbody', 'p'), null);
    assert.equal(parseBuiltinSkill('---\nname: 5\ndescription: d\n---\nbody', 'p'), null);
    assert.equal(parseBuiltinSkill('---\nname: Bad Name\ndescription: d\n---\nbody', 'p'), null);
    assert.equal(parseBuiltinSkill('no frontmatter', 'p'), null);
    const minimal = parseBuiltinSkill('---\nname: a\ndescription: d\ntools: nope\ntriggers: 5\n---\nb', 'p');
    assert.ok(minimal);
    assert.deepEqual(minimal.sidecar.tools, []);
    assert.equal(minimal.sidecar.triggers, undefined);
    assert.equal(minimal.sidecar.executionMode, 'instructions');
  });

  // ---- skill-files: provenance 解析 ----
  await test('readSkillProvenanceFromText narrows the source block', () => {
    const body = 'hello body';
    const hash = computeSkillBodyHash(body);
    const ok = readSkillProvenanceFromText(
      `---\nname: n\nsource:\n  plugin: dataview\n  version: 1.2\n  body_hash: ${hash}\n---\n${body}`,
    );
    assert.equal(ok.present, true);
    assert.deepEqual(ok.provenance, { plugin: 'dataview', version: '1.2', bodyHash: hash });
    assert.equal(ok.handEdited, false);

    const edited = readSkillProvenanceFromText(
      `---\nsource:\n  plugin: p\n  body_hash: ${hash}\n---\nother`,
    );
    assert.equal(edited.handEdited, true);
    assert.equal(edited.provenance?.version, '');

    for (const raw of [
      '---\nsource: text\n---\nb',
      '---\nsource:\n  plugin: 5\n  body_hash: h\n---\nb',
      '---\nsource:\n  plugin: p\n---\nb',
      '---\njust text\n---\nb',
      'no frontmatter',
    ]) {
      const r = readSkillProvenanceFromText(raw);
      assert.equal(r.present, false);
      assert.equal(r.provenance, null);
      assert.equal(r.handEdited, null);
    }
  });

  // ---- video_utils: 页面内嵌 JSON / 字幕 JSON 是网络输入 ----
  await test('extractJsonAssignment returns parsed JSON or null', () => {
    assert.deepEqual(extractJsonAssignment('var a = {"x":{"y":1}};', 'var a = '), { x: { y: 1 } });
    assert.equal(extractJsonAssignment('var a = {bad};', 'var a = '), null);
    assert.equal(extractJsonAssignment('nothing', 'var a = '), null);
  });

  await test('YouTube json3 captions tolerate malformed events', async () => {
    const html = '<title>T - YouTube</title>"captionTracks":[{"languageCode":"en","baseUrl":"https://cap.test/x?a=1"}]';
    const fetcher = createVideoTranscriptFetcher({
      requestUrl: (async (options: { url: string }) => {
        if (options.url === 'https://www.youtube.com/watch?v=abc') {
          return { status: 200, text: html, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {} };
        }
        if (options.url.endsWith('&fmt=json3')) {
          const events = [{ segs: [{ utf8: 'Hello ' }, { utf8: 'world' }, {}] }, { segs: 'x' }, { t: 1 }, null, { segs: [{ utf8: 'again' }] }];
          return { status: 200, text: JSON.stringify({ events }), headers: {}, arrayBuffer: new ArrayBuffer(0), json: {} };
        }
        return { status: 200, text: '', headers: {}, arrayBuffer: new ArrayBuffer(0), json: {} };
      }) as never,
    });
    const result = await fetcher('https://www.youtube.com/watch?v=abc');
    assert.ok(result);
    assert.equal(result.transcriptSource, 'platform-subtitle');
    // 缺 utf8 的 seg 在 join 时按 undefined -> '' 处理;非数组 segs 贡献空串并被过滤。
    assert.equal(result.text, 'Hello world again');
  });

  await test('Bilibili subtitle fetch tolerates missing/odd subtitle JSON', async () => {
    const html = '<title>B_哔哩哔哩_bilibili</title>"cid":123,"bvid":"BV1abc"';
    const make = (playerJson: unknown, subtitleJson?: unknown) => createVideoTranscriptFetcher({
      requestUrl: (async (options: { url: string }) => {
        const base = { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: {} };
        if (options.url.includes('api.bilibili.com')) return { ...base, text: JSON.stringify(playerJson) };
        if (options.url.startsWith('https://sub.test')) return { ...base, text: JSON.stringify(subtitleJson) };
        return { ...base, text: html };
      }) as never,
    });
    const url = 'https://www.bilibili.com/video/BV1abc';

    const noSub = await make({ data: null })(url);
    assert.equal(noSub?.needsTranscription, true);

    const withSub = await make(
      { data: { subtitle: { subtitles: [{ lan: 'x' }, { url: '//sub.test/a.json' }] } } },
      { body: [{ content: 'one' }, { content: 'two' }] },
    )(url);
    assert.equal(withSub?.transcriptSource, 'platform-subtitle');
    assert.equal(withSub?.text, 'one two');

    const badBody = await make(
      { data: { subtitle: { subtitles: [{ url: 'https://sub.test/a.json' }] } } },
      { body: 'not-an-array' },
    )(url);
    assert.equal(badBody?.needsTranscription, true);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
