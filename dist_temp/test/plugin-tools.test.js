"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tools_1 = require("../src/mcp/tools");
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
        getPlugin: (id) => {
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
            { id: 'obsidian-kanban:create-new-board', name: 'Create new board' },
            { id: 'dataview:query', name: 'Dataview Query' },
            { id: 'editor:toggle-bold', name: 'Toggle bold' }
        ],
        executeCommandById: (id) => {
            console.log(`Executed: ${id}`);
            return true;
        }
    }
};
async function runTests() {
    console.log('Plugin Tools Integration Test');
    const toolManager = new tools_1.ToolManager(mockApp, true);
    async function test(name, fn) {
        try {
            await fn();
            console.log(`  ✅ ${name}`);
        }
        catch (e) {
            console.error(`  ❌ ${name}: ${e.message}`);
        }
    }
    function expect(actual) {
        return {
            toBe: (expected) => {
                if (actual !== expected)
                    throw new Error(`Expected "${expected}" but got "${actual}"`);
            },
            toContain: (expected) => {
                if (Array.isArray(actual)) {
                    if (!actual.includes(expected))
                        throw new Error(`Expected array to contain "${expected}"`);
                }
                else if (typeof actual === 'string') {
                    if (!actual.includes(expected))
                        throw new Error(`Expected string to contain "${expected}"`);
                }
            },
            toHaveProperty: (prop, value) => {
                if (actual[prop] === undefined)
                    throw new Error(`Expected object to have property ${prop}`);
                if (value !== undefined && actual[prop] !== value)
                    throw new Error(`Expected property ${prop} to be ${value} but got ${actual[prop]}`);
            }
        };
    }
    await test('should list installed plugins', async () => {
        const result = await toolManager.execute('list_plugins', {});
        expect(result).toHaveProperty('total', 2);
        const kanban = result.plugins.find((p) => p.id === 'obsidian-kanban');
        expect(kanban).toHaveProperty('enabled', true);
        const dataview = result.plugins.find((p) => p.id === 'dataview');
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
        const commandIds = result.commands.map((c) => c.id);
        if (commandIds.includes('dataview:query')) {
            throw new Error('Should not include commands from other plugins');
        }
    });
    await test('should get plugin settings', async () => {
        const result = await toolManager.execute('get_plugin_settings', { pluginId: 'obsidian-kanban' });
        expect(result).toHaveProperty('pluginId', 'obsidian-kanban');
        expect(result.settings).toHaveProperty('folder', 'Kanban');
    });
}
runTests().catch(console.error);
