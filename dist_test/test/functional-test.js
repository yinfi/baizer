"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mock_obsidian_1 = require("./mock-obsidian");
const gemini_api_1 = require("../src/gemini-api");
const shell_view_1 = require("../src/ui/shell-view");
const tools_1 = require("../src/mcp/tools");
const types_1 = require("../src/mcp/types");
// Mock Model
const mockModel = {
    startChat: () => ({
        sendMessage: async (msg) => {
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
};
async function runTests() {
    console.log("Starting Functional Tests...");
    // 1. Setup Mocks
    const app = new mock_obsidian_1.App();
    const settings = { ...types_1.DEFAULT_SETTINGS, apiKey: 'test-key' };
    const toolManager = new tools_1.ToolManager(app, true);
    const api = new gemini_api_1.GeminiAPI(app, settings, toolManager, mockModel);
    const mockLeaf = {
        view: null,
        app: app,
        open: async () => { },
        setViewState: async () => { }
    };
    const view = new shell_view_1.GeminiShellView(mockLeaf, api);
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
    view.contentEl = createMockEl();
    // Mock app on view since it's usually injected by Obsidian
    view.app = app;
    // Initialize UI
    await view.onOpen();
    // Test 1: /new command (via natural language intent)
    console.log("\nTest 1: Testing /new command intent...");
    await view.processCommand("Please create a new note called 'New Note'");
    // Verify file creation
    const fileContent = await app.vault.read({ path: 'New Note.md' });
    if (fileContent === '# New Note Content') {
        console.log("✅ Test 1 Passed: Note created successfully.");
    }
    else {
        console.error("❌ Test 1 Failed: Note content mismatch or not created.");
    }
    // Test 2: /edit command
    console.log("\nTest 2: Testing /edit command...");
    const mockEditor = {
        getSelection: () => "make this uppercase",
        replaceSelection: (text) => {
            console.log(`Editor replaced selection with: ${text}`);
            if (text === "EDITED CONTENT") {
                console.log("✅ Test 2 Passed: Editor content updated.");
            }
            else {
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
    };
    await view.processCommand("/edit make this uppercase");
}
runTests().catch(e => console.error(e));
