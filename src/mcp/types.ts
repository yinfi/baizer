import { Plugin } from "obsidian";
import { OntologyUpdateMode } from "../knowledge/types";

// ===== 品牌配置 — 改名只需改这里 =====
export const PLUGIN_ID = 'baizer';
export const PLUGIN_NAME = 'Baizer';
export const VIEW_TYPE_SHELL = `${PLUGIN_ID}-shell-view`;
export const MEMORY_DIR = `.obsidian/${PLUGIN_ID}-memory`;
export const PLUGIN_DATA_DIR = `.obsidian/${PLUGIN_ID}`;

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

export type VaultWriteScope =
    | 'read-only'
    | 'current-note'
    | 'configured-folders'
    | 'all-vault';

export interface PluginSettings {
    // --- 🤖 Core Connection ---
    activeProvider: string;
    providers: Record<string, ProviderConfig>;
    deletedProviderIds: string[];
    contextWindow: number;

    // --- 💾 Session Persistence ---
    /**
     * 当前活跃会话的引用，用于跨重启恢复持久化的对话历史。
     * 由 SessionStore 写入，结构与 PersistedSessionRef 对齐。运行期可选。
     */
    sessionRef?: {
        id: string;
        path: string;
        createdAt: string;
        cwd: string;
    } | null;

    // --- 🛡️ Guardian Behavior ---
    enableGuardian: boolean;
    guardianAutoMode: boolean; // New: Auto-trigger toggle
    guardianSensitivity: number;
    guardianUIStyle: 'ghost' | 'gutter' | 'hybrid';
    // 快补无果且用户停留时,自动升级到深补全(读笔记正文)。默认关——自动花钱路径需显式开启。
    guardianAutoDeepEscalation: boolean;
    ignoredFolders: string;
    privacyMode: boolean;

    // --- ⚡ Permissions ---
    vaultWriteScope: VaultWriteScope;
    vaultWriteAllowedFolders: string[];
    allowFileCreation: boolean;
    allowFileModification: boolean;
    allowPluginControl: boolean;
    confirmExecutions: boolean;

    // --- 🧩 Skills ---
    // Skill 可用性（discoverability），与 ⚡ Permissions（安全性）正交。
    // 存放被用户显式禁用的 skill name；空数组 = 全部可用。
    // 一个 skill 是否可用只由此决定；它暴露的工具能否执行/要不要批由 Permissions 决定。
    disabledSkills: string[];

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
    knowledgeOntologyEnabled: boolean;
    knowledgeOntologyUpdateMode: OntologyUpdateMode;
    knowledgeOntologyMinArticles: number;
    knowledgeOntologyMinTopicFrequency: number;
    knowledgeOntologyMinConceptFrequency: number;
    knowledgeOntologyAutoRecompileStale: boolean;

    // --- 🧠 Thinking Level ---
    /**
     * 控制模型推理深度（thinking / reasoning token 用量）。
     * "off"     — 关闭 thinking，最省 token，适合简单补全。
     * "minimal" — 最低档 thinking，极少 token 开销。
     * "low"     — 低档，轻度推理。
     * "medium"  — 中档，默认推荐值。
     * "high"    — 高档，复杂任务。
     * "xhigh"   — 最高档，仅部分模型支持。
     */
    thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

    // --- 🔌 Plugin Skill Generator ---
    autoGeneratePluginSkills: boolean;
    pluginSkillExcludeList: string[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
    // Core
    activeProvider: 'gemini',
    providers: { ...DEFAULT_PROVIDERS },
    deletedProviderIds: [],
    contextWindow: 100000,

    // Guardian
    enableGuardian: false,
    guardianAutoMode: true, // Default to true
    guardianSensitivity: 50,
    guardianUIStyle: 'hybrid',
    guardianAutoDeepEscalation: false,
    ignoredFolders: '',
    privacyMode: false,

    // Permissions
    vaultWriteScope: 'all-vault',
    vaultWriteAllowedFolders: [],
    allowFileCreation: true,
    allowFileModification: false,
    allowPluginControl: false,
    confirmExecutions: true,

    // Skills（空 = 全部可用，零迁移成本）
    disabledSkills: [],

    // Terminal
    terminalTheme: 'hacker-green',
    terminalFont: 'JetBrains Mono',
    terminalFontSize: 14,
    terminalOpacity: 0.95,

    // Prompt
    customizePrompt: false,
    systemPrompt: `You are Baizer, an AI knowledge workbench inside Obsidian. Be concise. Output valid Markdown.

你是用户的个人 AI 助手，拥有用户的笔记库和知识库。
回答实质性问题前，先查询用户的知识库和笔记，基于用户的实际情况给出个性化回答。
不要凭空生成通用内容。如果知识库中没有相关内容，正常回答即可。
直接操作笔记（读写搜索）时优先使用 vault 工具。
当任务匹配 <available_skills> 里某个 skill 的描述时，先用 read_skill 读取该 skill 的完整指令，再遵循指令与可用工具完成任务。`,

    // WeChat
    wechatInboxPath: 'Inbox.md',
    wechatStoragePath: 'Clippings',

    // Knowledge Compiler
    knowledgeSourceFolders: [],
    knowledgeAutoCompile: false,
    knowledgeWikiFolder: 'Knowledge Wiki',
    knowledgeMaxCompileBatch: 50,
    knowledgeOntologyEnabled: true,
    knowledgeOntologyUpdateMode: 'suggest',
    knowledgeOntologyMinArticles: 10,
    knowledgeOntologyMinTopicFrequency: 3,
    knowledgeOntologyMinConceptFrequency: 2,
    knowledgeOntologyAutoRecompileStale: false,

    // Thinking Level
    thinkingLevel: 'medium',

    // Plugin Skill Generator
    autoGeneratePluginSkills: true,
    pluginSkillExcludeList: []
};

export function mergeProviderDefaults(
    providers: Record<string, ProviderConfig> = {},
    deletedProviderIds: string[] = []
): Record<string, ProviderConfig> {
    const deleted = new Set(deletedProviderIds);
    const merged: Record<string, ProviderConfig> = { ...providers };

    for (const [id, defaultConfig] of Object.entries(DEFAULT_PROVIDERS)) {
        if (!merged[id] && !deleted.has(id)) {
            merged[id] = { ...defaultConfig };
        }
    }

    return merged;
}

export interface IPlugin extends Plugin {
    settings: PluginSettings;
    modelService: any;
    saveSettings(): Promise<void>;
}
