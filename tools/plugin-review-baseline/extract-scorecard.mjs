// One-off provenance tool: turn the captured Next.js RSC flight payload of the
// Obsidian scorecard page into docs/plugin-review/scan-inventory.json.
//
// The payload is NOT committed (it is a 2.7 MB capture of a third-party page).
// To re-run:
//   1. fetch https://community.obsidian.md/plugins/baizer#scorecard
//   2. extract the `self.__next_f.push([1,"..."])` chunks and decode the
//      JSON-escaped strings into one line per flight row (`<id>:<json>`)
//   3. node tools/plugin-review-baseline/extract-scorecard.mjs --payload <flight.txt>
//
//   node tools/plugin-review-baseline/extract-scorecard.mjs \
//        --payload <flight.txt> [--out docs/plugin-review/scan-inventory.json]
//
// Everything in the output is read from the page payload; nothing is inferred.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const defaultOut = path.join(repoRoot, 'docs', 'plugin-review', 'scan-inventory.json');

function parseArgs(argv) {
	const out = { payload: null, out: defaultOut };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--payload') out.payload = argv[++i];
		else if (argv[i] === '--out') out.out = argv[++i];
		else throw new Error('unknown argument: ' + argv[i]);
	}
	if (!out.payload) throw new Error('--payload <flight.txt> is required');
	return out;
}

const args = parseArgs(process.argv.slice(2));
const flight = fs.readFileSync(args.payload, 'utf8');

// Flight rows look like `<id>:<json>`; ids are short hex/base36 strings.
const rows = new Map();
for (const line of flight.split('\n')) {
	const m = line.match(/^([0-9a-zA-Z]+):(.*)$/);
	if (!m) continue;
	try {
		rows.set(m[1], JSON.parse(m[2]));
	} catch {
		// not a JSON row
	}
}

// Resolve `$L<id>` lazy references into a plain tree.
function resolve(node, depth = 0) {
	if (depth > 90) return node;
	if (typeof node === 'string') {
		const m = node.match(/^\$L([0-9a-zA-Z]+)$/);
		if (m && rows.has(m[1])) return resolve(rows.get(m[1]), depth + 1);
		return node;
	}
	if (Array.isArray(node)) return node.map((x) => resolve(x, depth + 1));
	if (node && typeof node === 'object') {
		const o = {};
		for (const [k, v] of Object.entries(node)) o[k] = resolve(v, depth + 1);
		return o;
	}
	return node;
}

function textOf(node) {
	const acc = [];
	const walk = (x) => {
		if (typeof x === 'string') {
			acc.push(x);
			return;
		}
		if (Array.isArray(x)) {
			x.forEach(walk);
			return;
		}
		if (x && typeof x === 'object') {
			if (typeof x.children === 'string') acc.push(x.children);
			else if (Array.isArray(x.children)) x.children.forEach(walk);
		}
	};
	walk(node);
	return acc.join('');
}

function collectHrefs(node, acc = []) {
	if (Array.isArray(node)) {
		if (node[0] === '$' && node[1] === 'a' && node[3] && typeof node[3].href === 'string') acc.push(node[3].href);
		node.forEach((c) => collectHrefs(c, acc));
		return acc;
	}
	if (node && typeof node === 'object') Object.values(node).forEach((c) => collectHrefs(c, acc));
	return acc;
}

const RULE_ID = /^[@a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

function collectRules(node, acc = []) {
	if (Array.isArray(node)) {
		if (node[0] === '$' && node[1] === 'li' && typeof node[3]?.children === 'string' && RULE_ID.test(node[3].children)) {
			acc.push(node[3].children);
		}
		node.forEach((c) => collectRules(c, acc));
		return acc;
	}
	if (node && typeof node === 'object') Object.values(node).forEach((c) => collectRules(c, acc));
	return acc;
}

// `<li>` nodes holding a bare string: the asset names / values the scanner
// prints for non-code findings (e.g. "main.js", "api.bilibili.com",
// "21 network calls"). Rule ids are excluded (they are collected separately).
function collectPlainItems(node, acc = []) {
	if (Array.isArray(node)) {
		if (node[0] === '$' && node[1] === 'li' && typeof node[3]?.children === 'string') {
			const s = node[3].children;
			if (!RULE_ID.test(s)) acc.push(s);
		}
		node.forEach((c) => collectPlainItems(c, acc));
		return acc;
	}
	if (node && typeof node === 'object') Object.values(node).forEach((c) => collectPlainItems(c, acc));
	return acc;
}

// The count badge: a span with `tabular-nums` whose children is a number.
// A category with a single location renders no badge at all (implicit count 1).
function badge(node) {
	let found = null;
	const walk = (x) => {
		if (Array.isArray(x)) {
			if (
				x[0] === '$' &&
				x[1] === 'span' &&
				x[3] &&
				typeof x[3].className === 'string' &&
				x[3].className.includes('tabular-nums') &&
				typeof x[3].children === 'number'
			) {
				found = x[3].children;
			}
			x.forEach(walk);
			return;
		}
		if (x && typeof x === 'object') Object.values(x).forEach(walk);
	};
	walk(node);
	return found;
}

function firstHeading(node) {
	let h = null;
	const walk = (x) => {
		if (h) return;
		if (Array.isArray(x)) {
			if (x[0] === '$' && x[1] === 'h3') {
				h = x;
				return;
			}
			x.forEach(walk);
			return;
		}
		if (x && typeof x === 'object') Object.values(x).forEach(walk);
	};
	walk(node);
	return h;
}

function itemNodes(container) {
	const out = [];
	const scan = (x) => {
		if (Array.isArray(x)) {
			if (
				x[0] === '$' &&
				(x[1] === 'details' || x[1] === 'div') &&
				typeof x[2] === 'string' &&
				/^(pass|info|medium|low|high):\d+:/.test(x[2])
			) {
				out.push(x);
				return;
			}
			x.forEach(scan);
			return;
		}
		if (x && typeof x === 'object') Object.values(x).forEach(scan);
	};
	scan(container);
	return out;
}

function describe(node) {
	const key = node[2];
	const props = node[3];
	const declared = badge(props);
	const hrefs = collectHrefs(props);
	const locations = [];
	const referenceLinks = [];
	for (const h of hrefs) {
		if (h.startsWith('https://github.com/yinfi/baizer/blob/')) {
			locations.push(h.replace(/^https:\/\/github\.com\/yinfi\/baizer\/blob\/[0-9a-f]+\/?/, '') || '(repo root)');
		} else {
			referenceLinks.push(h);
		}
	}
	return {
		key,
		message: key.split(':').slice(2).join(':'),
		ruleIds: [...new Set(collectRules(props))],
		declaredCount: declared,
		effectiveCount: typeof declared === 'number' ? declared : 1,
		listedLinkCount: hrefs.length,
		locations: [...new Set(locations)],
		referenceLinks: [...new Set(referenceLinks)],
		plainItems: [...new Set(collectPlainItems(props))],
	};
}

// The Review section of the scorecard is four flight rows:
//   59  -> "Passed"
//   5a  -> "Disclosures"
//   5b  -> a container holding the "Warnings" (medium:*) and "Other" (info:*) lists
const sectionRows = [
	['passed', '59'],
	['disclosures', '5a'],
];
const warningsRoot = resolve(rows.get('5b'));

const sections = {};
for (const [name, id] of sectionRows) {
	const container = resolve(rows.get(id));
	const items = itemNodes(container).map(describe);
	sections[name] = {
		heading: firstHeading(container) ? textOf(firstHeading(container)) : null,
		headerBadge: firstHeading(container) ? badge(firstHeading(container)) : null,
		items,
	};
}
const warningsContainer = warningsRoot[3].children[1];
const otherContainer = warningsRoot[3].children[2];
for (const [name, container] of [
	['warnings', warningsContainer],
	['other', otherContainer],
]) {
	const items = itemNodes(container).map(describe);
	sections[name] = {
		heading: firstHeading(container) ? textOf(firstHeading(container)) : null,
		headerBadge: firstHeading(container) ? badge(firstHeading(container)) : null,
		items,
	};
}

for (const s of Object.values(sections)) {
	s.itemCount = s.items.length;
	s.computedSum = s.items.reduce((a, b) => a + b.effectiveCount, 0);
}

const warnings = sections.warnings;
const other = sections.other;
const top = warnings.items[0];
const perFile = new Map();
for (const loc of top.locations) {
	const f = loc.split('#')[0];
	perFile.set(f, (perFile.get(f) ?? 0) + 1);
}

const inventory = {
	provenance: {
		sourceUrl: 'https://community.obsidian.md/plugins/baizer#scorecard',
		pageReadOn: '2026-11-04',
		scanCodeCommit: '65020a8862aeaf88d41a2e164a7f779c3281ddd0',
		pageSummaryLine: '3002 issues found by automated scans of the latest release.',
		extractedFrom: 'Next.js RSC flight payload of the scorecard page (decoded)',
		extractor: 'docs/plugin-review/extract-scorecard.mjs',
	},
	reconciliation: {
		warningsHeaderBadge: warnings.headerBadge,
		warningsComputedSum: warnings.computedSum,
		otherHeaderBadge: other.headerBadge,
		otherComputedSum: other.computedSum,
		total: warnings.computedSum + other.computedSum,
		pageReportedTotal: 3002,
	},
	sections,
	topCategoryPerFile: {
		key: top.key,
		declaredCount: top.declaredCount,
		uniqueLocations: top.locations.length,
		fileCount: perFile.size,
		perFile: [...perFile.entries()]
			.map(([file, count]) => ({ file, count }))
			.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file)),
	},
};

fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(inventory, null, 1) + '\n');

console.log('wrote ' + path.relative(repoRoot, args.out).split(path.sep).join('/'));
for (const [name, s] of Object.entries(sections)) {
	console.log(
		'  ' + name.padEnd(12) + ' heading=' + JSON.stringify(s.heading) + ' items=' + s.itemCount + ' sum=' + s.computedSum,
	);
}
console.log('  reconciliation=' + JSON.stringify(inventory.reconciliation));
