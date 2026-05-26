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

  console.log('skill-files tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
