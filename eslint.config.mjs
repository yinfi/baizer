import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		// 不检查的目录:依赖、构建产物、测试、git worktree 副本、打包脚本产物
		ignores: [
			'node_modules/**',
			'dist/**',
			'dist_temp/**',
			'dist_test/**',
			'main.js',
			'.worktrees/**',
			'.claude/**',
			'test/**',
			'scripts/**',
			'*.config.mjs',
			'esbuild.config.mjs',
			'eslint.config.mjs',
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['**/*.ts', 'main.ts'],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
		},
		rules: {
			// TS 项目关掉这两条基础 JS 规则:类型层面的未定义/未用检查交给 TypeScript 编译器
			// 与 @typescript-eslint/* 处理,基础版会误报环境全局(NodeJS/HTMLElement 等)与类型。
			'no-undef': 'off',
			'no-unused-vars': 'off',
			// any 是已知技术债:设为 warn 让它可见、可追踪,作为开源后逐步收敛的 good-first-issue,
			// 而非一次性推平(见 CONTRIBUTING / 开源就绪范围)。
			'@typescript-eslint/no-explicit-any': 'warn',
			// 未使用变量:允许以 _ 前缀显式标记「有意忽略」,其余为 warn。
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_',
				},
			],
			// Obsidian / pi-ai 的部分类型标注较宽松,这些规则降级为 warn 以免阻断 CI。
			'@typescript-eslint/no-empty-object-type': 'warn',
			'@typescript-eslint/no-unsafe-function-type': 'warn',
			'@typescript-eslint/no-unused-expressions': 'warn',
			'@typescript-eslint/ban-ts-comment': 'warn',
			'no-empty': ['warn', { allowEmptyCatch: true }],
			'no-useless-escape': 'warn',
			'no-case-declarations': 'warn',
			'no-irregular-whitespace': 'warn',
			'prefer-const': 'warn',
		},
	},
	{
		// 截图/断言工具(tools/provider-settings-shots)不随插件发布,但与 src 一样
		// 是我们自己写的代码,所以选择「显式声明全局」而不是整块 ignores:
		// 变量名写错仍然会被 no-undef 抓到。
		// 它们有两个运行环境:主流程跑在 Node 下,另有一些函数会被序列化后送进
		// Obsidian 渲染进程求值(所以要看得到 window/document)。两套全局都声明。
		// `globals` 包只是 eslint 的传递依赖、未在本仓库声明,故不 import 它,
		// 以免 CI 的 npm ci 行为随上游 hoisting 变化。
		files: ['tools/**/*.mjs'],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
			globals: {
				process: 'readonly',
				console: 'readonly',
				Buffer: 'readonly',
				setTimeout: 'readonly',
				clearTimeout: 'readonly',
				setInterval: 'readonly',
				clearInterval: 'readonly',
				URL: 'readonly',
				AbortController: 'readonly',
				fetch: 'readonly',
				WebSocket: 'readonly',
				window: 'readonly',
				document: 'readonly',
				getComputedStyle: 'readonly',
			},
		},
		rules: {
			// 与 src/**/*.ts 保持一致:未使用变量保持可见,但不阻断 CI。
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_',
				},
			],
		},
	},
);
