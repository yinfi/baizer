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

// --- Provider 配置 ---
export type ProviderType = 'gemini' | 'openai-compatible';

export interface ProviderConfig {
    type: ProviderType;
    label: string;
    apiKey: string;
    baseUrl: string;
    model: string;
}

export const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
    'gemini': {
        type: 'gemini',
        label: 'Google Gemini',
        apiKey: '',
        baseUrl: '',
        model: 'gemini-2.5-flash'
    },
    'openai': {
        type: 'openai-compatible',
        label: 'OpenAI',
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o'
    },
    'deepseek': {
        type: 'openai-compatible',
        label: 'DeepSeek',
        apiKey: '',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat'
    },
    'qwen': {
        type: 'openai-compatible',
        label: 'Qwen',
        apiKey: '',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-turbo'
    }
};

/** 内置 provider key，不可被用户删除 */
export const BUILTIN_PROVIDER_KEYS = Object.keys(DEFAULT_PROVIDERS);

export interface PluginSettings {
    // --- 🤖 Core Connection ---
    activeProvider: string;
    providers: Record<string, ProviderConfig>;
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

    // --- 📚 Knowledge Compiler ---
    knowledgeSourceFolders: string[];
    knowledgeAutoCompile: boolean;
    knowledgeWikiFolder: string;
    knowledgeMaxCompileBatch: number;

    // --- 🔌 Plugin Skill Generator ---
    autoGeneratePluginSkills: boolean;
    pluginSkillExcludeList: string[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
    // Core
    activeProvider: 'gemini',
    providers: { ...DEFAULT_PROVIDERS },
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

你是用户的个人 AI 助手，拥有用户的笔记库和知识库。
回答实质性问题前，先查询用户的知识库和笔记，基于用户的实际情况给出个性化回答。
不要凭空生成通用内容。如果知识库中没有相关内容，正常回答即可。
直接操作笔记（读写搜索）时优先使用 vault 工具。
当用户请求明显匹配某个 workflow skill 时，先调用 use_skill 获取该场景的 instructions。
调用 use_skill 后，请立即按照返回的 instructions 使用相应工具完成任务，不要只描述步骤。`,

    // WeChat
    wechatInboxPath: 'Inbox.md',
    wechatStoragePath: 'Clippings',

    // Knowledge Compiler
    knowledgeSourceFolders: [],
    knowledgeAutoCompile: false,
    knowledgeWikiFolder: 'Knowledge Wiki',
    knowledgeMaxCompileBatch: 50,

    // Plugin Skill Generator
    autoGeneratePluginSkills: true,
    pluginSkillExcludeList: []
};

export interface IPlugin extends Plugin {
    settings: PluginSettings;
    modelService: any;
    saveSettings(): Promise<void>;
}
