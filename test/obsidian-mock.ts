// Mock HTMLElement
class MockHTMLElement {
    children: any[] = [];
    classList: Set<string> = new Set();
    style: any = {};
    value: string = '';
    scrollTop: number = 0;
    scrollHeight: number = 100;

    constructor(public tagName: string = 'div') { }

    empty() { this.children = []; }
    addClass(cls: string) { this.classList.add(cls); }
    createDiv(attr?: any) { return this.createEl('div', attr); }
    createSpan(attr?: any) { return this.createEl('span', attr); }
    createEl(tag: string, attr?: any) {
        const el = new MockHTMLElement(tag);
        this.children.push(el);
        return el;
    }
    addEventListener() { }
    focus() { }
    setText(text: string) { }
    remove() { }
}

export class ItemView {
    contentEl: MockHTMLElement;

    constructor(public leaf: any) {
        this.contentEl = new MockHTMLElement('div');
    }
    getViewType() { return 'test-view'; }
    getDisplayText() { return 'Test View'; }
    getIcon() { return 'test-icon'; }
    async onOpen() { }
    async onClose() { }
    addAction() { }
}

export class Plugin {
    constructor(public app: any, public manifest: any) { }
    async onload() { }
    async onunload() { }
    addCommand() { }
    addSettingTab() { }
    registerView() { }
    registerEvent() { }
    loadData() { return Promise.resolve({}); }
    saveData() { return Promise.resolve(); }
}

export class Notice {
    constructor(message: string, timeout?: number) { }
}

export const MarkdownRenderer = {
    render: (app: any, markdown: string, el: any, sourcePath: string, component: any) => {
        // el is MockHTMLElement
        // We can simulate rendering by setting some property if needed, or just ignoring
    }
};

export function setIcon() { }
export function debounce(func: Function, wait: number, immediate: boolean) {
    return func;
}

export class App {
    workspace: any;
    vault: any;
    metadataCache: any;
    commands: any;
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

export type WorkspaceLeaf = any;
