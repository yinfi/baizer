// Type-aware ESLint config that mirrors the Obsidian community-plugin review
// scanner (https://community.obsidian.md/plugins/baizer#scorecard).
//
// This is NOT the config CI uses. CI runs the repo's own `eslint.config.mjs`
// (`npx eslint .`), which is deliberately non-type-aware and must stay clean.
// This config exists only so the Review scan's warning counts can be
// reproduced locally; see README.md.
//
// It is a copy of the prototype that was used to capture the pristine baseline
// (.eslint-typed.probe.mjs at the repo root). Keep the two in sync when the
// scanner's ruleset changes.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// tools/plugin-review-baseline/ -> repo root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export default tseslint.config(
	{
		ignores: [
			'node_modules/**',
			'dist/**',
			'main.js',
			'test/**',
			'scripts/**',
			'tools/**',
			'*.config.mjs',
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	{
		files: ['**/*.ts'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: repoRoot,
			},
		},
		rules: {
			'no-undef': 'off',
			'no-unused-vars': 'off',
			'@typescript-eslint/no-explicit-any': 'warn',
			'@typescript-eslint/no-unsafe-member-access': 'warn',
			'@typescript-eslint/no-unsafe-assignment': 'warn',
			'@typescript-eslint/no-unsafe-call': 'warn',
			'@typescript-eslint/no-unsafe-argument': 'warn',
			'@typescript-eslint/no-unsafe-return': 'warn',
			'@typescript-eslint/no-unnecessary-type-assertion': 'warn',
			'@typescript-eslint/no-misused-promises': 'warn',
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_',
				},
			],
			'no-empty': ['warn', { allowEmptyCatch: true }],
		},
	},
);
