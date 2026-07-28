import { existsSync, readFileSync, statSync } from 'fs';

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

console.log('=== Bundle Size Tests ===');

const BUNDLE = 'dist/main.js';

// Obsidian Sync 的 Standard 计划不同步超过 5MB 的文件。main.js 一旦越线,
// 付费同步用户就拿不到插件更新 —— 这是真实的用户影响,不只是过审问题。
// 留一点余量,不要顶着 5MB 上限走。
const HARD_LIMIT_BYTES = 5 * 1024 * 1024;
const BUDGET_BYTES = 4.6 * 1024 * 1024;

// dist/ 是构建产物,不入库。没构建过就跳过而不是失败,
// 否则新克隆仓库的人第一次跑 npm test 会莫名其妙地红。
const built = existsSync(BUNDLE);

if (!built) {
  console.log('  SKIP bundle checks (dist/main.js not built — run `npm run build` first)');
} else {
  test('bundle stays under the Obsidian Sync 5 MB limit', () => {
    const bytes = statSync(BUNDLE).size;
    const mb = (bytes / 1048576).toFixed(2);
    expect(
      bytes < HARD_LIMIT_BYTES,
      `dist/main.js is ${mb} MB, over the 5 MB Obsidian Sync Standard limit. ` +
        `Users on that plan will not receive updates. Check whether a new dependency ` +
        `pulled in a provider SDK — see STUBBED_PI_PROVIDERS in esbuild.config.mjs.`,
    );
  });

  test('bundle stays within the size budget', () => {
    const bytes = statSync(BUNDLE).size;
    const mb = (bytes / 1048576).toFixed(2);
    expect(
      bytes < BUDGET_BYTES,
      `dist/main.js is ${mb} MB, over the ${(BUDGET_BYTES / 1048576).toFixed(1)} MB budget. ` +
        `Still under the 5 MB hard limit, but the margin is shrinking — investigate before it bites.`,
    );
  });

  test('unused provider SDKs are not bundled', () => {
    const source = readFileSync(BUNDLE, 'utf8');

    // 匹配 esbuild 为每个被打包的模块写入的路径注释。只有真正进了 bundle 的
    // 包才会出现,所以这比搜包名可靠 —— 包名也会出现在模型 ID 字符串里
    // (例如 "mistralai/codestral-2508"),那些是数据,不是代码。
    const bundledModule = (pkg: string) =>
      source.includes(`// node_modules/${pkg}/`);

    expect(
      !bundledModule('@mistralai/mistralai'),
      '@mistralai/mistralai is in the bundle. Baizer only supports Gemini and ' +
        'OpenAI-compatible providers; the stub in esbuild.config.mjs should have ' +
        'kept this SDK out. Did the pi-ai internals change?',
    );
  });
}
