"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.App = exports.debounce = exports.setIcon = exports.MarkdownRenderer = exports.Notice = exports.Plugin = exports.ItemView = void 0;
// Mock HTMLElement
class MockHTMLElement {
    constructor(tagName = 'div') {
        this.tagName = tagName;
        this.children = [];
        this.classList = new Set();
        this.style = {};
        this.value = '';
        this.scrollTop = 0;
        this.scrollHeight = 100;
    }
    empty() { this.children = []; }
    addClass(cls) { this.classList.add(cls); }
    createDiv(attr) { return this.createEl('div', attr); }
    createSpan(attr) { return this.createEl('span', attr); }
    createEl(tag, attr) {
        const el = new MockHTMLElement(tag);
        this.children.push(el);
        return el;
    }
    addEventListener() { }
    focus() { }
    setText(text) { }
    remove() { }
}
class ItemView {
    constructor(leaf) {
        this.leaf = leaf;
        this.contentEl = new MockHTMLElement('div');
    }
    getViewType() { return 'test-view'; }
    getDisplayText() { return 'Test View'; }
    getIcon() { return 'test-icon'; }
    async onOpen() { }
    async onClose() { }
    addAction() { }
}
exports.ItemView = ItemView;
class Plugin {
    constructor(app, manifest) {
        this.app = app;
        this.manifest = manifest;
    }
    async onload() { }
    async onunload() { }
    addCommand() { }
    addSettingTab() { }
    registerView() { }
    registerEvent() { }
    loadData() { return Promise.resolve({}); }
    saveData() { return Promise.resolve(); }
}
exports.Plugin = Plugin;
class Notice {
    constructor(message, timeout) { }
}
exports.Notice = Notice;
exports.MarkdownRenderer = {
    render: (app, markdown, el, sourcePath, component) => {
        // el is MockHTMLElement
        // We can simulate rendering by setting some property if needed, or just ignoring
    }
};
function setIcon() { }
exports.setIcon = setIcon;
function debounce(func, wait, immediate) {
    return func;
}
exports.debounce = debounce;
class App {
    constructor() {
        this.workspace = {
            on: () => { },
            getLeavesOfType: () => [],
            getRightLeaf: () => null,
            revealLeaf: () => { },
            activeLeaf: null,
            getActiveFile: () => ({ path: 'test.md', basename: 'test' })
        };
        this.vault = {
            read: async () => "",
            create: async () => { },
            getFiles: () => []
        };
        this.metadataCache = {
            getFirstLinkpathDest: () => null
        };
        this.commands = {
            listCommands: () => [],
            executeCommandById: () => true
        };
    }
}
exports.App = App;
