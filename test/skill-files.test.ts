function expectEqual(actual: unknown, expected: unknown, label: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function expect(condition: boolean, label: string) {
  if (!condition) {
    throw new Error(label);
  }
}

type ListedFiles = {
  files: string[];
  folders: string[];
};

class FakeAdapter {
  files = new Map<string, string>();
  folders = new Set<string>();
  mkdirCalls: string[] = [];

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async list(path: string): Promise<ListedFiles> {
    if (!this.folders.has(path)) {
      throw new Error(`Folder not found: ${path}`);
    }

    const prefix = path ? `${path}/` : '';
    const files: string[] = [];
    const folders: string[] = [];

    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      if (!remainder || remainder.includes('/')) continue;
      files.push(filePath);
    }

    for (const folderPath of this.folders) {
      if (folderPath === path || !folderPath.startsWith(prefix)) continue;
      const remainder = folderPath.slice(prefix.length);
      if (!remainder || remainder.includes('/')) continue;
      folders.push(folderPath);
    }

    files.sort();
    folders.sort();
    return { files, folders };
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }

  async mkdir(path: string): Promise<void> {
    this.mkdirCalls.push(path);
    this.folders.add(path);
  }
}

async function run() {
  const {
    USER_SKILLS_DIR,
    ensureDirectory,
    listSkillFilePaths,
    materializeBuiltinSkill,
    pluginSkillFileExists,
    pluginSkillFilePath,
  } = await import('../src/skills/skill-files.ts');

  {
    const adapter = new FakeAdapter();
    adapter.folders.add(USER_SKILLS_DIR);
    adapter.folders.add(`${USER_SKILLS_DIR}/plugin-a`);
    adapter.folders.add(`${USER_SKILLS_DIR}/plugin-b`);
    adapter.files.set(`${USER_SKILLS_DIR}/plugin-a/SKILL.md`, 'a');
    adapter.files.set(`${USER_SKILLS_DIR}/README.md`, 'ignore');
    adapter.files.set(`${USER_SKILLS_DIR}/SKILL.md`, 'root');

    const paths = await listSkillFilePaths(adapter, USER_SKILLS_DIR);
    expectEqual(
      paths,
      [
        `${USER_SKILLS_DIR}/SKILL.md`,
        `${USER_SKILLS_DIR}/plugin-a/SKILL.md`,
      ],
      'listSkillFilePaths should only include real SKILL.md files',
    );
  }

  {
    const adapter = new FakeAdapter();
    adapter.folders.add(USER_SKILLS_DIR);
    adapter.folders.add(`${USER_SKILLS_DIR}/plugin-a`);

    const existsWithoutFile = await pluginSkillFileExists(adapter, 'plugin-a');
    expect(!existsWithoutFile, 'plugin skill should not exist when only the directory exists');

    adapter.files.set(pluginSkillFilePath('plugin-a'), 'content');
    const existsWithFile = await pluginSkillFileExists(adapter, 'plugin-a');
    expect(existsWithFile, 'plugin skill should exist when SKILL.md exists');
  }

  {
    const adapter = new FakeAdapter();
    await ensureDirectory(adapter, `${USER_SKILLS_DIR}/plugin-a`);
    expectEqual(
      adapter.mkdirCalls,
      ['.obsidian', '.obsidian/baizer', USER_SKILLS_DIR, `${USER_SKILLS_DIR}/plugin-a`],
      'ensureDirectory should create each missing path segment once',
    );
  }

  {
    const adapter = new FakeAdapter();
    const filePath = await materializeBuiltinSkill(adapter, 'editable', 'bundle-v1');
    expectEqual(await adapter.read(filePath), 'bundle-v1', 'first materialization should write the bundle');

    await materializeBuiltinSkill(adapter, 'editable', 'bundle-v2');
    expectEqual(await adapter.read(filePath), 'bundle-v2', 'an unedited builtin should upgrade with the bundle');

    adapter.files.set(filePath, 'user-edited');
    await materializeBuiltinSkill(adapter, 'editable', 'bundle-v3');
    expectEqual(await adapter.read(filePath), 'user-edited', 'a user-edited builtin should not be overwritten');
  }

  {
    const adapter = new FakeAdapter();
    const legacyPath = `${USER_SKILLS_DIR}/legacy/SKILL.md`;
    adapter.files.set(legacyPath, 'legacy-bundle');
    const filePath = await materializeBuiltinSkill(adapter, 'legacy', 'current-bundle');
    expectEqual(filePath, legacyPath, 'legacy materialization should keep the stable path');
    expectEqual(await adapter.read(filePath), 'current-bundle', 'a markerless legacy bundle should migrate once');
  }

  {
    // .builtin-source.json 是盘上 JSON（外部输入）：被写坏时按「无 marker」处理，
    // 走既有的一次性迁移，而不是抛错或把手改内容当成 bundle 基线。
    const { BUILTIN_SKILL_SOURCE_FILE_NAME } = await import('../src/skills/skill-files.ts');
    for (const marker of ['"not-an-object"', JSON.stringify({ bundleHash: 42 })]) {
      const adapter = new FakeAdapter();
      const filePath = `${USER_SKILLS_DIR}/bad-marker/SKILL.md`;
      adapter.files.set(filePath, 'stale-bundle');
      adapter.files.set(`${USER_SKILLS_DIR}/bad-marker/${BUILTIN_SKILL_SOURCE_FILE_NAME}`, marker);

      await materializeBuiltinSkill(adapter, 'bad-marker', 'bundle-v2');

      expectEqual(
        await adapter.read(filePath),
        'bundle-v2',
        `a malformed source marker (${marker}) should fall back to legacy migration`,
      );
    }
  }

  {
    const { computeSkillBodyHash, readSkillProvenanceFromText } = await import('../src/skills/skill-files.ts');

    // source 块是标量 / 缺 plugin / 缺 body_hash：报告「无溯源」而不是抛错。
    const scalarSource = ['---', 'name: scalar', 'description: x', 'source: not-a-map', '---', 'body'].join('\n');
    const absent = readSkillProvenanceFromText(scalarSource);
    expect(absent.present === false, 'a scalar source block should report absence');
    expect(absent.provenance === null, 'a scalar source block should not yield provenance');
    expect(absent.handEdited === null, 'unknown hand-edit state stays null');

    const missingBodyHash = ['---', 'name: x', 'source:', '  plugin: demo', '---', 'body'].join('\n');
    expect(
      readSkillProvenanceFromText(missingBodyHash).present === false,
      'a source block without body_hash should report absence',
    );

    // 非字符串 version 按原实现 String() 文本化。
    const numericVersion = [
      '---',
      'name: x',
      'source:',
      '  plugin: demo',
      '  version: 2',
      `  body_hash: ${computeSkillBodyHash('body')}`,
      '---',
      'body',
    ].join('\n');
    const numeric = readSkillProvenanceFromText(numericVersion);
    expect(numeric.present === true, 'a complete source block should be read back');
    expectEqual(numeric.provenance, { plugin: 'demo', version: '2', bodyHash: computeSkillBodyHash('body') },
      'provenance should stringify the version field');
  }

  console.log('skill-files tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
