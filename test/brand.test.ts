import { execSync } from 'child_process';
import { readFileSync } from 'fs';

function expect(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (error: any) {
    console.error(`  FAIL ${name}: ${error.message}`);
    process.exit(1);
  }
}

/**
 * 构造「旧品牌名」检测正则。
 *
 * 关键点:每个词条都必须以词尾边界(\b)收口。否则会误伤正常英文 ——
 * 比如没有 \b 时,"obsidian cli" 这个模式会命中 "Obsidian client"
 * 的前 12 个字符,让 SECURITY.md 里一句完全正常的话被判成旧品牌残留。
 *
 * 词条用字符串拼接写("obsidian" + "[- ]cli"),是为了让本文件自身
 * 不包含旧品牌名的字面量 —— 否则这个测试会检测到自己。
 */
function buildOldBrandRegex(): RegExp {
  const oldBrandTerms = [
    'obsidian' + '[- ]cli\\b',
    'obsidian' + ' shell\\b',
    '\\bo' + 'cli\\b',
  ];
  return new RegExp(oldBrandTerms.join('|'), 'i');
}

console.log('=== Brand Tests ===');

test('old-brand regex matches real leftovers but not normal English', () => {
  const oldBrand = buildOldBrandRegex();

  // 应该命中:真正的旧品牌残留
  const shouldMatch = [
    'clone https://github.com/yinfi/' + 'obsidian-cli' + '.git',
    'the ' + 'Obsidian CLI' + ' plugin',
    'run ' + 'obsidian shell' + ' to start',
  ];
  for (const line of shouldMatch) {
    expect(oldBrand.test(line), `Expected to flag legacy branding: ${line}`);
  }

  // 不应命中:正常英文,词干恰好相同
  const shouldNotMatch = [
    'Baizer runs entirely inside your Obsidian client.',
    'Baizer 完全在你的 Obsidian client 内运行。',
    'the Obsidian clipboard integration',
  ];
  for (const line of shouldNotMatch) {
    expect(!oldBrand.test(line), `False positive on normal text: ${line}`);
  }
});

test('manifest exposes Baizer identity', () => {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  expect(manifest.id === 'baizer', `Expected manifest id baizer, got ${manifest.id}`);
  expect(manifest.name === 'Baizer', `Expected manifest name Baizer, got ${manifest.name}`);
  // authorUrl 指向「作者」,不是仓库 —— Obsidian 社区目录的自动审核会对
  // 指向插件自身仓库的 authorUrl 报警告。所以这里断言它不能是仓库地址。
  expect(
    typeof manifest.authorUrl === 'string' && !manifest.authorUrl.endsWith('/baizer'),
    `authorUrl must point at the author profile, not the plugin repo; got ${manifest.authorUrl}`,
  );

  // description 不得含 "Obsidian" —— 在插件目录的语境里是冗余的,自动审核会报错。
  expect(
    typeof manifest.description === 'string' && !/obsidian/i.test(manifest.description),
    `description must not contain "Obsidian"; got ${manifest.description}`,
  );
});

test('tracked project text has no legacy branding', () => {
  const trackedFiles = execSync('git ls-files -z', { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter((path) => !path.startsWith('dist/'))
    .filter((path) => !path.startsWith('node_modules/'))
    .filter((path) => !path.startsWith('.claude/'))
    .filter((path) => !path.startsWith('.crush/'))
    .filter((path) => !path.startsWith('.omc/'))
    .filter((path) => !path.startsWith('.planning/'))
    .filter((path) => !path.startsWith('.worktrees/'))
    // FORYF.md 是开发过程记录(非面向用户的产品文本),其历史条目会提及仓库目录名
    // (客观路径,非产品旧品牌名),与 .planning/ 同属开发记录,一并豁免。
    .filter((path) => path !== 'FORYF.md')
    // 本测试文件自身必须包含旧品牌名的字面量 —— 上面那条回归测试要用它们做
    // 正例样本,否则无法验证正则真的还能抓到残留。所以扫描时豁免自己,
    // 不然这个测试会检测到自己而永远失败。
    .filter((path) => path !== 'test/brand.test.ts')
    .filter((path) => !path.endsWith('.png'));

  const oldBrand = buildOldBrandRegex();
  const matches: string[] = [];

  for (const path of trackedFiles) {
    const content = readFileSync(path, 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (oldBrand.test(line)) matches.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }

  expect(matches.length === 0, `Found old brand references:\n${matches.slice(0, 20).join('\n')}`);
});
