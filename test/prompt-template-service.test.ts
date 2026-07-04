import { PromptTemplateService } from '../src/runtime/pi/prompt-template-service';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected ${expected} but got ${actual}`);
    },
    toEqual: (expected: any) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
      }
    },
    toContain: (expected: string) => {
      if (!String(actual).includes(expected)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`);
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

/**
 * 最小 ExecutionEnv:内存文件系统,足够 pi loadPromptTemplates 遍历隐藏目录并读 .md。
 * pi 的 loadPromptTemplates 用 listDir + readTextFile + fileInfo;这里全部内存实现。
 */
function createEnvWithTemplates(dir: string, files: Record<string, string>): any {
  const ok = (v: any) => ({ ok: true, value: v });
  const er = (c: string, m: string) => ({ ok: false, error: { code: c, message: m } });
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const store = new Map<string, string>();
  for (const [name, content] of Object.entries(files)) {
    store.set(norm(`${dir}/${name}`), content);
  }
  return {
    cwd: '/',
    absolutePath: async (p: string) => ok(norm(p)),
    joinPath: async (parts: string[]) => ok(parts.map(norm).filter(Boolean).join('/')),
    readTextFile: async (p: string) => (store.has(norm(p)) ? ok(store.get(norm(p))) : er('not_found', 'nf')),
    readTextLines: async (p: string) => (store.has(norm(p)) ? ok((store.get(norm(p)) || '').split('\n')) : er('not_found', 'nf')),
    readBinaryFile: async () => er('not_found', 'nf'),
    writeFile: async () => ok(undefined),
    appendFile: async () => ok(undefined),
    fileInfo: async (p: string) => {
      const n = norm(p);
      if (n === norm(dir)) return ok({ name: n.split('/').pop(), path: n, kind: 'directory', size: 0, mtimeMs: 0 });
      if (store.has(n)) return ok({ name: n.split('/').pop(), path: n, kind: 'file', size: (store.get(n) || '').length, mtimeMs: 0 });
      return er('not_found', 'nf');
    },
    listDir: async (p: string) => {
      const base = norm(p);
      const infos: any[] = [];
      for (const key of store.keys()) {
        const parent = key.slice(0, key.lastIndexOf('/'));
        if (parent === base) {
          infos.push({ name: key.split('/').pop(), path: key, kind: 'file', size: (store.get(key) || '').length, mtimeMs: 0 });
        }
      }
      return ok(infos);
    },
    canonicalPath: async (p: string) => ok(norm(p)),
    exists: async (p: string) => ok(store.has(norm(p)) || norm(p) === norm(dir)),
    createDir: async () => ok(undefined),
    remove: async () => ok(undefined),
    createTempDir: async () => ok('/tmp'),
    createTempFile: async () => ok('/tmp/f'),
    cleanup: async () => {},
    exec: async () => er('shell_unavailable', 'no shell'),
  };
}

const DIR = '.obsidian/baizer-commands';

async function runTests() {
  console.log('=== PromptTemplateService Tests ===');

  await test('lists user commands from .md templates (name from filename)', async () => {
    const env = createEnvWithTemplates(DIR, {
      'summarize.md': '---\ndescription: Summarize the selection\n---\nSummarize: $ARGUMENTS',
      'translate.md': 'Translate to $1: $2',
    });
    const svc = new PromptTemplateService(env, DIR);
    const commands = await svc.listCommands();
    const byName = commands.slice().sort((a, b) => a.name.localeCompare(b.name));
    expect(byName.map(c => c.command)).toEqual(['/summarize', '/translate']);
    // description 取 frontmatter;缺省用通用文案。
    expect(byName[0].description).toBe('Summarize the selection');
    expect(byName[1].description).toContain('translate');
  });

  await test('resolve substitutes $ARGUMENTS with the full args string', async () => {
    const env = createEnvWithTemplates(DIR, {
      'summarize.md': 'Summarize this: $ARGUMENTS',
    });
    const svc = new PromptTemplateService(env, DIR);
    const prompt = await svc.resolve('/summarize', 'the quarterly report');
    expect(prompt).toBe('Summarize this: the quarterly report');
  });

  await test('resolve substitutes positional $1/$2 with shell-parsed args', async () => {
    const env = createEnvWithTemplates(DIR, {
      'translate.md': 'Translate to $1: "$2"',
    });
    const svc = new PromptTemplateService(env, DIR);
    const prompt = await svc.resolve('/translate', 'Chinese "hello world"');
    expect(prompt).toBe('Translate to Chinese: "hello world"');
  });

  await test('resolve returns null for unknown command', async () => {
    const env = createEnvWithTemplates(DIR, { 'summarize.md': 'x' });
    const svc = new PromptTemplateService(env, DIR);
    const prompt = await svc.resolve('/nonexistent', '');
    expect(prompt).toBe(null);
  });

  await test('has() reflects loaded templates', async () => {
    const env = createEnvWithTemplates(DIR, { 'summarize.md': 'x' });
    const svc = new PromptTemplateService(env, DIR);
    expect(await svc.has('/summarize')).toBe(true);
    expect(await svc.has('/summarize'.slice(1))).toBe(true); // 无斜杠也接受
    expect(await svc.has('/missing')).toBe(false);
  });

  await test('null env degrades gracefully to no commands', async () => {
    const svc = new PromptTemplateService(null, DIR);
    expect(await svc.listCommands()).toEqual([]);
    expect(await svc.resolve('/x', 'y')).toBe(null);
  });

  await test('listCommandsSync returns empty before load, populated after', async () => {
    const env = createEnvWithTemplates(DIR, { 'summarize.md': 'x' });
    const svc = new PromptTemplateService(env, DIR);
    expect(svc.listCommandsSync()).toEqual([]);
    await svc.load();
    expect(svc.listCommandsSync().map(c => c.command)).toEqual(['/summarize']);
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
