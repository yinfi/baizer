#!/usr/bin/env node
/**
 * 导出 Obsidian 社区插件展页（community.obsidian.md）Scorecard → Review 扫描分类清单。
 *
 * 展页是 Next.js 的 RSC 页面：分类、计数和代码位置都在页面内嵌的 flight 数据里。
 * 本脚本按页面上真实渲染的数据结构解析，输出可追溯的分类清单（JSON），
 * 以便在修复时对照扫描版本、规则、计数和代码位置。
 *
 * 用法：
 *   node scripts/review-scan/scorecard-inventory.mjs --out docs/review/review-scan-2026-11-05.json
 *   node scripts/review-scan/scorecard-inventory.mjs --html saved-page.html --out out.json
 *   node scripts/review-scan/scorecard-inventory.mjs --markdown docs/review/categories.md
 *
 * 不依赖任何 npm 包；只读公开页面，不修改远端状态。
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_URL = 'https://community.obsidian.md/plugins/baizer';
const SECTION_NAMES = ['Warnings', 'Other', 'Passed', 'Disclosures'];

function parseArgs(argv) {
    const args = { url: DEFAULT_URL, html: null, out: null, markdown: null, compact: false };
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i];
        const next = argv[i + 1];
        if (key === '--url' && next) { args.url = next; i += 1; }
        else if (key === '--html' && next) { args.html = next; i += 1; }
        else if (key === '--out' && next) { args.out = next; i += 1; }
        else if (key === '--markdown' && next) { args.markdown = next; i += 1; }
        else if (key === '--compact') { args.compact = true; }
        else if (key === '--help' || key === '-h') {
            console.log('Usage: node scripts/review-scan/scorecard-inventory.mjs [--url URL] [--html FILE] [--out FILE] [--markdown FILE] [--compact]');
            process.exit(0);
        }
    }
    return args;
}

async function loadHtml(args) {
    if (args.html) return fs.readFileSync(args.html, 'utf8');
    const response = await fetch(args.url, {
        headers: {
            // 展页对无 UA 的请求会返回不同内容；使用常规浏览器 UA。
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        },
    });
    if (!response.ok) throw new Error(`Fetch failed: HTTP ${response.status} for ${args.url}`);
    return await response.text();
}

/** 把 Next.js RSC 的多个 self.__next_f.push 片段拼回一份 flight 文本。 */
function extractFlight(html) {
    const scripts = html.matchAll(/<script>self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)<\/script>/g);
    const parts = [];
    for (const match of scripts) {
        try {
            parts.push(JSON.parse(match[1]));
        } catch {
            // 单个片段解析失败不影响其余片段；后续结构性错误会由调用方报告。
        }
    }
    if (parts.length === 0) throw new Error('页面里没有找到 Next.js flight 数据（页面结构可能已改版）。');
    return parts.join('');
}

/** flight 文本 → 分块表 { id: rawText }。 */
function splitChunks(flight) {
    const marker = /(?:^|\n)([0-9a-f]+):/g;
    const found = [];
    let match;
    while ((match = marker.exec(flight)) !== null) {
        found.push({ id: match[1], valueStart: match.index + match[0].length, markerStart: match.index });
    }
    const chunks = new Map();
    for (let i = 0; i < found.length; i += 1) {
        const end = i + 1 < found.length ? found[i + 1].markerStart : flight.length;
        const raw = flight.slice(found[i].valueStart, end).replace(/\n$/, '');
        chunks.set(found[i].id, raw);
    }
    return chunks;
}

/**
 * flight 里大部分 chunk 是 JSON 值；少数是 webpack 模块引用（I[...] 等），
 * 与页面数据无关，解析失败时跳过即可。
 */
function parseChunks(chunks) {
    const parsed = new Map();
    for (const [id, raw] of chunks) {
        try {
            parsed.set(id, JSON.parse(raw.replace(/\$undefined/g, 'null')));
        } catch {
            // 模块引用 chunk，与 Review 数据无关。
        }
    }
    return parsed;
}

/** 展开 `$L<id>` 引用，得到完整 React 元素树。 */
function createResolver(parsedChunks) {
    const memo = new Map();
    const resolving = new Set();

    const resolveChunk = (id) => {
        if (memo.has(id)) return memo.get(id);
        if (resolving.has(id)) return undefined;
        resolving.add(id);
        const value = deepResolve(parsedChunks.get(id));
        resolving.delete(id);
        memo.set(id, value);
        return value;
    };

    const deepResolve = (value) => {
        if (typeof value === 'string') {
            const ref = /^\$L([0-9a-f]+)$/.exec(value);
            if (ref) return resolveChunk(ref[1]);
            return value;
        }
        if (Array.isArray(value)) return value.map(deepResolve);
        if (value && typeof value === 'object') {
            const result = {};
            for (const [key, child] of Object.entries(value)) result[key] = deepResolve(child);
            return result;
        }
        return value;
    };

    return { resolveChunk, deepResolve };
}

function isElement(node, type) {
    return Array.isArray(node) && node[0] === '$' && node[1] === type;
}

function elementProps(node) {
    return node && Array.isArray(node) && node[3] && typeof node[3] === 'object' ? node[3] : null;
}

function isHeadingFor(node, name) {
    if (!isElement(node, 'h3')) return false;
    const props = elementProps(node);
    return !!props && Array.isArray(props.children) && props.children[0] === name;
}

/** 在已解析的章节容器里找 h3 的名字和计数。 */
function readHeading(node) {
    const props = elementProps(node);
    const children = props && Array.isArray(props.children) ? props.children : [];
    const name = children[0];
    let count = null;
    const badge = children.find((child) => {
        const badgeProps = elementProps(child);
        return !!badgeProps && typeof badgeProps.children === 'number';
    });
    if (badge) count = elementProps(badge).children;
    return { name, count };
}

/** 在节点树里找到某个 h3 章节的容器 [{type,'div'}, ..., {children:[h3, entries]}]。 */
function findSectionContainer(node, name, seen = new Set()) {
    if (!node || typeof node !== 'object') return null;
    if (seen.has(node)) return null;
    seen.add(node);
    const props = elementProps(node);
    if (props && Array.isArray(props.children)) {
        const [first, second] = props.children;
        if (isHeadingFor(first, name) && Array.isArray(second)) {
            return { heading: readHeading(first), entries: second };
        }
    }
    const candidates = Array.isArray(node) ? node : Object.values(node);
    for (const child of candidates) {
        const found = findSectionContainer(child, name, seen);
        if (found) return found;
    }
    return null;
}

/** 深层查找满足条件的第一个节点。 */
function findDeep(node, predicate, seen = new Set()) {
    if (!node || typeof node !== 'object') return null;
    if (seen.has(node)) return null;
    seen.add(node);
    if (predicate(node)) return node;
    const values = Array.isArray(node) ? node : Object.values(node);
    for (const child of values) {
        const found = findDeep(child, predicate, seen);
        if (found) return found;
    }
    return null;
}

function findDeepAll(node, predicate, out = [], seen = new Set()) {
    if (!node || typeof node !== 'object') return out;
    if (seen.has(node)) return out;
    seen.add(node);
    if (predicate(node)) out.push(node);
    const values = Array.isArray(node) ? node : Object.values(node);
    for (const child of values) findDeepAll(child, predicate, out, seen);
    return out;
}

function stripMarkdown(text) {
    return String(text ?? '')
        .replace(/\*\*/g, '')
        .replace(/`/g, '')
        .replace(/\n/g, ' ')
        .trim();
}

/** 解析一个条目（details 分类，或 div 形式的披露项）。 */
function parseEntry(entry) {
    const type = entry[1];
    const key = typeof entry[2] === 'string' ? entry[2] : '';
    const match = /^(pass|info|medium):(\d+):(.*)$/s.exec(key);
    const props = elementProps(entry);
    const children = props && Array.isArray(props.children) ? props.children : [];
    const summary = children[0];
    const title = match ? match[3].replace(/\\n/g, ' ') : key;
    const severity = match ? match[1] : null;
    const index = match ? Number(match[2]) : null;

    let count = null;
    let countInferred = false;
    if (type === 'details') {
        const badge = findDeep(summary, (node) => {
            const badgeProps = elementProps(node);
            return !!badgeProps
                && typeof badgeProps.children === 'number'
                && typeof badgeProps.className === 'string'
                && badgeProps.className.includes('tabular-nums');
        });
        if (badge) count = elementProps(badge).children;
        else { count = 1; countInferred = true; }
    } else {
        // div 形式的披露项（如 medium:28 直接文件系统访问）没有独立计数，按 1 条计。
        count = 1;
        countInferred = true;
    }

    const ruleList = findDeep(children[1], (node) => {
        const listProps = elementProps(node);
        return isElement(node, 'ul') && !!listProps && typeof listProps.className === 'string'
            && listProps.className.includes('space-y-1 text-xs text-muted');
    });
    const rules = [];
    if (ruleList) {
        const listProps = elementProps(ruleList);
        for (const item of listProps.children || []) {
            const itemProps = elementProps(item);
            if (!itemProps) continue;
            const text = typeof itemProps.children === 'string' ? itemProps.children : null;
            if (text && !/^\d+$/.test(text) && !text.startsWith('$L')) rules.push(text);
        }
    }

    const locationList = findDeep(children[1], (node) => {
        const listProps = elementProps(node);
        return isElement(node, 'ul') && !!listProps && typeof listProps.className === 'string'
            && listProps.className.includes('space-y-1 font-mono text-xs text-muted');
    });
    const locations = [];
    if (locationList) {
        const listProps = elementProps(locationList);
        for (const item of listProps.children || []) {
            const anchor = findDeep(item, (node) => {
                const anchorProps = elementProps(node);
                return isElement(node, 'a') && !!anchorProps && typeof anchorProps.href === 'string'
                    && anchorProps.href.includes('github.com/yinfi/baizer/blob/');
            });
            if (!anchor) continue;
            const href = elementProps(anchor).href;
            const located = /\/blob\/([0-9a-f]+)\/([^#]+)#L(\d+)/.exec(href);
            if (!located) continue;
            locations.push({
                commit: located[1],
                file: located[2],
                line: Number(located[3]),
                url: href,
            });
        }
    }

    return { severity, index, type, title: stripMarkdown(title), rawTitle: title, count, countInferred, rules, locations };
}

function summarizeLocations(locations) {
    const byFile = new Map();
    for (const location of locations) {
        if (!byFile.has(location.file)) byFile.set(location.file, []);
        byFile.get(location.file).push(location.line);
    }
    return [...byFile.entries()]
        .map(([file, lines]) => ({ file, count: lines.length, lines: [...new Set(lines)].sort((a, b) => a - b) }))
        .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}

function buildInventory(html, source) {
    const flight = extractFlight(html);
    const chunks = splitChunks(flight);
    const parsed = parseChunks(chunks);
    const resolver = createResolver(parsed);

    const sections = {};
    for (const name of SECTION_NAMES) {
        let container = null;
        for (const id of parsed.keys()) {
            const value = resolver.resolveChunk(id);
            container = findSectionContainer(value, name);
            if (container) break;
        }
        if (!container) {
            sections[name] = { name, count: null, items: [] };
            continue;
        }
        const items = [];
        for (const entry of container.entries) {
            if (!Array.isArray(entry)) continue;
            const parsedEntry = parseEntry(entry);
            if (!parsedEntry.severity) continue;
            items.push(parsedEntry);
        }
        sections[name] = { name, count: container.heading.count, items };
    }

    const summaryMatch = /(\d+) issues found by automated scans of the latest release\./.exec(flight);
    const reviewTotal = summaryMatch ? Number(summaryMatch[1]) : null;

    const firstLocation = sections.Warnings.items.flatMap((item) => item.locations)[0]
        ?? sections.Other.items.flatMap((item) => item.locations)[0]
        ?? null;
    const scanCommit = firstLocation ? firstLocation.commit : null;

    const versionMatch = /\["Current version"\],\["\$","div",null,\{"className":"","children":"([^"]+)"\}\]/.exec(flight)
        ?? /\["\$","div",null,\{"className":"text-muted","children":"Current version"\}\],\["\$","div",null,\{"className":"","children":"([^"]+)"\}\]/.exec(flight);
    const updatedMatch = /Nov\s+\d{1,2},\s+\d{4}/.exec(flight);

    return {
        source: {
            url: source.url,
            fetchedAt: new Date().toISOString(),
            releaseVersion: versionMatch ? versionMatch[1] : null,
            pageUpdated: updatedMatch ? updatedMatch[0] : null,
            scanCommit,
            scanCommitUrl: scanCommit ? `https://github.com/yinfi/baizer/tree/${scanCommit}` : null,
            scannerNote: 'Obsidian community plugin review: eslint-plugin-obsidianmd scanner config (TypeScript rules) + stylelint scanner config (CSS rules).',
        },
        review: {
            totalIssues: reviewTotal,
            summaryText: summaryMatch ? summaryMatch[0] : null,
            warnings: { count: sections.Warnings.count, items: sections.Warnings.items },
            other: { count: sections.Other.count, items: sections.Other.items },
            passed: { count: sections.Passed.count, items: sections.Passed.items },
        },
        disclosures: { count: sections.Disclosures.count, items: sections.Disclosures.items },
    };
}

function toMarkdown(inventory) {
    const lines = [];
    const { review, disclosures, source } = inventory;
    lines.push('# Review 扫描分类清单（搬运快照）', '');
    lines.push(`- 来源：${source.url}`);
    lines.push(`- 拉取时间：${source.fetchedAt}`);
    lines.push(`- 当前版本：${source.releaseVersion ?? '未知'}`);
    lines.push(`- 扫描代码版本：${source.scanCommit ?? '未知'}`);
    lines.push(`- 页面原文：${review.summaryText ?? '未知'}（Warnings ${review.warnings.count}，Other ${review.other.count}，Passed ${review.passed.count}）`);
    lines.push('');
    lines.push('## Warnings（Risk 级别）', '');
    lines.push('| # | 分类标题 | 规则 | 页面计数 | 位置条目 | 命中文件数 |');
    lines.push('|---|---|---|---|---|---|');
    for (const item of review.warnings.items) {
        const files = summarizeCompacted(item).length;
        const locationCount = item.locationCount ?? (item.locations ?? []).length;
        lines.push(`| ${item.index} | ${item.title.replace(/\|/g, '\\|')} | ${item.rules.join(', ') || '（页面未列出）'} | ${item.count}${item.countInferred ? '（页面未显示徽标，按 1 条）' : ''} | ${locationCount} | ${files} |`);
    }
    lines.push('');
    lines.push('## Other（Info 级别）', '');
    lines.push('| # | 分类标题 | 规则 | 页面计数 | 位置条目 |');
    lines.push('|---|---|---|---|---|');
    for (const item of review.other.items) {
        const locationCount = item.locationCount ?? (item.locations ?? []).length;
        lines.push(`| ${item.index} | ${item.title.replace(/\|/g, '\\|')} | ${item.rules.join(', ') || '（页面未列出）'} | ${item.count}${item.countInferred ? '（页面未显示徽标，按 1 条）' : ''} | ${locationCount} |`);
    }
    lines.push('');
    lines.push('## Passed', '');
    for (const item of review.passed.items) lines.push(`- ${item.title}`);
    lines.push('');
    lines.push('## Disclosures', '');
    lines.push('| # | 标题 | 说明 |');
    lines.push('|---|---|---|');
    for (const item of disclosures.items) {
        lines.push(`| ${item.index} | ${item.title.replace(/\|/g, '\\|')} | ${item.rawTitle.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
    return lines.join('\n');
}

/**
 * 紧凑快照：把逐条 URL 折叠成 { file, lines }，避免把 1MB 的原始位置清单提交进仓库。
 * 每个位置仍可按 `https://github.com/yinfi/baizer/blob/<scanCommit>/<file>#L<line>` 还原。
 */
function compactItem(item) {
    const { locations, ...rest } = item;
    return { ...rest, locationCount: locations.length, locationsByFile: summarizeLocations(locations) };
}

function compactInventory(inventory) {
    return {
        ...inventory,
        review: {
            ...inventory.review,
            warnings: { ...inventory.review.warnings, items: inventory.review.warnings.items.map(compactItem) },
            other: { ...inventory.review.other, items: inventory.review.other.items.map(compactItem) },
            passed: { ...inventory.review.passed, items: inventory.review.passed.items.map(compactItem) },
        },
        disclosures: { ...inventory.disclosures, items: inventory.disclosures.items.map(compactItem) },
    };
}

function summarizeCompacted(item) {
    if (item.locationsByFile) return item.locationsByFile;
    return summarizeLocations(item.locations ?? []);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const html = await loadHtml(args);
    let inventory = buildInventory(html, { url: args.html ? path.resolve(args.html) : args.url });
    if (args.compact) inventory = compactInventory(inventory);

    if (args.out) {
        fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
        fs.writeFileSync(args.out, `${JSON.stringify(inventory, null, 2)}\n`);
        console.log(`wrote ${args.out}`);
    }
    if (args.markdown) {
        fs.mkdirSync(path.dirname(path.resolve(args.markdown)), { recursive: true });
        fs.writeFileSync(args.markdown, toMarkdown(inventory));
        console.log(`wrote ${args.markdown}`);
    }
    if (!args.out && !args.markdown) {
        process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    }

    const warnings = inventory.review.warnings;
    console.log(`summary: total=${inventory.review.totalIssues}, warnings=${warnings.count}, other=${inventory.review.other.count}, passed=${inventory.review.passed.count}, disclosures=${inventory.disclosures.count}`);
    for (const item of warnings.items) {
        console.log(`  ${String(item.index).padStart(2)}  ${String(item.count).padStart(5)}  ${item.title}`);
    }
}

main().catch((error) => {
    console.error(`scorecard-inventory failed: ${error.message}`);
    process.exit(1);
});
