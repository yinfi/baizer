"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tools_1 = require("../src/mcp/tools");
// Simple Test Runner
async function runTests() {
    console.log('MCP Tools Integration Test');
    let toolManager;
    let mockApp;
    function setup() {
        // Mock Obsidian App
        mockApp = {
            vault: {
                getFiles: () => [
                    { path: 'test.md', basename: 'test' },
                    { path: 'notes/example.md', basename: 'example' }
                ],
                create: async (path, content) => {
                    console.log(`Created: ${path}`);
                    return { path };
                },
                read: async (file) => {
                    return '# Test Content\nThis is a test note.';
                },
                getAbstractFileByPath: (path) => {
                    if (path === 'test.md')
                        return { path: 'test.md' };
                    return null;
                }
            },
            metadataCache: {
                getFirstLinkpathDest: (path) => {
                    if (path === 'test.md') {
                        return { path: 'test.md' };
                    }
                    return null;
                }
            },
            commands: {
                listCommands: () => [
                    { id: 'test-command', name: 'Test Command' },
                    { id: 'another-command', name: 'Another Command' }
                ],
                executeCommandById: (id) => {
                    console.log(`Executed: ${id}`);
                    return true;
                }
            }
        };
        toolManager = new tools_1.ToolManager(mockApp, true);
    }
    async function test(name, fn) {
        setup(); // Run setup before each test
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
                    throw new Error(`Expected ${expected} but got ${actual}`);
            },
            toBeGreaterThanOrEqual: (expected) => {
                if (actual < expected)
                    throw new Error(`Expected >= ${expected} but got ${actual}`);
            },
            toBeGreaterThan: (expected) => {
                if (actual <= expected)
                    throw new Error(`Expected > ${expected} but got ${actual}`);
            },
            toContain: (expected) => {
                if (!actual.includes(expected))
                    throw new Error(`Expected ${actual} to contain ${expected}`);
            },
            toHaveProperty: (prop) => {
                if (actual[prop] === undefined)
                    throw new Error(`Expected object to have property ${prop}`);
            }
        };
    }
    await test('should have correct tool definitions', async () => {
        const tools = toolManager.getToolsDefinitions();
        expect(tools.length).toBeGreaterThanOrEqual(3);
        const toolNames = tools.map(t => t.name);
        expect(toolNames).toContain('read_note');
        expect(toolNames).toContain('create_note');
        expect(toolNames).toContain('search_vault');
    });
    await test('should execute read_note successfully', async () => {
        const result = await toolManager.execute('read_note', { path: 'test.md' });
        expect(result).toHaveProperty('path');
        expect(result).toHaveProperty('content');
        expect(result.content).toContain('Test Content');
    });
    await test('should execute create_note successfully', async () => {
        const result = await toolManager.execute('create_note', {
            filename: 'new-note',
            content: '# New Note\nContent here'
        });
        expect(result.status).toBe('success');
        expect(result.message).toContain('new-note.md');
    });
    await test('should execute search_vault successfully', async () => {
        const result = await toolManager.execute('search_vault', { query: 'test' });
        expect(result).toHaveProperty('matches');
        expect(Array.isArray(result.matches)).toBe(true);
        expect(result.matches.length).toBeGreaterThan(0);
    });
    await test('should execute list_available_commands when allowed', async () => {
        const result = await toolManager.execute('list_available_commands', { keyword: 'test' });
        expect(result).toHaveProperty('commands');
        expect(Array.isArray(result.commands)).toBe(true);
    });
    await test('should execute command when allowed', async () => {
        const result = await toolManager.execute('execute_command', { id: 'test-command' });
        expect(result.success).toBe(true);
        expect(result.command_id).toBe('test-command');
    });
    await test('should deny plugin control when not allowed', async () => {
        const restrictedManager = new tools_1.ToolManager(mockApp, false);
        const result = await restrictedManager.execute('list_available_commands', { keyword: 'test' });
        expect(result.error).toBe('Permission denied');
    });
    await test('should handle unknown tools gracefully', async () => {
        const result = await toolManager.execute('unknown_tool', {});
        expect(result.error).toBe('Unknown tool');
    });
}
runTests().catch(console.error);
