import { App } from './mock-obsidian';
import { GeminiAPI } from '../src/gemini-api';
import { GeminiShellView } from '../src/ui/shell-view';
import { ToolManager } from '../src/mcp/tools';
import { GeminiSettings, DEFAULT_SETTINGS } from '../src/mcp/types';

// Mock Model
const mockModel = {
    startChat: () => ({
        sendMessage: async (msg: string) => {
            // Mock AI response logic
            if (msg.includes("create a new note")) {
                return {
                    response: {
                        functionCalls: () => [{
                            name: 'create_note',
                            args: { filename: 'New Note.md', content: '# New Note Content' }
                        }],
                        text: () => "I have created the note."
                    }
                };
            }
            if (msg.includes("/edit")) {
                return {
                    response: {
                        functionCalls: () => [],
                        text: () => "EDITED CONTENT"
                    }
                };
            }
            return {
                response: {
                    functionCalls: () => [],
                    text: () => "I am Gemini."
                }
            };
        }
    }),
} as any;

async function runTests() {
    console.log("Starting Functional Tests...");

    // 1. Setup Mocks
    const app = new App();
    const settings: GeminiSettings = { ...DEFAULT_SETTINGS, apiKey: 'test-key' };
    const toolManager = new ToolManager(app as any, true);
    const api = new GeminiAPI(app as any, settings, toolManager, mockModel);

    const mockLeaf = {
        view: null,
        app: app,
        open: async () => { },
        setViewState: async () => { }
    } as any;

    const view = new GeminiShellView(mockLeaf, api);

    // Helper to create a recursive mock element
    const createMockEl = () => ({
        empty: () => { },
        addClass: () => { },
        createDiv: () => createMockEl(),
        createSpan: () => createMockEl(),
        createEl: () => createMockEl(),
        setText: () => { },
        addEventListener: () => { },
        focus: () => { },
        value: '',
        scrollTop: 0,
        scrollHeight: 100,
        remove: () => { },
        appendChild: () => { }
    });

    // Patch contentEl for test
    (view as any).contentEl = createMockEl();

    // Mock app on view since it's usually injected by Obsidian
    (view as any).app = app;

    // Initialize UI
    await view.onOpen();

    // Test 1: /new command (via natural language intent)
    console.log("\nTest 1: Testing /new command intent...");
    await view.processCommand("Please create a new note called 'New Note'");
    // Verify file creation
    const fileContent = await app.vault.read({ path: 'New Note.md' } as any);
    if (fileContent === '# New Note Content') {
        console.log("✅ Test 1 Passed: Note created successfully.");
    } else {
        console.error("❌ Test 1 Failed: Note content mismatch or not created.");
    }

    // Test 2: /edit command
    console.log("\nTest 2: Testing /edit command...");
    const mockEditor = {
        getSelection: () => "make this uppercase",
        replaceSelection: (text: string) => {
            console.log(`Editor replaced selection with: ${text}`);
            if (text === "EDITED CONTENT") {
                console.log("✅ Test 2 Passed: Editor content updated.");
            } else {
                console.error("❌ Test 2 Failed: Unexpected replacement text.");
            }
        }
    };

    // Set active leaf to return this editor
    app.workspace.activeLeaf = {
        view: {
            getViewType: () => 'markdown',
            editor: mockEditor
        }
    } as any;

    await view.processCommand("/edit make this uppercase");
}

runTests().catch(e => console.error(e));
