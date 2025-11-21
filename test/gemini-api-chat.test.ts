import { GeminiSettings, DEFAULT_SETTINGS } from '../src/mcp/types';
import { GeminiAPI } from '../src/gemini-api';
import { ToolManager } from '../src/mcp/tools';
import { App } from 'obsidian';

// Mock Obsidian App
const mockApp = {
    vault: {
        getFiles: () => [],
        create: async () => { },
        read: async () => ""
    },
    metadataCache: {
        getFirstLinkpathDest: () => null
    }
} as unknown as App;

// Mock Settings
const mockSettings: GeminiSettings = {
    ...DEFAULT_SETTINGS,
    apiKey: 'test-key',
    primaryModel: 'gemini-pro',
    systemPrompt: 'You are a helper.'
};

// Mock ToolManager
class MockToolManager extends ToolManager {
    constructor() {
        super(mockApp, true);
    }
    getToolsDefinitions() { return []; }
    async execute(name: string, args: any) {
        return `Executed ${name} with ${JSON.stringify(args)}`;
    }
}

// Mock GenerativeModel
class MockModel {
    private responses: any[] = [];
    private callCount = 0;

    constructor(responses: any[]) {
        this.responses = responses;
    }

    startChat() {
        return {
            sendMessage: async (msg: any) => {
                const response = this.responses[this.callCount] || { text: () => "No more mock responses" };
                this.callCount++;
                return {
                    response: {
                        functionCalls: () => response.functionCalls || [],
                        text: () => response.text || ""
                    }
                };
            }
        };
    }
}

async function runTests() {
    console.log('GeminiAPI Chat Logic Tests');

    async function test(name: string, fn: () => Promise<void>) {
        try {
            await fn();
            console.log(`  ✅ ${name}`);
        } catch (e: any) {
            console.error(`  ❌ ${name}: ${e.message}`);
        }
    }

    function expect(actual: any) {
        return {
            toBe: (expected: any) => {
                if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
            },
            toContain: (expected: string) => {
                if (!actual.includes(expected)) throw new Error(`Expected "${actual}" to contain "${expected}"`);
            }
        };
    }

    await test('should handle simple text response', async () => {
        const mockModel = new MockModel([
            { text: "Hello world", functionCalls: [] }
        ]);
        const api = new GeminiAPI(mockApp, mockSettings, new MockToolManager(), mockModel);
        const response = await api.chat("Hi", "");
        expect(response).toBe("Hello world");
    });

    await test('should handle single function call', async () => {
        const mockModel = new MockModel([
            {
                text: "",
                functionCalls: [{ name: "test_tool", args: { foo: "bar" } }]
            },
            { text: "Tool executed", functionCalls: [] }
        ]);
        const api = new GeminiAPI(mockApp, mockSettings, new MockToolManager(), mockModel);
        const response = await api.chat("Use tool", "");
        expect(response).toBe("Tool executed");
    });

    await test('should handle chained function calls', async () => {
        const mockModel = new MockModel([
            {
                text: "",
                functionCalls: [{ name: "tool_1", args: {} }]
            },
            {
                text: "",
                functionCalls: [{ name: "tool_2", args: {} }]
            },
            { text: "All done", functionCalls: [] }
        ]);
        const api = new GeminiAPI(mockApp, mockSettings, new MockToolManager(), mockModel);
        const response = await api.chat("Do complex task", "");
        expect(response).toBe("All done");
    });

    await test('should stop after max loops', async () => {
        // Create an infinite loop of function calls
        const infiniteResponses = Array(15).fill({
            text: "",
            functionCalls: [{ name: "loop_tool", args: {} }]
        });
        const mockModel = new MockModel(infiniteResponses);
        const api = new GeminiAPI(mockApp, mockSettings, new MockToolManager(), mockModel);

        const response = await api.chat("Start loop", "");
        // Should return the fallback message
        expect(response).toContain("finished the requested tasks, but I cannot generate a text summary");
    });
}

runTests().catch(console.error);
