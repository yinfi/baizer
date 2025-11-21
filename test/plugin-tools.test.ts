import { ToolManager } from '../src/mcp/tools';
import { App } from 'obsidian';

// Simple mock for jest.fn()
function mockFn(impl?: Function) {
    const fn: any = impl ? (...args: any[]) => impl(...args) : () => { };
    fn.mock = { calls: [] };
    return fn;
}

// Simple expect function for assertions
function expect(actual: any) {
    return {
        toBe: (expected: any) => {
            if (actual !== expected) {
                throw new Error(`Expected "${expected}" but got "${actual}"`);
            }
        },
        toEqual: (expected: any) => {
            const actualStr = JSON.stringify(actual);
            const expectedStr = JSON.stringify(expected);
            if (actualStr !== expectedStr) {
                throw new Error(`Expected ${expectedStr} but got ${actualStr}`);
            }
        },
        toBeDefined: () => {
            if (actual === undefined) {
                throw new Error(`Expected value to be defined, but got undefined`);
            }
        },
        toBeGreaterThan: (expected: number) => {
            if (typeof actual !== 'number' || actual <= expected) {
                throw new Error(`Expected ${actual} to be greater than ${expected}`);
            }
        },
        toContain: (expected: any) => {
            if (Array.isArray(actual)) {
                if (!actual.includes(expected)) {
                    throw new Error(`Expected array to contain "${expected}"`);
                }
            } else if (typeof actual === 'string') {
                if (!actual.includes(expected)) {
                    throw new Error(`Expected string to contain "${expected}"`);
                }
            } else {
                throw new Error(`Value is not an array or string`);
            }
        },
        toHaveProperty: (prop: string, value?: any) => {
            if (!actual || typeof actual !== 'object') {
                throw new Error(`Expected object, got ${typeof actual}`);
            }
            if (!(prop in actual)) {
                throw new Error(`Expected object to have property '${prop}'`);
            }
            if (value !== undefined && actual[prop] !== value) {
                throw new Error(`Expected property '${prop}' to be ${value}, got ${actual[prop]}`);
            }
        }
    };
}

// Mock Obsidian App
const mockApp = {
    plugins: {
        manifests: {
            'obsidian-kanban': {
                id: 'obsidian-kanban',
                name: 'Kanban',
                version: '1.5.3',
                description: 'Create markdown-backed Kanban boards.'
            },
            'dataview': {
                id: 'dataview',
                name: 'Dataview',
                version: '0.5.55',
                description: 'Complex data queries.'
            }
        },
        enabledPlugins: new Set(['obsidian-kanban']),
        getPlugin: (id: string) => {
            if (id === 'obsidian-kanban') {
                return {
                    settings: {
                        'date-format': 'YYYY-MM-DD',
                        'folder': 'Kanban'
                    }
                };
            }
            return null;
        }
    },
    commands: {
        listCommands: () => [
            { id: 'obsidian-kanban:create-new-board', name: 'Kanban: Create new board' },
            { id: 'dataview:query', name: 'Dataview Query' },
            { id: 'editor:toggle-bold', name: 'Toggle bold' }
        ],
        executeCommandById: mockFn(() => true)
    },
    metadataCache: {
        getFirstLinkpathDest: mockFn()
    },
    vault: {
        read: mockFn(),
        getAbstractFileByPath: mockFn(),
        create: mockFn(),
        modify: mockFn(),
        trash: mockFn(),
        rename: mockFn(),
        getMarkdownFiles: mockFn(() => []),
        getFiles: mockFn(() => [])
    },
    workspace: {
        getLeaf: mockFn(() => ({
            openFile: mockFn()
        }))
    }
} as unknown as App;

async function runTests() {
    console.log('Plugin Tools Integration Test');
    const toolManager = new ToolManager(mockApp, true);

    async function test(name: string, fn: () => Promise<void>) {
        try {
            await fn();
            console.log(`  ✅ ${name}`);
        } catch (e: any) {
            console.error(`  ❌ ${name}: ${e.message}`);
            process.exit(1);
        }
    }

    await test('should list installed plugins', async () => {
        const result = await toolManager.execute('list_plugins', {});
        expect(result).toHaveProperty('total', 2);
        const kanban = result.plugins.find((p: any) => p.id === 'obsidian-kanban');
        expect(kanban).toHaveProperty('enabled', true);
        const dataview = result.plugins.find((p: any) => p.id === 'dataview');
        expect(dataview).toHaveProperty('enabled', false);
    });

    await test('should get plugin commands', async () => {
        const result = await toolManager.execute('get_plugin_commands', { pluginId: 'obsidian-kanban' });
        expect(result).toHaveProperty('pluginId', 'obsidian-kanban');
        expect(result).toHaveProperty('count', 1);
        expect(result.commands[0]).toHaveProperty('id', 'obsidian-kanban:create-new-board');
    });

    await test('should not return commands for other plugins', async () => {
        const result = await toolManager.execute('get_plugin_commands', { pluginId: 'obsidian-kanban' });
        const commandIds = result.commands.map((c: any) => c.id);
        if (commandIds.includes('dataview:query')) {
            throw new Error('Should not include commands from other plugins');
        }
    });

    await test('get_plugin_settings should return settings for enabled plugin', async () => {
        const result = await toolManager.execute('get_plugin_settings', { pluginId: 'obsidian-kanban' });
        expect(result).toEqual({
            pluginId: 'obsidian-kanban',
            settings: { 'date-format': 'YYYY-MM-DD', 'folder': 'Kanban' }
        });
    });

    await test('web_search should return results', async () => {
        // Mock requestUrl global
        (global as any).mockRequestUrl = async () => ({
            text: `
                <div class="result__body">
                    <h2 class="result__title">
                        <a class="result__a" href="https://obsidian.md">Obsidian - Sharpen your thinking</a>
                    </h2>
                    <div class="result__snippet">
                        <a class="result__snippet" href="https://obsidian.md">Obsidian is the private and flexible writing app that adapts to the way you think.</a>
                    </div>
                </div>
            `
        });

        const result = await toolManager.execute('web_search', { query: 'obsidian' });
        expect(result.results).toBeDefined();
        expect(result.results.length).toBeGreaterThan(0);
        expect(result.results[0].title).toContain('Obsidian');
        expect(result.results[0].link).toBe('https://obsidian.md');
    });

    await test('get_current_time should return valid time object', async () => {
        const result = await toolManager.execute('get_current_time', {});
        expect(result).toHaveProperty('iso');
        expect(result).toHaveProperty('local');
        expect(result).toHaveProperty('weekday');
    });
}

runTests().catch(console.error);
