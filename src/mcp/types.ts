import { Plugin } from "obsidian";

// ===== 品牌配置 — 改名只需改这里 =====
export const PLUGIN_ID = 'obsidian-cli';
export const PLUGIN_NAME = 'Obsidian CLI';
export const PLUGIN_PREFIX = 'obsidian-cli';
export const VIEW_TYPE_SHELL = `${PLUGIN_ID}-shell-view`;
export const MEMORY_DIR = `.obsidian/${PLUGIN_ID}-memory`;
export const CSS_PREFIX = 'ocli';

declare module "obsidian" {
    interface App {
        plugins: {
            manifests: Record<string, PluginManifest>;
            enabledPlugins: Set<string>;
            getPlugin(id: string): any;
        };
        commands: {
            listCommands(): Command[];
            executeCommandById(id: string): boolean;
        };
    }
}

export interface PluginSettings {
    // --- 🤖 Core Connection ---
    provider: 'gemini' | 'openai' | 'deepseek' | 'qwen';
    apiKey: string;
    primaryModel: string;

    // OpenAI Compatible
    openaiApiKey: string;
    openaiBaseUrl: string;
    openaiModel: string;

    // DeepSeek
    deepseekApiKey: string;
    deepseekBaseUrl: string;
    deepseekModel: string;

    // Qwen
    qwenApiKey: string;
    qwenBaseUrl: string;
    qwenModel: string;

    thinkingModel: string;
    contextWindow: number;

    // --- 🛡️ Guardian Behavior ---
    enableGuardian: boolean;
    guardianAutoMode: boolean; // New: Auto-trigger toggle
    guardianSensitivity: number;
    guardianUIStyle: 'ghost' | 'gutter' | 'hybrid';
    ignoredFolders: string;
    privacyMode: boolean;

    // --- ⚡ Permissions ---
    allowFileCreation: boolean;
    allowFileModification: boolean;
    allowPluginControl: boolean;
    confirmExecutions: boolean;

    // --- 🖥️ Terminal Appearance ---
    terminalTheme: 'hacker-green' | 'cyberpunk' | 'obsidian-native';
    terminalFont: string;
    terminalFontSize: number;
    terminalOpacity: number;

    // --- 🧠 System Prompt ---
    customizePrompt: boolean;
    systemPrompt: string;

    // --- 📨 WeChat Inbox ---
    wechatInboxPath: string;
    wechatStoragePath: string;

    // --- 🔌 MCP Servers ---
    mcpServers: Record<string, { command: string; args: string[] }>;

    // --- 📚 Knowledge Compiler ---
    knowledgeSourceFolders: string[];
    knowledgeAutoCompile: boolean;
    knowledgeWikiFolder: string;
    knowledgeMaxCompileBatch: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
    // Core
    provider: 'gemini',
    apiKey: '',
    primaryModel: 'gemini-2.5-flash',

    openaiApiKey: '',
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiModel: 'gpt-4o',

    deepseekApiKey: '',
    deepseekBaseUrl: 'https://api.deepseek.com',
    deepseekModel: 'deepseek-chat',

    qwenApiKey: '',
    qwenBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    qwenModel: 'qwen-turbo',

    thinkingModel: 'gemini-2.5-pro',
    contextWindow: 100000,

    // Guardian
    enableGuardian: false,
    guardianAutoMode: true, // Default to true
    guardianSensitivity: 50,
    guardianUIStyle: 'hybrid',
    ignoredFolders: '',
    privacyMode: false,

    // Permissions
    allowFileCreation: true,
    allowFileModification: false,
    allowPluginControl: false,
    confirmExecutions: true,

    // Terminal
    terminalTheme: 'hacker-green',
    terminalFont: 'JetBrains Mono',
    terminalFontSize: 14,
    terminalOpacity: 0.95,

    // Prompt
    customizePrompt: false,
    systemPrompt: `You are a command-line interface inside Obsidian. Be concise. Output valid Markdown.
    
IMPORTANT: Before creating a generic note for tasks, reminders, calendars, or other specialized content, ALWAYS check if a specialized plugin is installed using 'list_plugins'.
- If a relevant plugin is found (e.g., "obsidian-tasks-plugin", "obsidian-kanban", "reminder"), use 'get_plugin_commands' to find the appropriate command and execute it.
- If you need to know how a plugin is configured (e.g. default folder), use 'get_plugin_settings'.
- Only create a generic Markdown note if no suitable plugin is available or if the user explicitly asks for a note.

You have access to the internet via the 'web_search' tool. Use it to find up-to-date information, news, or documentation when the user asks for information not present in their vault.

你有一个个人知识库可用。当用户的问题可能与你之前积累的知识相关时，
使用 query_knowledge 工具查阅知识库。
如果知识库中没有相关内容，正常回答即可，不要强行引用。
知识库检索不足时，可以用 search_vault 搜索整个 vault 补充。

引用规则：如果你的回答引用了知识库中的文章，必须在回答末尾添加"---"分隔线，
然后列出引用来源，格式为：
---
📚 引用来源：
- [[文章路径|文章标题]]
每篇引用的文章都要列出。未引用知识库时不要添加此部分。

当你的回答综合了多个知识来源、产出了有价值的新洞察或对比分析时，
使用 file_back_knowledge 工具将回答归档到知识库。
不要对简单的事实查询做回填，只回填有综合价值的内容。
注意：如果用户对回答点赞，无论你的判断如何都执行回填；
如果用户点踩，则不回填。用户反馈优先于你的判断。`,

    // WeChat
    wechatInboxPath: 'Inbox.md',
    wechatStoragePath: 'Clippings',

    // MCP
    mcpServers: {},

    // Knowledge Compiler
    knowledgeSourceFolders: [],
    knowledgeAutoCompile: false,
    knowledgeWikiFolder: 'Knowledge Wiki',
    knowledgeMaxCompileBatch: 50
};

export interface IPlugin extends Plugin {
    settings: PluginSettings;
    modelService: any;
    saveSettings(): Promise<void>;
}