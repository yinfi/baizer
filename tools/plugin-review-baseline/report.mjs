// Reproducible typed-lint report for the Obsidian community-plugin Review scan.
//
//   node tools/plugin-review-baseline/report.mjs
//       Runs ESLint (type-aware, see eslint.review.config.mjs) over main.ts and
//       src/, aggregates problems per rule and per rule+file, and writes
//       metrics/lint-review.json + metrics/lint-review.md.
//
//   node tools/plugin-review-baseline/report.mjs --from <eslint-json> [--name X]
//       Aggregates an already-captured ESLint JSON formatter output instead of
//       running ESLint. Used to freeze the pristine pre-fix baseline so that
//       concurrent edits in src/ cannot pollute the "before" numbers.
//
// Output is deterministic: same input -> byte-identical report (no timestamps).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const configPath = path.join(here, 'eslint.review.config.mjs');
const targets = ['main.ts', 'src'];

function parseArgs(argv) {
	const out = { from: null, name: 'lint-review', outDir: path.join(here, 'metrics') };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--from') out.from = argv[++i];
		else if (a === '--name') out.name = argv[++i];
		else if (a === '--out') out.outDir = path.resolve(repoRoot, argv[++i]);
		else if (a === '--help' || a === '-h') out.help = true;
		else throw new Error('unknown argument: ' + a);
	}
	return out;
}

function rel(p) {
	const r = path.relative(repoRoot, p).split(path.sep).join('/');
	return r === '' ? '.' : r;
}

function sha256(file) {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function aggregate(rawResults) {
	const rules = new Map();
	const ruleFiles = new Map();
	const files = new Map();
	let errors = 0;
	let warnings = 0;

	for (const r of rawResults) {
		const file = rel(r.filePath);
		const messages = Array.isArray(r.messages) ? r.messages : [];
		if (messages.length > 0) files.set(file, messages.length);
		for (const m of messages) {
			if (m.severity === 2) errors++;
			else warnings++;
			const ruleId = m.ruleId === null || m.ruleId === undefined ? '(no-rule)' : m.ruleId;
			const bucket = rules.get(ruleId) ?? { ruleId, count: 0, errors: 0, warnings: 0 };
			bucket.count++;
			if (m.severity === 2) bucket.errors++;
			else bucket.warnings++;
			rules.set(ruleId, bucket);
			const k = ruleId + '\t' + file;
			ruleFiles.set(k, (ruleFiles.get(k) ?? 0) + 1);
		}
	}

	const byRule = [...rules.values()].sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));
	const byRuleFile = [...ruleFiles.entries()]
		.map(([k, count]) => {
			const [ruleId, file] = k.split('\t');
			return { ruleId, file, count };
		})
		.sort((a, b) => a.ruleId.localeCompare(b.ruleId) || b.count - a.count || a.file.localeCompare(b.file));
	const byFile = [...files.entries()]
		.map(([file, problems]) => ({ file, problems }))
		.sort((a, b) => b.problems - a.problems || a.file.localeCompare(b.file));

	return {
		totals: {
			filesLinted: rawResults.length,
			filesWithProblems: byFile.length,
			errors,
			warnings,
			problems: errors + warnings,
		},
		rules: byRule,
		ruleFiles: byRuleFile,
		files: byFile,
	};
}

function renderMarkdown(report) {
	const lines = [];
	lines.push('# Typed-lint report (Obsidian Review scan reproduction)');
	lines.push('');
	lines.push('- Config: `' + report.config + '`');
	lines.push('- Source: ' + report.source.describe);
	if (report.source.sha256) lines.push('- Source SHA-256: `' + report.source.sha256 + '`');
	lines.push('- Targets: ' + report.targets.map((t) => '`' + t + '`').join(', '));
	lines.push('- ESLint: `' + report.eslintVersion + '`');
	lines.push('');
	lines.push('## Totals');
	lines.push('');
	lines.push('| metric | value |');
	lines.push('| --- | --- |');
	lines.push('| files linted | ' + report.totals.filesLinted + ' |');
	lines.push('| files with problems | ' + report.totals.filesWithProblems + ' |');
	lines.push('| errors | ' + report.totals.errors + ' |');
	lines.push('| warnings | ' + report.totals.warnings + ' |');
	lines.push('| **problems** | **' + report.totals.problems + '** |');
	lines.push('');
	lines.push('## Problems per rule');
	lines.push('');
	lines.push('| count | rule |');
	lines.push('| ---: | --- |');
	for (const r of report.rules) lines.push('| ' + r.count + ' | `' + r.ruleId + '` |');
	lines.push('');
	const top = report.rules[0];
	if (top) {
		const perFile = report.ruleFiles.filter((x) => x.ruleId === top.ruleId);
		lines.push('## Per-file distribution of `' + top.ruleId + '` (' + top.count + ' problems, ' + perFile.length + ' files)');
		lines.push('');
		lines.push('| count | file |');
		lines.push('| ---: | --- |');
		for (const x of perFile) lines.push('| ' + x.count + ' | `' + x.file + '` |');
		lines.push('');
	}
	lines.push('## All files with problems');
	lines.push('');
	lines.push('| problems | file |');
	lines.push('| ---: | --- |');
	for (const f of report.files) lines.push('| ' + f.problems + ' | `' + f.file + '` |');
	lines.push('');
	return lines.join('\n');
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log('usage: report.mjs [--from <eslint-json>] [--name <basename>] [--out <dir>]');
		return;
	}

	let rawResults;
	let source;
	let eslintVersion;
	if (args.from) {
		const fromPath = path.resolve(repoRoot, args.from);
		rawResults = JSON.parse(fs.readFileSync(fromPath, 'utf8'));
		if (!Array.isArray(rawResults)) throw new Error('--from file is not an ESLint JSON array: ' + fromPath);
		source = {
			kind: 'captured-json',
			path: fromPath,
			sha256: sha256(fromPath),
			describe: 'captured ESLint JSON formatter output (`' + rel(fromPath) + '`)',
		};
		eslintVersion = JSON.parse(
			fs.readFileSync(path.join(repoRoot, 'node_modules', 'eslint', 'package.json'), 'utf8'),
		).version;
	} else {
		const eslint = new ESLint({
			cwd: repoRoot,
			overrideConfigFile: configPath,
			warnIgnored: false,
			errorOnUnmatchedPattern: false,
		});
		rawResults = await eslint.lintFiles(targets);
		eslintVersion = eslint.version;
		source = { kind: 'live', path: null, sha256: null, describe: 'live ESLint run over the current working tree' };
	}

	const report = {
		tool: 'tools/plugin-review-baseline/report.mjs',
		config: rel(configPath),
		targets,
		eslintVersion,
		source,
		...aggregate(rawResults),
	};

	fs.mkdirSync(args.outDir, { recursive: true });
	const jsonPath = path.join(args.outDir, args.name + '.json');
	const mdPath = path.join(args.outDir, args.name + '.md');
	fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
	fs.writeFileSync(mdPath, renderMarkdown(report) + '\n');

	const t = report.totals;
	console.log('wrote ' + rel(jsonPath) + ' and ' + rel(mdPath));
	console.log(
		'problems=' + t.problems + ' errors=' + t.errors + ' warnings=' + t.warnings + ' filesWithProblems=' + t.filesWithProblems,
	);
	for (const r of report.rules.slice(0, 12)) console.log('  ' + String(r.count).padStart(6) + '  ' + r.ruleId);
	if (report.rules.length > 12) console.log('  ... ' + (report.rules.length - 12) + ' more rules (see JSON)');
}

main().catch((err) => {
	console.error(err && err.stack ? err.stack : String(err));
	process.exitCode = 1;
});
