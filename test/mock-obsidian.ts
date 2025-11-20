// Mock Obsidian API for testing

// Mock global document
(global as any).document = {
    getElementById: (id: string) => ({
        remove: () => { }
    })
};

export class Component {
    load() { }
    onload() { }
    unload() { }
    onunload() { }
    addChild(component: Component) { }
    removeChild(component: Component) { }
    register(cb: () => any) { }
    registerEvent(eventRef: any) { }
    registerDomEvent(el: any, type: string, callback: (evt: any) => any, options?: boolean | object) { }
    registerInterval(id: number) { }
}

export class App {
    vault: Vault;
    workspace: Workspace;
    metadataCache: MetadataCache;
    commands: Commands;

    constructor() {
        this.vault = new Vault();
        this.workspace = new Workspace();
        this.metadataCache = new MetadataCache();
        this.commands = new Commands();
    }
}

export class Vault {
    files: Record<string, string> = {};

    async read(file: any): Promise<string> {
        return this.files[file.path] || "";
    }

    async create(path: string, content: string): Promise<any> {
        this.files[path] = content;
        return { path, basename: path.replace('.md', '') };
    }

    getAbstractFileByPath(path: string) {
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

export class Workspace {
    activeLeaf: any;
    events: Record<string, Function[]> = {};

    getActiveFile() {
        return { path: 'test-note.md', basename: 'test-note' };
    }

    getMostRecentLeaf() {
        return this.activeLeaf;
    }

    on(event: string, callback: Function) {
        if (!this.events[event]) this.events[event] = [];
        this.events[event].push(callback);
        return { detach: () => { } }; // Mock EventRef
    }
}

export class MetadataCache {
    getFirstLinkpathDest(path: string, sourcePath: string) {
        return { path: path.endsWith('.md') ? path : path + '.md' };
    }
}

export class Commands {
    listCommands() { return []; }
    executeCommandById(id: string) { return true; }
}

export class Modal extends Component {
    contentEl: HTMLElement;
    app: App;
    constructor(app: App) {
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

        this.contentEl = createMockElement() as any;
    }
    open() { }
    close() { }
}

export class MarkdownRenderer {
    static render(app: App, markdown: string, el: HTMLElement, sourcePath: string, component: any) {
        // Mock render
    }
}

export class Notice {
    constructor(message: string, duration?: number) {
        console.log(`[Notice] ${message}`);
    }
}

export function setIcon(el: HTMLElement, icon: string) { }
export function debounce(func: Function, wait: number, immediate?: boolean) { return func; }
export class Plugin { }
export class WorkspaceLeaf {
    view: any;
}

export class View extends Component {
    app: App;
    leaf: WorkspaceLeaf;
    constructor(leaf: WorkspaceLeaf) {
        super();
        this.leaf = leaf;
        this.app = (leaf as any).app;
    }
    onOpen() { }
    onClose() { }
    getViewType() { return 'view'; }
    getDisplayText() { return 'View'; }
    getIcon() { return 'document'; }
}

export class ItemView extends View {
    contentEl: HTMLElement;
    constructor(leaf: WorkspaceLeaf) {
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
        this.contentEl = createMockElement() as any;
    }
}

export class PluginSettingTab {
    app: App;
    plugin: any;
    containerEl: HTMLElement;
    constructor(app: App, plugin: any) {
        this.app = app;
        this.plugin = plugin;
        this.containerEl = {
            empty: () => { },
            createEl: () => ({ setText: () => { }, setButtonText: () => { } })
        } as any;
    }
    display() { }
    hide() { }
}

export class Setting {
    constructor(containerEl: HTMLElement) { }
    setName(name: string) { return this; }
    setDesc(desc: string) { return this; }
    addText(cb: any) { return this; }
    addToggle(cb: any) { return this; }
    addSlider(cb: any) { return this; }
    addDropdown(cb: any) { return this; }
    addTextArea(cb: any) { return this; }
    addButton(cb: any) { return this; }
    setClass(cls: string) { return this; }
}
