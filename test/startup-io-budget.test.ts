// 启动阻塞路径的 IO 预算。
//
// 背景：插件启动慢（桌面与移动端都慢）的根因不是数据量，而是 onload 里串行做了
// 只有「用户真正发起一次对话」才需要的文件 IO：7 个内置 skill 逐个物化写盘，
// 紧接着又把刚写的目录重扫一遍读回来（全部按同名丢弃）。移动端每次 adapter IO
// 要过 native 桥（实测 5-30ms），于是固定 54 次串行 IO 被放大成秒级白屏。
//
// 这个测试把「阻塞路径上允许发生多少次 IO」变成可回归的硬约束。
// IO 次数与 vault 大小无关，所以它是稳定的、不 flaky 的判据。

type ListedFiles = { files: string[]; folders: string[] };

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

function expect(condition: boolean, label: string) {
  if (!condition) throw new Error(label);
}

/** 记账型 adapter：既模拟已存在的文件系统，也统计每类 IO 的次数。 */
class CountingAdapter {
  files = new Map<string, string>();
  folders = new Set<string>();
  counts = { read: 0, write: 0, exists: 0, list: 0, mkdir: 0 };

  get total(): number {
    return Object.values(this.counts).reduce((a, b) => a + b, 0);
  }

  reset() {
    this.counts = { read: 0, write: 0, exists: 0, list: 0, mkdir: 0 };
  }

  async exists(path: string): Promise<boolean> {
    this.counts.exists++;
    return this.files.has(path) || this.folders.has(path);
  }

  async list(path: string): Promise<ListedFiles> {
    this.counts.list++;
    const prefix = path ? `${path}/` : '';
    const files: string[] = [];
    const folders: string[] = [];
    for (const p of this.files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      files.push(p);
    }
    for (const p of this.folders) {
      if (p === path || !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      folders.push(p);
    }
    return { files: files.sort(), folders: folders.sort() };
  }

  async read(path: string): Promise<string> {
    this.counts.read++;
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }

  async write(path: string, data: string): Promise<void> {
    this.counts.write++;
    this.files.set(path, data);
  }

  async mkdir(path: string): Promise<void> {
    this.counts.mkdir++;
    this.folders.add(path);
  }
}

const BUILTIN_NAMES = [
  'web-search', 'web-clipper', 'obsidian-markdown',
  'json-canvas', 'obsidian-bases', 'plugin-ctrl', 'knowledge',
];

function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} does things\n---\n\nInstructions for ${name}.\n`;
}

async function run() {
  const {
    USER_SKILLS_DIR,
    ensureDirectory,
    listSkillFilePaths,
    builtinSkillFilePath,
    materializeBuiltinSkill,
  } = await import('../src/skills/skill-files.ts');

  // ---- ensureDirectory：已存在的目录不该反复付 IO ----
  {
    const adapter = new CountingAdapter();
    await ensureDirectory(adapter, `${USER_SKILLS_DIR}/a`);
    const firstCall = adapter.total;
    expect(firstCall > 0, 'ensureDirectory should do some IO when creating a new tree');

    // 全存在时只该付 1 次 exists（探到最深一层就返回），而不是逐层 4 次。
    // 不用记忆化：缓存会在用户手删目录后失效，而 1 次 IO 已经足够便宜。
    adapter.reset();
    await ensureDirectory(adapter, `${USER_SKILLS_DIR}/a`);
    expectEqual(
      adapter.total,
      1,
      'ensureDirectory on an existing path must cost exactly 1 exists (deepest-first probe). '
        + '逐层自浅向深是 7 个内置 skill × 4 层 = 28 次 exists 的来源',
    );

    // 新建兄弟目录的最优成本：exists(自身)=false + exists(父)=true + mkdir(自身) = 3 次。
    adapter.reset();
    await ensureDirectory(adapter, `${USER_SKILLS_DIR}/b`);
    expect(
      adapter.total <= 3,
      `creating a sibling dir under a known parent should cost <=3 IO, got ${adapter.total}`,
    );
  }

  // ---- materializeBuiltinSkill：内容未变时不该重复写盘 ----
  {
    const adapter = new CountingAdapter();
    const md = skillMd('web-search');

    const path = await materializeBuiltinSkill(adapter, 'web-search', md);
    expectEqual(path, builtinSkillFilePath('web-search'), 'materialize should return the deterministic path');
    expectEqual(adapter.files.get(path), md, 'materialize should write the bundled content');

    adapter.reset();
    await materializeBuiltinSkill(adapter, 'web-search', md);
    expectEqual(
      adapter.counts.write,
      0,
      'materializing unchanged content must not write again — 每次启动重写 7 个文件是纯浪费',
    );

    adapter.reset();
    await materializeBuiltinSkill(adapter, 'web-search', skillMd('web-search') + '\nchanged');
    expectEqual(
      adapter.counts.write,
      2,
      'materializing changed content must write SKILL.md + .builtin-source.json '
        + '(marker 是"用户手改不覆盖"的判据，必须与正文同步更新)',
    );
  }

  // ---- listSkillFilePaths：已知内置目录不该被回读 ----
  {
    const adapter = new CountingAdapter();
    adapter.folders.add(USER_SKILLS_DIR);
    for (const name of BUILTIN_NAMES) {
      adapter.folders.add(`${USER_SKILLS_DIR}/${name}`);
      adapter.files.set(`${USER_SKILLS_DIR}/${name}/SKILL.md`, skillMd(name));
    }
    adapter.folders.add(`${USER_SKILLS_DIR}/my-own`);
    adapter.files.set(`${USER_SKILLS_DIR}/my-own/SKILL.md`, skillMd('my-own'));

    const paths = await listSkillFilePaths(adapter, USER_SKILLS_DIR, BUILTIN_NAMES);
    expectEqual(
      paths,
      [`${USER_SKILLS_DIR}/my-own/SKILL.md`],
      'listSkillFilePaths should skip known builtin dirs — 回读它们只会得到 7 个同名丢弃项',
    );
  }

  // ---- 未传 skip 列表时保持旧行为（向后兼容） ----
  {
    const adapter = new CountingAdapter();
    adapter.folders.add(USER_SKILLS_DIR);
    adapter.folders.add(`${USER_SKILLS_DIR}/plugin-a`);
    adapter.files.set(`${USER_SKILLS_DIR}/plugin-a/SKILL.md`, 'a');

    const paths = await listSkillFilePaths(adapter, USER_SKILLS_DIR);
    expectEqual(
      paths,
      [`${USER_SKILLS_DIR}/plugin-a/SKILL.md`],
      'listSkillFilePaths without a skip list keeps its original behaviour',
    );
  }

  console.log('startup-io-budget tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
