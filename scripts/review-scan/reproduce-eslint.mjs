#!/usr/bin/env node
/**
 * 本地复现 Obsidian 插件审核（community.obsidian.md Scorecard → Review）的 ESLint 扫描，
 * 输出按规则聚合的计数与位置，便于：
 *   - 把展页的 Review 分类计数映射到具体 ESLint 规则；
 *   - 在修复前后用同一口径度量 warning 数变化（而不是靠 build 成功或仓库自带 lint）。
 *
 * 口径与社区审核器保持一致（来源：obsidianmd/obsidian-workflows src/lint.ts，2026-11 时点）：
 *   eslint 9.37.0 + eslint-plugin-obsidianmd 0.4.1 + typescript-eslint 8.61.1，
 *   使用 scanner 自带 eslint 配置（type-aware），并忽略测试 / 构建脚本 / docs 等非插件源码。
 * 注意：这是“同一套规则、同一套忽略项”的本地复现，不是审核服务器的复扫结果；
 * 最终计数以社区展页复扫为准。
 *
 * 用法：
 *   node scripts/review-scan/reproduce-eslint.mjs --out review-eslint-report.json
 *   node scripts/review-scan/reproduce-eslint.mjs --deps-dir .review-scan-deps   # 复用已安装依赖
 *
 * 首次运行会通过 npm 安装固定版本的扫描依赖到系统临时目录（不会写入本仓库 package.json）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_DEPS_DIR = path.join(os.tmpdir(), 'baizer-review-scan-deps');
const DEPS_MARKER = '.scanner-versions.json';

const SCANNER_DEPS = {
    eslint: '9.37.0',
    'eslint-plugin-obsidianmd': '0.4.1',
    'typescript-eslint': '8.61.1',
};

const IGNORES = [
    'node_modules', 'dist', 'build', 'pkg', 'test-vault', '.obsidian', '**/.obsidian/**',
    'esbuild.config.mjs', 'version-bump.mjs', '**/*.test.*', '**/*.tests.*', '**/*.spec.*', '**/*.specs.*',
    '**/test/**', '**/tests/**', '**/__tests__/**', '**/mocks/**', '**/__mocks__/**',
    '**/*.cjs', '**/*.mjs', '**/*.cts', '**/*.mts', '**/vite*', '**/scripts/**', '**/docs/**',
    '**/i18n/**', '**/i18next/**', '**/locale/**', '**/locales/**', '**/translations/**', '**/l10n/**',
    '.pnpm-store', '**/*.spec.ts', '**/testUtils**', 'automation/**', 'e2e-tests/**',
];

/**
 * scanner 的 eslint 配置：obsidianmd 推荐规则（type-aware）+ 把 error 降为 warn，
 * 然后显式打开本仓库治理关注的 no-unsafe-* 五条规则（与审核器一致）。
 */
const SCANNER_CONFIG = `import { cwd } from "node:process";
import { globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

const IGNORES = ${JSON.stringify(IGNORES)};
function toWarns(config) {
  if (!config) return config;
  if (!Array.isArray(config) && typeof config[Symbol.iterator] === "function") return [...config].map(toWarns);
  if (Array.isArray(config)) return config.map(toWarns);
  const result = { ...config };
  if (result.extends) result.extends = toWarns(result.extends);
  if (result.rules) {
    result.rules = Object.fromEntries(
      Object.entries(result.rules).map(([key, value]) => {
        if (key.startsWith("eslint-comments/")) return [key, value];
        if (value === "error" || value === 2) return [key, "warn"];
        if (Array.isArray(value) && (value[0] === "error" || value[0] === 2)) return [key, ["warn", ...value.slice(1)]];
        return [key, value];
      })
    );
  }
  return result;
}

export default [
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.js", "eslint.config.mjs", "eslint.config.mts"] },
        tsconfigRootDir: cwd(),
        extraFileExtensions: [".json"],
      },
    },
  },
  ...toWarns(obsidianmd.configs.recommended),
  {
    linterOptions: { noInlineConfig: false, reportUnusedDisableDirectives: "off", reportUnusedInlineConfigs: "off" },
  },
  {
    files: ["**/*.{ts,cts,mts,tsx,js,cjs,mjs,jsx}"],
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-unsanitized/method": "error",
      "no-unsanitized/property": "error",
      "obsidianmd/regex-lookbehind": "error",
      "obsidianmd/no-forbidden-elements": "error",
      "no-undef": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "import/no-unresolved": "off",
      "obsidianmd/validate-manifest": "off",
      "obsidianmd/validate-license": "off",
      "obsidianmd/commands/no-command-in-command-id": "off",
      "obsidianmd/commands/no-plugin-id-in-command-id": "off",
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
    rules: {
      "obsidianmd/ui/sentence-case": "off",
      "obsidianmd/ui/sentence-case-json": "off",
      "obsidianmd/ui/sentence-case-locale-module": "off",
      "eslint-comments/require-description": "error",
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
    plugins: { "@typescript-eslint": tseslint.plugin, obsidianmd: obsidianmd },
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "obsidianmd/commands/no-command-in-command-id": "warn",
      "obsidianmd/commands/no-plugin-id-in-command-id": "warn",
      "obsidianmd/settings-tab/no-manual-html-headings": "error",
      "obsidianmd/settings-tab/no-problematic-settings-headings": "error",
      "obsidianmd/sample-names": "error",
      "obsidianmd/no-sample-code": "error",
      "obsidianmd/platform": "error",
      "obsidianmd/no-plugin-as-component": "error",
      "obsidianmd/detach-leaves": "error",
      "obsidianmd/no-static-styles-assignment": "error",
      "obsidianmd/no-view-references-in-plugin": "error",
      "obsidianmd/no-unsupported-api": "error",
    },
  },
  globalIgnores(IGNORES),
  { ignores: ["eslint.config.scanner.mjs", "main.js", "styles.css", "manifest.json"] },
];
`;

function parseArgs(argv) {
    const args = { out: null, depsDir: DEFAULT_DEPS_DIR, skipInstall: false, json: false };
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i];
        const next = argv[i + 1];
        if (key === '--out' && next) { args.out = next; i += 1; }
        else if (key === '--deps-dir' && next) { args.depsDir = path.resolve(next); i += 1; }
        else if (key === '--skip-install') { args.skipInstall = true; }
        else if (key === '--json') { args.json = true; }
        else if (key === '--help' || key === '-h') {
            console.log('Usage: node scripts/review-scan/reproduce-eslint.mjs [--out FILE] [--deps-dir DIR] [--skip-install] [--json]');
            process.exit(0);
        }
    }
    return args;
}

function ensureDeps(depsDir, skipInstall) {
    const markerPath = path.join(depsDir, DEPS_MARKER);
    let installed = null;
    if (fs.existsSync(markerPath)) {
        try { installed = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { installed = null; }
    }
    const matches = installed
        && Object.keys(SCANNER_DEPS).every((name) => installed[name] === SCANNER_DEPS[name]);
    if (matches) return;
    if (skipInstall) {
        throw new Error(`扫描依赖未安装或版本不匹配：${depsDir}（去掉 --skip-install 以自动安装）。`);
    }
    fs.mkdirSync(depsDir, { recursive: true });
    fs.writeFileSync(path.join(depsDir, 'package.json'), `${JSON.stringify({ name: 'baizer-review-scan-deps', private: true, type: 'module', dependencies: SCANNER_DEPS }, null, 2)}\n`);
    console.error(`Installing scanner dependencies (eslint ${SCANNER_DEPS.eslint}, eslint-plugin-obsidianmd ${SCANNER_DEPS['eslint-plugin-obsidianmd']}, typescript-eslint ${SCANNER_DEPS['typescript-eslint']}) into ${depsDir} ...`);
    // Windows 上 npm 是 .cmd，必须经 shell 启动。
    const installCommand = `npm install --prefix "${depsDir}" --no-audit --no-fund`;
    const result = spawnSync(installCommand, { stdio: 'inherit', shell: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm install failed with exit code ${result.status}`);
    fs.writeFileSync(markerPath, `${JSON.stringify(SCANNER_DEPS, null, 2)}\n`);
}

function runEslint(depsDir) {
    const configPath = path.join(depsDir, 'eslint.config.scanner.mjs');
    fs.writeFileSync(configPath, SCANNER_CONFIG);
    const eslintBin = path.join(depsDir, 'node_modules', 'eslint', 'bin', 'eslint.js');
    if (!fs.existsSync(eslintBin)) throw new Error(`找不到 eslint：${eslintBin}`);
    const env = {
        ...process.env,
        NODE_PATH: [path.join(depsDir, 'node_modules'), path.join(REPO_ROOT, 'node_modules')].join(path.delimiter),
    };
    const result = spawnSync(
        process.execPath,
        [eslintBin, '--config', configPath, '--format', 'json', '--no-error-on-unmatched-pattern', '.'],
        { cwd: REPO_ROOT, env, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
    );
    if (result.error) throw result.error;
    if (!result.stdout || result.stdout.trim() === '') {
        throw new Error(`ESLint 没有输出 JSON（exit ${result.status}）：${(result.stderr || '').slice(0, 2000)}`);
    }
    try {
        return JSON.parse(result.stdout);
    } catch (error) {
        throw new Error(`无法解析 ESLint JSON 输出：${error.message}；stderr=${(result.stderr || '').slice(0, 1000)}`);
    }
}

function aggregate(results) {
    const byRule = new Map();
    const byFileRule = new Map();
    let filesLinted = 0;
    let messages = 0;
    for (const fileResult of results) {
        const file = path.relative(REPO_ROOT, fileResult.filePath).split(path.sep).join('/');
        filesLinted += 1;
        for (const message of fileResult.messages || []) {
            messages += 1;
            const rule = message.ruleId || '(fatal)';
            byRule.set(rule, (byRule.get(rule) || 0) + 1);
            const key = `${file}\u0000${rule}`;
            byFileRule.set(key, (byFileRule.get(key) || 0) + 1);
        }
    }
    const byFile = new Map();
    for (const [key, count] of byFileRule) {
        const [file, rule] = key.split('\u0000');
        if (!byFile.has(file)) byFile.set(file, {});
        byFile.get(file)[rule] = count;
    }
    return {
        generatedAt: new Date().toISOString(),
        scanner: SCANNER_DEPS,
        repo: { commit: readGitCommit() },
        filesLinted,
        messages,
        byRule: Object.fromEntries([...byRule.entries()].sort((a, b) => b[1] - a[1])),
        byFile: Object.fromEntries([...byFile.entries()].sort()),
    };
}

function readGitCommit() {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

function printSummary(report) {
    console.log(`files linted: ${report.filesLinted}, messages: ${report.messages}, repo: ${report.repo.commit ?? 'unknown'}`);
    console.log('rule'.padEnd(64), 'count');
    for (const [rule, count] of Object.entries(report.byRule)) {
        console.log(rule.padEnd(64), String(count).padStart(5));
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    ensureDeps(args.depsDir, args.skipInstall);
    const results = runEslint(args.depsDir);
    const report = aggregate(results);
    if (args.out) {
        fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
        fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
        console.error(`wrote ${args.out}`);
    }
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printSummary(report);
}

try {
    main();
} catch (error) {
    console.error(`reproduce-eslint failed: ${error.message}`);
    process.exit(1);
}
