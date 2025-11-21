"use strict";
// Mock Obsidian API for testing
Object.defineProperty(exports, "__esModule", { value: true });
exports.Setting = exports.PluginSettingTab = exports.ItemView = exports.View = exports.WorkspaceLeaf = exports.Plugin = exports.debounce = exports.setIcon = exports.Notice = exports.MarkdownRenderer = exports.Modal = exports.Commands = exports.MetadataCache = exports.Workspace = exports.Vault = exports.App = exports.Component = void 0;
// Mock global document
global.document = {
    getElementById: (id) => ({
        remove: () => { }
    })
};
class Component {
    load() { }
    onload() { }
    unload() { }
    onunload() { }
    addChild(component) { }
    removeChild(component) { }
    register(cb) { }
    registerEvent(eventRef) { }
    registerDomEvent(el, type, callback, options) { }
    registerInterval(id) { }
}
exports.Component = Component;
class App {
    vault;
    workspace;
    metadataCache;
    commands;
    constructor() {
        this.vault = new Vault();
        this.workspace = new Workspace();
        this.metadataCache = new MetadataCache();
        this.commands = new Commands();
    }
}
exports.App = App;
class Vault {
    files = {};
    async read(file) {
        return this.files[file.path] || "";
    }
    async create(path, content) {
        this.files[path] = content;
        return { path, basename: path.replace('.md', '') };
    }
    getAbstractFileByPath(path) {
        if (this.files[path]) {
            return { path, basename: path.replace('.md', '') };
        }
        return null;
    }
    getFiles() {
        return Object.keys(this.files).map(path => ({
            path,
            basename: path.replace('.md', '')
        }));
    }
}
exports.Vault = Vault;
class Workspace {
    activeLeaf;
    events = {};
    getActiveFile() {
        return { path: 'test-note.md', basename: 'test-note' };
    }
    getMostRecentLeaf() {
        return this.activeLeaf;
    }
    on(event, callback) {
        if (!this.events[event])
            this.events[event] = [];
        this.events[event].push(callback);
        return { detach: () => { } }; // Mock EventRef
    }
}
exports.Workspace = Workspace;
class MetadataCache {
    getFirstLinkpathDest(path, sourcePath) {
        return { path: path.endsWith('.md') ? path : path + '.md' };
    }
}
exports.MetadataCache = MetadataCache;
class Commands {
    listCommands() { return []; }
    executeCommandById(id) { return true; }
}
exports.Commands = Commands;
class Modal extends Component {
    contentEl;
    app;
    constructor(app) {
        super();
        this.app = app;
        // Recursive mock
        const createMockElement = () => ({
            createDiv: () => createMockElement(),
            createSpan: () => createMockElement(),
            createEl: () => createMockElement(),
            setText: () => { },
            addClass: () => { },
            remove: () => { },
            empty: () => { },
            addEventListener: () => { },
            focus: () => { },
            value: '',
            scrollTop: 0,
            scrollHeight: 0
        });
        this.contentEl = createMockElement();
    }
    open() { }
    close() { }
}
exports.Modal = Modal;
class MarkdownRenderer {
    static render(app, markdown, el, sourcePath, component) {
        // Mock render
    }
}
exports.MarkdownRenderer = MarkdownRenderer;
class Notice {
    constructor(message, duration) {
        console.log(`[Notice] ${message}`);
    }
}
exports.Notice = Notice;
function setIcon(el, icon) { }
exports.setIcon = setIcon;
function debounce(func, wait, immediate) { return func; }
exports.debounce = debounce;
class Plugin {
}
exports.Plugin = Plugin;
class WorkspaceLeaf {
    view;
}
exports.WorkspaceLeaf = WorkspaceLeaf;
class View extends Component {
    app;
    leaf;
    constructor(leaf) {
        super();
        this.leaf = leaf;
        this.app = leaf.app;
    }
    onOpen() { }
    onClose() { }
    getViewType() { return 'view'; }
    getDisplayText() { return 'View'; }
    getIcon() { return 'document'; }
}
exports.View = View;
class ItemView extends View {
    contentEl;
    constructor(leaf) {
        super(leaf);
        // Recursive mock
        const createMockElement = () => ({
            createDiv: () => createMockElement(),
            createSpan: () => createMockElement(),
            createEl: () => createMockElement(),
            setText: () => { },
            addClass: () => { },
            remove: () => { },
            empty: () => { },
            addEventListener: () => { },
            focus: () => { },
            value: '',
            scrollTop: 0,
            scrollHeight: 0,
            appendChild: () => { }
        });
        this.contentEl = createMockElement();
    }
}
exports.ItemView = ItemView;
class PluginSettingTab {
    app;
    plugin;
    containerEl;
    constructor(app, plugin) {
        this.app = app;
        this.plugin = plugin;
        this.containerEl = {
            empty: () => { },
            createEl: () => ({ setText: () => { }, setButtonText: () => { } })
        };
    }
    display() { }
    hide() { }
}
exports.PluginSettingTab = PluginSettingTab;
class Setting {
    constructor(containerEl) { }
    setName(name) { return this; }
    setDesc(desc) { return this; }
    addText(cb) { return this; }
    addToggle(cb) { return this; }
    addSlider(cb) { return this; }
    addDropdown(cb) { return this; }
    addTextArea(cb) { return this; }
    addButton(cb) { return this; }
    setClass(cls) { return this; }
}
exports.Setting = Setting;
