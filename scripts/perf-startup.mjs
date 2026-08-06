/**
 * 启动耗时测量 harness（临时诊断用）。
 *
 * 分两段量,因为 Obsidian 启动被这两段串行阻塞:
 *   1. bundle 求值 —— Obsidian 同步 require dist/main.js,顶层代码全部执行完才返回
 *   2. onload()   —— Obsidian await 它,期间其他插件与 workspace 都在等
 *
 * 用法: node scripts/perf-startup.mjs [vaultFileCount]
 */
import Module from 'module';
import { performance } from 'perf_hooks';

const FILE_COUNT = Number(process.argv[2] ?? 500);

// ---------- obsidian 外部依赖打桩 ----------
class FakeComponent {
	load() {}
	onload() {}
	unload() {}
	onunload() {}
	addChild() {}
	removeChild() {}
	register() {}
	registerEvent() {}
	registerDomEvent() {}
	registerInterval() {}
}

class TFile {
	constructor(path, mtime = 0) {
		this.path = path;
		this.extension = path.split('.').pop();
		this.basename = path.replace(/\.[^.]+$/, '').split('/').pop();
		this.name = path.split('/').pop();
		this.stat = { mtime, ctime: mtime, size: 100 };
		this.parent = { path: path.split('/').slice(0, -1).join('/') || '/' };
	}
}
class TFolder {
	constructor(path) {
		this.path = path;
		this.children = [];
	}
}

const timings = [];
function mark(label, ms) {
	timings.push({ label, ms });
}

/**
 * IO 延迟模拟。桌面 SSD 上一次 adapter.exists 约 0.1-1ms,移动端要过 native 桥
 * (Capacitor/WKWebView),实测每次 5-30ms。零成本的桩会完全掩盖 IO 数量问题,
 * 所以这里按平台注入延迟 —— 这才是「移动端也慢」的可测模型。
 */
const IO_LATENCY_MS = Number(process.env.IO_LATENCY_MS ?? 0);
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** 按「调用点」归因每次 IO,才能指出是谁在刷 IO,而不只是总数 */
const io = { read: 0, write: 0, exists: 0, list: 0, mkdir: 0, stat: 0 };
const ioByCaller = new Map();

/** 逐次 IO 的时间线。用来找「串行等待链」——IO 次数之外的那部分耗时藏在这里。 */
const ioTimeline = [];

function recordIo(kind, path) {
	io[kind]++;
	// 取插件自身代码里最近的一帧作为归因点(跳过 harness 与 node 内部)
	const stack = new Error().stack ?? '';
	const frame = stack
		.split('\n')
		.slice(2)
		.find((l) => l.includes('main.js')) ?? 'unknown';
	const key = frame.trim().replace(/^at\s+/, '').replace(/\s*\(.*$/, '');
	const bucket = ioByCaller.get(key) ?? { count: 0, kinds: new Set(), samples: [] };
	bucket.count++;
	bucket.kinds.add(kind);
	if (bucket.samples.length < 3 && path) bucket.samples.push(path);
	ioByCaller.set(key, bucket);
	ioTimeline.push({ t: performance.now(), kind, caller: key, path });
}

/**
 * 有状态的虚拟 FS。
 *
 * 恒返回 exists:false 的桩只模拟了「全新安装」,而用户抱怨的慢是**每次启动都慢**,
 * 也就是目录/文件早已存在的常态。用 WARM=1 预置这些路径,才测得到真实的稳态开销;
 * WARM=0 则是首次安装。两者 IO 次数的差,正好告出哪些 IO 是「本来就可以跳过的」。
 */
const WARM = process.env.WARM !== '0';
const BUILTIN_SKILLS = [
	'web-search', 'web-clipper', 'obsidian-markdown',
	'json-canvas', 'obsidian-bases', 'plugin-ctrl', 'knowledge',
];

function makeVirtualFs() {
	const dirs = new Set();
	const filesMap = new Map();
	if (WARM) {
		for (const d of ['.obsidian', '.obsidian/baizer', '.obsidian/baizer/skills', 'Knowledge Wiki']) dirs.add(d);
		for (const name of BUILTIN_SKILLS) {
			dirs.add(`.obsidian/baizer/skills/${name}`);
			filesMap.set(`.obsidian/baizer/skills/${name}/SKILL.md`, '---\nname: x\n---\nbody');
		}
		filesMap.set('Knowledge Wiki/index.base', 'filters: {}');
	}
	return { dirs, filesMap };
}

function makeApp(fileCount) {
	const files = [];
	for (let i = 0; i < fileCount; i++) {
		files.push(new TFile(`notes/note-${i}.md`, Date.now() - i * 1000));
	}

	const fs = makeVirtualFs();

	const adapter = {
		async read(p) {
			recordIo('read', p); await sleep(IO_LATENCY_MS);
			if (!fs.filesMap.has(p)) throw new Error(`ENOENT ${p}`);
			return fs.filesMap.get(p);
		},
		async write(p, data) { recordIo('write', p); await sleep(IO_LATENCY_MS); fs.filesMap.set(p, data); },
		async exists(p) { recordIo('exists', p); await sleep(IO_LATENCY_MS); return fs.dirs.has(p) || fs.filesMap.has(p); },
		async list(p) {
			recordIo('list', p); await sleep(IO_LATENCY_MS);
			const prefix = p.endsWith('/') ? p : `${p}/`;
			const depth = prefix.split('/').filter(Boolean).length;
			const at = (s) => s.startsWith(prefix) && s.split('/').filter(Boolean).length === depth + 1;
			return {
				files: [...fs.filesMap.keys()].filter(at),
				folders: [...fs.dirs].filter(at),
			};
		},
		async mkdir(p) { recordIo('mkdir', p); await sleep(IO_LATENCY_MS); fs.dirs.add(p); },
		async stat(p) {
			recordIo('stat', p); await sleep(IO_LATENCY_MS);
			if (fs.dirs.has(p)) return { type: 'folder', mtime: 0, ctime: 0, size: 0 };
			if (fs.filesMap.has(p)) return { type: 'file', mtime: 0, ctime: 0, size: fs.filesMap.get(p).length };
			return null;
		},
		async remove(p) { fs.filesMap.delete(p); },
		getFullPath: (p) => p,
	};

	const metadataCache = {
		initialized: true,
		resolvedLinks: {},
		getFileCache: () => ({ frontmatter: undefined }),
		getFirstLinkpathDest: () => null,
		on: () => ({}),
		off: () => {},
		offref: () => {},
	};

	return {
		vault: {
			adapter,
			getFiles: () => files,
			getMarkdownFiles: () => files,
			getAllLoadedFiles: () => files,
			getAbstractFileByPath: () => null,
			async read(f) { recordIo('read', f?.path); await sleep(IO_LATENCY_MS); return ''; },
			async cachedRead(f) { recordIo('read', f?.path); await sleep(IO_LATENCY_MS); return ''; },
			async create(p) { recordIo('write', p); await sleep(IO_LATENCY_MS); return new TFile('x.md'); },
			async createFolder(p) { recordIo('mkdir', p); await sleep(IO_LATENCY_MS); },
			async modify(f) { recordIo('write', f?.path); await sleep(IO_LATENCY_MS); },
			on: () => ({}),
			off: () => {},
			offref: () => {},
			configDir: '.obsidian',
		},
		workspace: {
			on: () => ({}),
			off: () => {},
			offref: () => {},
			getActiveFile: () => null,
			getLeavesOfType: () => [],
			getActiveViewOfType: () => null,
			onLayoutReady: (cb) => cb(),
			trigger: () => {},
		},
		metadataCache,
		fileManager: {
			async processFrontMatter(_f, fn) { io.write++; fn({}); },
		},
		plugins: { plugins: {}, manifests: {}, enabledPlugins: new Set() },
		commands: { listCommands: () => [], commands: {}, executeCommandById: () => true },
		internalPlugins: { plugins: {} },
	};
}

const obsidianStub = {
	Plugin: class extends FakeComponent {
		constructor() {
			super();
			this.app = makeApp(FILE_COUNT);
			this.manifest = { id: 'baizer', version: '1.0.2', dir: '.obsidian/plugins/baizer' };
		}
		async loadData() { return {}; }
		async saveData() { io.write++; }
		addCommand() {}
		addRibbonIcon() { return { addClass: () => {} }; }
		addSettingTab() {}
		registerView() {}
		registerEditorExtension() {}
		registerObsidianProtocolHandler() {}
		registerMarkdownPostProcessor() {}
	},
	PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = null; } display() {} },
	Setting: class { constructor() {} setName() { return this; } setDesc() { return this; } addText() { return this; } addToggle() { return this; } addDropdown() { return this; } addSlider() { return this; } addTextArea() { return this; } addButton() { return this; } setClass() { return this; } setHeading() { return this; } },
	Notice: class { constructor(m) { void m; } setMessage() {} hide() {} },
	Modal: class extends FakeComponent { constructor(app) { super(); this.app = app; } open() {} close() {} },
	ItemView: class extends FakeComponent {},
	View: class extends FakeComponent {},
	Component: FakeComponent,
	WorkspaceLeaf: class {},
	MarkdownView: class {},
	MarkdownRenderer: { render: async () => {}, renderMarkdown: async () => {} },
	TFile, TFolder,
	TAbstractFile: class {},
	Vault: class {},
	Platform: { isMobile: false, isDesktopApp: true },
	debounce: (fn) => { const f = (...a) => fn(...a); f.cancel = () => {}; return f; },
	setIcon: () => {},
	addIcon: () => {},
	setTooltip: () => {},
	requestUrl: async () => ({ text: '', json: {}, status: 200 }),
	normalizePath: (p) => p,
	moment: () => ({ format: () => '' }),
	parseYaml: () => ({}),
	stringifyYaml: () => '',
	getAllTags: () => [],
	prepareFuzzySearch: () => () => null,
	FuzzySuggestModal: class extends FakeComponent {},
	SuggestModal: class extends FakeComponent {},
	AbstractInputSuggest: class {},
	Menu: class { addItem() { return this; } showAtMouseEvent() {} },
	Keymap: { isModEvent: () => false },
	editorLivePreviewField: {},
};

// ---------- DOM 打桩(bundle 顶层可能触碰) ----------
const el = () => new Proxy({}, {
	get(_t, k) {
		if (k === 'style' || k === 'dataset' || k === 'classList') return el();
		if (k === 'value' || k === 'textContent' || k === 'innerHTML') return '';
		return () => el();
	},
	set() { return true; },
});
globalThis.document = {
	createElement: el, createElementNS: el, body: el(), head: el(),
	getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
	addEventListener: () => {}, removeEventListener: () => {}, createRange: el,
};
globalThis.window = new Proxy({
	setTimeout, clearTimeout, setInterval, clearInterval,
	addEventListener: () => {}, removeEventListener: () => {},
	getComputedStyle: () => el(), navigator: { userAgent: 'node', language: 'zh-CN' },
	location: { href: 'app://obsidian.md/' }, document: globalThis.document,
	requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: () => {},
	matchMedia: () => ({ matches: false, addEventListener: () => {} }),
}, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true; } });
// Node 25 的 globalThis.navigator 是只读 getter,只能用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
	value: globalThis.window.navigator,
	configurable: true,
	writable: true,
});
globalThis.HTMLElement = class {};
globalThis.Element = class {};
globalThis.DOMParser = class { parseFromString() { return { body: el(), querySelector: () => null, querySelectorAll: () => [] }; } };
globalThis.activeWindow = globalThis.window;
globalThis.activeDocument = globalThis.document;

// ---------- 拦截 require('obsidian') 与 @codemirror/* ----------
/**
 * 任意深度可调用/可构造/可取属性的递归桩。
 * @codemirror/* 与 obsidian 在 esbuild 里是 external —— Obsidian 运行时自带,
 * 不计入本插件的加载成本,所以打桩才是测「我们自己的 bundle」的正确做法。
 */
function makeDeepStub(name = 'cm') {
	const target = function () {};
	target.displayName = name;
	return new Proxy(target, {
		get(_t, k) {
			if (k === '__esModule') return true;
			if (k === Symbol.toPrimitive || k === 'toString') return () => name;
			if (k === 'prototype') return target.prototype;
			if (typeof k === 'symbol') return undefined;
			return makeDeepStub(`${name}.${String(k)}`);
		},
		set: () => true,
		has: () => true,
		apply: () => makeDeepStub(`${name}()`),
		construct: () => makeDeepStub(`new ${name}`),
	});
}
const cmStub = makeDeepStub('codemirror');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'obsidian') return obsidianStub;
	if (request.startsWith('@codemirror/') || request.startsWith('@lezer/')) return cmStub;
	return origLoad.call(this, request, parent, isMain);
};

// ---------- 第一段: bundle 求值 ----------
const requireCjs = Module.createRequire(import.meta.url);
const evalStart = performance.now();
const mod = requireCjs('../dist/main.js');
const evalMs = performance.now() - evalStart;
mark('bundle 求值 (Obsidian 同步 require)', evalMs);

// ---------- 第二段: onload() ----------
const PluginClass = mod.default ?? mod;
const instance = new PluginClass();

const onloadStart = performance.now();
await instance.onload();
const onloadMs = performance.now() - onloadStart;
mark('onload() (Obsidian await)', onloadMs);

// 阻塞期(求值 + onload)的 IO 快照 —— 这才是拖慢启动的部分
const blockingIo = { ...io };
const blockingByCaller = new Map(
	[...ioByCaller].map(([k, v]) => [k, { count: v.count, kinds: new Set(v.kinds), samples: [...v.samples] }]),
);

// 让 onMetadataReady 之类的 fire-and-forget 有机会跑完,量它们的尾巴
const TAIL_MS = Number(process.env.TAIL_MS ?? 300);
const tailStart = performance.now();
await new Promise((r) => setTimeout(r, TAIL_MS));
mark(`onload 后 ${TAIL_MS}ms 窗口内的后台尾巴`, performance.now() - tailStart);

// ---------- 报告 ----------
const totalIo = (o) => Object.values(o).reduce((a, b) => a + b, 0);

console.log(`\n=== 启动耗时 (vault ${FILE_COUNT} 个文件, IO 延迟 ${IO_LATENCY_MS}ms, ${WARM ? '热启动/文件已存在' : '冷启动/首次安装'}) ===`);
for (const t of timings) console.log(`  ${t.ms.toFixed(1).padStart(8)} ms  ${t.label}`);
console.log(`  ${'-'.repeat(56)}`);
console.log(`  ${(evalMs + onloadMs).toFixed(1).padStart(8)} ms  ★ 阻塞总计 (求值 + onload)`);

console.log(`\n=== 阻塞期 IO: ${totalIo(blockingIo)} 次 ${JSON.stringify(blockingIo)} ===`);
const ranked = [...blockingByCaller].sort((a, b) => b[1].count - a[1].count);
for (const [caller, v] of ranked.slice(0, 12)) {
	const kinds = [...v.kinds].join(',');
	console.log(`  ${String(v.count).padStart(4)} 次  [${kinds}]  ${caller}`);
	if (v.samples.length) console.log(`          e.g. ${v.samples.join(' | ')}`);
}

const tailTotal = totalIo(io) - totalIo(blockingIo);
console.log(`\n尾巴期额外 IO: ${tailTotal} 次 (累计 ${JSON.stringify(io)})`);

// ---------- IO 时间线: 把 onload 拆成「IO 等待」与「其他」 ----------
// 54 次 IO × 15ms = 810ms,但 onload 是 1227ms。差额在哪?要么是串行 IO 之间的
// 同步计算,要么是某个不走 adapter 的慢操作(如 pi 的动态 import)。
// 只算落在 onload 窗口内的 IO。修复后写盘转到了后台,尾巴期的 IO 不该记到
// onload 头上 —— 否则「其余」会算出负数。
const onloadEnd = onloadStart + onloadMs;
const onloadIo = ioTimeline.filter((e) => e.t >= onloadStart && e.t <= onloadEnd);
const ioWaitMs = onloadIo.length * IO_LATENCY_MS;
console.log(`\n=== onload ${onloadMs.toFixed(0)}ms 的构成 ===`);
console.log(`  ${ioWaitMs.toFixed(1).padStart(8)} ms  IO 等待 (${onloadIo.length} 次 × ${IO_LATENCY_MS}ms, 全部串行)`);
console.log(`  ${(onloadMs - ioWaitMs).toFixed(1).padStart(8)} ms  其余 (同步计算 / 动态 import / 无 adapter 的操作)`);

// 相邻 IO 之间 > 20ms 的空隙 = 那里有一段不走 IO 的耗时操作
const gaps = [];
let prevEnd = onloadStart;
for (const e of onloadIo) {
	const gap = e.t - prevEnd;
	if (gap > 20) gaps.push({ gap, before: e.caller, path: e.path });
	prevEnd = e.t + IO_LATENCY_MS;
}
if (gaps.length) {
	console.log(`\n  非 IO 空隙 (>20ms, 说明该处有同步/非 adapter 耗时):`);
	for (const g of gaps.sort((a, b) => b.gap - a.gap).slice(0, 8)) {
		console.log(`  ${g.gap.toFixed(1).padStart(8)} ms  紧接其后的 IO: ${g.before} (${g.path ?? ''})`);
	}
}
const lastIoEnd = onloadIo.length ? onloadIo[onloadIo.length - 1].t + IO_LATENCY_MS : onloadStart;
console.log(`  ${(onloadStart + onloadMs - lastIoEnd).toFixed(1).padStart(8)} ms  最后一次 IO 之后到 onload 返回`);

process.exit(0);
