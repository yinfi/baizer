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

console.log('=== Brand Tests ===');

test('manifest exposes Baizer identity', () => {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  expect(manifest.id === 'baizer', `Expected manifest id baizer, got ${manifest.id}`);
  expect(manifest.name === 'Baizer', `Expected manifest name Baizer, got ${manifest.name}`);
  expect(
    typeof manifest.authorUrl === 'string' && manifest.authorUrl.endsWith('/baizer'),
    `Expected authorUrl to point at baizer, got ${manifest.authorUrl}`,
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
    .filter((path) => !path.endsWith('.png'));

  const oldBrandTerms = [
    'obsidian' + '-cli',
    'obsidian' + ' cli',
    'obsidian' + ' shell',
    'o' + 'cli',
  ];
  const oldBrand = new RegExp(oldBrandTerms.join('|'), 'i');
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
