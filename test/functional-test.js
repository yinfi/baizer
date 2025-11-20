// test/mock-obsidian.ts
global.document = {
  getElementById: (id) => ({
    remove: () => {
    }
  })
};
var App = class {
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
};
var Vault = class {
  files = {};
  async read(file) {
    return this.files[file.path] || "";
  }
  async create(path, content) {
    this.files[path] = content;
    return { path, basename: path.replace(".md", "") };
  }
  getFiles() {
    return Object.keys(this.files).map((path) => ({
      path,
      basename: path.replace(".md", "")
    }));
  }
};
var Workspace = class {
  activeLeaf;
  events = {};
  getActiveFile() {
    return { path: "test-note.md", basename: "test-note" };
  }
  on(event, callback) {
    if (!this.events[event])
      this.events[event] = [];
    this.events[event].push(callback);
    return { detach: () => {
    } };
  }
};
var MetadataCache = class {
  getFirstLinkpathDest(path, sourcePath) {
    return { path: path.endsWith(".md") ? path : path + ".md" };
  }
};
var Commands = class {
  listCommands() {
    return [];
  }
  executeCommandById(id) {
    return true;
  }
};

// src/gemini-api.ts
var import_generative_ai = require("@google/generative-ai");

// test/obsidian-mock.ts
var MockHTMLElement = class {
  constructor(tagName = "div") {
    this.tagName = tagName;
  }
  children = [];
  classList = /* @__PURE__ */ new Set();
  style = {};
  value = "";
  scrollTop = 0;
  scrollHeight = 100;
  empty() {
    this.children = [];
  }
  addClass(cls) {
    this.classList.add(cls);
  }
  createDiv(attr) {
    return this.createEl("div", attr);
  }
  createSpan(attr) {
    return this.createEl("span", attr);
  }
  createEl(tag, attr) {
    const el = new MockHTMLElement(tag);
    this.children.push(el);
    return el;
  }
  addEventListener() {
  }
  focus() {
  }
  setText(text) {
  }
  remove() {
  }
};
var ItemView = class {
  constructor(leaf) {
    this.leaf = leaf;
    this.contentEl = new MockHTMLElement("div");
  }
  contentEl;
  getViewType() {
    return "test-view";
  }
  getDisplayText() {
    return "Test View";
  }
  getIcon() {
    return "test-icon";
  }
  async onOpen() {
  }
  async onClose() {
  }
  addAction() {
  }
};
var Notice = class {
  constructor(message, timeout) {
  }
};
var MarkdownRenderer = {
  render: (app, markdown, el, sourcePath, component) => {
  }
};

// src/gemini-api.ts
var GeminiAPI = class {
  constructor(settings, toolManager, mockModel2) {
    this.settings = settings;
    this.toolManager = toolManager;
    this.mockModel = mockModel2;
    if (settings.apiKey || mockModel2) {
      this.init();
    }
  }
  genAI;
  model;
  init() {
    if (this.mockModel) {
      this.model = this.mockModel;
      return;
    }
    this.genAI = new import_generative_ai.GoogleGenerativeAI(this.settings.apiKey);
    this.model = this.genAI.getGenerativeModel({
      model: this.settings.primaryModel,
      systemInstruction: this.settings.systemPrompt,
      tools: [{ functionDeclarations: this.toolManager.getToolsDefinitions() }]
    });
  }
  async testConnection() {
    try {
      this.init();
      const result = await this.model.generateContent("Hello");
      return !!result.response.text();
    } catch (e) {
      console.error(e);
      return false;
    }
  }
  // 处理完整的对话流程，包括 Function Calling
  async chat(userMessage, contextContext, selection = "") {
    if (!this.genAI && !this.mockModel) {
      new Notice("Gemini API Key not configured!");
      return "Error: API Key missing.";
    }
    let fullPrompt = `[Context: ${contextContext}]
`;
    if (selection) {
      fullPrompt += `[Selected Text: ${selection}]
`;
    }
    fullPrompt += `User Request: ${userMessage}`;
    try {
      const chat = this.model.startChat();
      let result = await chat.sendMessage(fullPrompt);
      let response = result.response;
      let functionCalls = response.functionCalls();
      if (functionCalls && functionCalls.length > 0) {
        for (const call of functionCalls) {
          const toolResult = await this.toolManager.execute(call.name, call.args);
          result = await chat.sendMessage([
            {
              functionResponse: {
                name: call.name,
                response: toolResult
              }
            }
          ]);
        }
        response = result.response;
      }
      return response.text();
    } catch (e) {
      console.error("Gemini Error:", e);
      return `Error: ${e.message}`;
    }
  }
};

// src/ui/shell-view.ts
var VIEW_TYPE_GEMINI_SHELL = "gemini-shell-view";
var GeminiShellView = class extends ItemView {
  api;
  outputContainer;
  inputEl;
  currentSelection = "";
  editor = null;
  constructor(leaf, api) {
    super(leaf);
    this.api = api;
  }
  getViewType() {
    return VIEW_TYPE_GEMINI_SHELL;
  }
  getDisplayText() {
    return "Gemini Shell";
  }
  getIcon() {
    return "terminal-square";
  }
  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gemini-shell-view");
    const header = contentEl.createDiv({ cls: "shell-header" });
    header.createSpan({ text: "GEMINI SHELL" });
    header.createSpan({ text: "\u25CF ONLINE", attr: { style: "color: #00e676;" } });
    this.outputContainer = contentEl.createDiv({ cls: "shell-output-area" });
    this.appendLog("System", "Kernel initialized.", "system");
    const inputContainer = contentEl.createDiv({ cls: "shell-input-container" });
    const promptIcon = inputContainer.createSpan({ cls: "shell-prompt" });
    promptIcon.setText(">_");
    this.inputEl = inputContainer.createEl("input", {
      cls: "shell-input",
      type: "text",
      attr: {
        placeholder: "Ask Gemini...",
        spellcheck: "false",
        autocomplete: "off"
      }
    });
    const footer = contentEl.createDiv({ cls: "shell-footer" });
    const createAction = (key, label) => {
      const item = footer.createDiv({ cls: "action-item" });
      item.createSpan({ cls: "key-badge", text: key });
      item.createSpan({ cls: "action-label", text: label });
    };
    createAction("\u21B5", "Send");
    createAction("Esc", "Clear");
    this.inputEl.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        if (e.isComposing)
          return;
        const query = this.inputEl.value.trim();
        if (!query)
          return;
        this.inputEl.value = "";
        await this.processCommand(query);
      }
      if (e.key === "Escape") {
        this.inputEl.value = "";
      }
    });
    contentEl.addEventListener("click", (e) => {
      if (window.getSelection()?.toString())
        return;
      this.inputEl.focus();
    });
  }
  async processCommand(query) {
    this.appendLog("You", query, "user");
    const activeLeaf = this.app.workspace.activeLeaf;
    let contextStr = "No active note.";
    this.currentSelection = "";
    if (activeLeaf && activeLeaf.view.getViewType() === "markdown") {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        contextStr = `Current Note: [[${activeFile.path}]]`;
      }
      const editor = activeLeaf.view.editor;
      if (editor) {
        this.editor = editor;
        this.currentSelection = editor.getSelection();
        if (this.currentSelection) {
          this.appendLog("System", `With selection (${this.currentSelection.length} chars)`, "system");
        }
      }
    }
    const loadingId = "loading-" + Date.now();
    const loadingDiv = this.outputContainer.createDiv({ cls: "shell-entry system" });
    loadingDiv.id = loadingId;
    loadingDiv.createSpan({ cls: "shell-loading" });
    loadingDiv.createSpan({ text: "Thinking..." });
    this.scrollToBottom();
    try {
      const response = await this.api.chat(query, contextStr, this.currentSelection);
      const loader = document.getElementById(loadingId);
      if (loader)
        loader.remove();
      if (query.startsWith("/edit") && this.editor && this.currentSelection) {
        this.editor.replaceSelection(response);
        this.appendLog("System", "Text replaced.", "system");
      } else {
        this.appendLog("Gemini", response, "ai");
      }
    } catch (e) {
      const loader = document.getElementById(loadingId);
      if (loader)
        loader.remove();
      this.appendLog("Error", e.message, "system");
    }
  }
  appendLog(author, content, type) {
    const entry = this.outputContainer.createDiv({ cls: `shell-entry ${type}` });
    if (type === "ai") {
      MarkdownRenderer.render(this.app, content, entry, "", this);
    } else if (type === "user") {
      entry.setText(content);
    } else {
      entry.setText(`[${author}] ${content}`);
    }
    this.scrollToBottom();
  }
  scrollToBottom() {
    this.outputContainer.scrollTop = this.outputContainer.scrollHeight;
  }
  async onClose() {
  }
};

// src/mcp/tools.ts
var import_generative_ai2 = require("@google/generative-ai");
var ToolManager = class {
  constructor(app, allowPluginControl) {
    this.app = app;
    this.allowPluginControl = allowPluginControl;
  }
  getToolsDefinitions() {
    const tools = [
      // 1. Read Note
      {
        name: "read_note",
        description: "Read the full content of a specific markdown note.",
        parameters: {
          type: import_generative_ai2.SchemaType.OBJECT,
          properties: {
            path: { type: import_generative_ai2.SchemaType.STRING, description: "The file path or wiki-link name" }
          },
          required: ["path"]
        }
      },
      // 2. Create Note
      {
        name: "create_note",
        description: "Create a new note with content.",
        parameters: {
          type: import_generative_ai2.SchemaType.OBJECT,
          properties: {
            filename: { type: import_generative_ai2.SchemaType.STRING, description: "Path/Filename.md" },
            content: { type: import_generative_ai2.SchemaType.STRING, description: "Markdown content" }
          },
          required: ["filename", "content"]
        }
      },
      // 3. Search
      {
        name: "search_vault",
        description: "Fuzzy search for files in the vault.",
        parameters: {
          type: import_generative_ai2.SchemaType.OBJECT,
          properties: {
            query: { type: import_generative_ai2.SchemaType.STRING }
          },
          required: ["query"]
        }
      }
    ];
    if (this.allowPluginControl) {
      tools.push({
        name: "execute_command",
        description: "Execute an Obsidian command ID.",
        parameters: {
          type: import_generative_ai2.SchemaType.OBJECT,
          properties: {
            id: { type: import_generative_ai2.SchemaType.STRING, description: "The command ID to run" }
          },
          required: ["id"]
        }
      });
      tools.push({
        name: "list_available_commands",
        description: "List commands matching a keyword to find their IDs.",
        parameters: {
          type: import_generative_ai2.SchemaType.OBJECT,
          properties: {
            keyword: { type: import_generative_ai2.SchemaType.STRING }
          },
          required: ["keyword"]
        }
      });
    }
    return tools;
  }
  async execute(name, args) {
    try {
      switch (name) {
        case "read_note":
          const file = this.app.metadataCache.getFirstLinkpathDest(args.path, "");
          if (!file)
            return { error: "File not found" };
          const content = await this.app.vault.read(file);
          return { path: file.path, content: content.substring(0, 5e3) };
        case "create_note":
          let path = args.filename;
          if (!path.endsWith(".md"))
            path += ".md";
          await this.app.vault.create(path, args.content);
          return { status: "success", message: `Created ${path}` };
        case "search_vault":
          const matches = this.app.vault.getFiles().filter((f) => f.basename.toLowerCase().includes(args.query.toLowerCase())).map((f) => f.path).slice(0, 5);
          return { matches };
        case "list_available_commands":
          if (!this.allowPluginControl)
            return { error: "Permission denied" };
          const cmds = this.app.commands.listCommands().filter((c) => c.name.toLowerCase().includes(args.keyword.toLowerCase())).map((c) => ({ id: c.id, name: c.name })).slice(0, 10);
          return { commands: cmds };
        case "execute_command":
          if (!this.allowPluginControl)
            return { error: "Permission denied" };
          const success = this.app.commands.executeCommandById(args.id);
          return { success, command_id: args.id };
        default:
          return { error: "Unknown tool" };
      }
    } catch (e) {
      return { error: e.message };
    }
  }
};

// src/mcp/types.ts
var DEFAULT_SETTINGS = {
  // Core
  apiKey: "",
  primaryModel: "gemini-2.5-flash",
  thinkingModel: "gemini-2.5-pro",
  contextWindow: 32e3,
  // Guardian
  enableGuardian: true,
  guardianSensitivity: 50,
  // Medium
  guardianUIStyle: "hybrid",
  ignoredFolders: "",
  privacyMode: false,
  // Permissions
  allowFileCreation: true,
  allowFileModification: false,
  allowPluginControl: false,
  confirmExecutions: true,
  // Terminal
  terminalTheme: "hacker-green",
  terminalFont: "JetBrains Mono",
  terminalFontSize: 14,
  terminalOpacity: 0.95,
  // Prompt
  customizePrompt: false,
  systemPrompt: "You are a command-line interface inside Obsidian. Be concise. Output valid Markdown."
};

// test/functional-test.ts
var mockModel = {
  startChat: () => ({
    sendMessage: async (msg) => {
      if (msg.includes("create a new note")) {
        return {
          response: {
            functionCalls: () => [{
              name: "create_note",
              args: { filename: "New Note.md", content: "# New Note Content" }
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
  generateContent: async () => ({ response: { text: () => "Hello" } })
};
async function runTests() {
  console.log("Starting Functional Tests...");
  const app = new App();
  const settings = { ...DEFAULT_SETTINGS, apiKey: "test-key" };
  const toolManager = new ToolManager(app, true);
  const api = new GeminiAPI(settings, toolManager, mockModel);
  const mockLeaf = {
    view: {
      getViewType: () => "markdown"
    }
  };
  const view = new GeminiShellView(mockLeaf, api);
  const createMockEl = () => ({
    empty: () => {
    },
    addClass: () => {
    },
    createDiv: () => createMockEl(),
    createSpan: () => createMockEl(),
    createEl: () => createMockEl(),
    setText: () => {
    },
    addEventListener: () => {
    },
    focus: () => {
    },
    value: "",
    scrollTop: 0,
    scrollHeight: 100,
    remove: () => {
    }
  });
  view.contentEl = createMockEl();
  view.app = app;
  await view.onOpen();
  console.log("\nTest 1: Testing /new command intent...");
  await view.processCommand("Please create a new note called 'New Note'");
  const fileContent = await app.vault.read({ path: "New Note.md" });
  if (fileContent === "# New Note Content") {
    console.log("\u2705 Test 1 Passed: Note created successfully.");
  } else {
    console.error("\u274C Test 1 Failed: Note content mismatch or not created.");
  }
  console.log("\nTest 2: Testing /edit command...");
  const mockEditor = {
    getSelection: () => "ORIGINAL CONTENT",
    replaceSelection: (text) => {
      console.log(`[Editor] Replaced selection with: ${text}`);
      if (text === "EDITED CONTENT") {
        console.log("\u2705 Test 2 Passed: Selection replaced correctly.");
      } else {
        console.error(`\u274C Test 2 Failed: Unexpected replacement text: ${text}`);
      }
    }
  };
  app.workspace.activeLeaf = {
    view: {
      getViewType: () => "markdown",
      editor: mockEditor
    }
  };
  await view.processCommand("/edit make this uppercase");
}
runTests().catch((e) => console.error(e));
