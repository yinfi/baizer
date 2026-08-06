import { Plugin } from "obsidian";
import { OntologyUpdateMode } from "../knowledge/types";
import { Locale } from "../i18n/zh";
import type { KnowledgeRuntime } from "../knowledge/runtime";
import type { ToolRegistry } from "../skills/tool-registry";

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

/**
 * OpenAI 兼容协议下的具体 API 端点方言。
 * - 'completions'（默认）: /v1/chat/completions —— 传统 Chat Completions API
 * - 'responses'         : /v1/responses        —— OpenAI Responses API
 * 二者在 pi-ai 里是两个独立 provider（openai-completions / openai-responses），
 * baseUrl 语义一致（都由 OpenAI SDK 追加端点路径），只是请求端点不同。
 * 仅对 type='openai-compatible' 有意义；缺省视为 'completions'，故不影响现有 provider。
 */
export type OpenAIApiFlavor = 'completions' | 'responses';

export interface ProviderConfig {
    type: ProviderType;
    label: string;
    apiKey: string;
    baseUrl: string;
    model: string;
    /** OpenAI 兼容协议的 API 端点方言；缺省 = 'completions'。见 OpenAIApiFlavor。 */
    apiFlavor?: OpenAIApiFlavor;
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
     * @deprecated 阶段A 起改用 sessionRefs(per-conversation)。保留字段仅供旧数据迁移。
     * 旧版全局单会话的引用。loadSettings 会把它迁移到 sessionRefs 的一个兜底键后不再写入。
     */
    sessionRef?: {
        id: string;
        path: string;
        createdAt: string;
        cwd: string;
    } | null;

    /**
     * 每个会话(conversationId = UI tab.id)的 session 引用,用于跨重启分别恢复各自的对话历史。
     * 由 HarnessSessionManager 经 saveRef 回调按 conversationId 写入,结构与 PersistedSessionRef 对齐。
     * 阶段A(per-conversation session 隔离)引入,取代全局单例 sessionRef。
     */
    sessionRefs?: Record<string, {
        id: string;
        path: string;
        createdAt: string;
        cwd: string;
    }>;

    // --- 🛡️ Guardian Behavior ---
    // 在编辑器中选中文字时是否弹出悬浮 AI 工具条（改写/解释等）。默认开；
    // 该功能独立于 Guardian 补全，用户可单独关闭以免选中即弹造成打扰。
    enableSelectionMenu: boolean;
    enableGuardian: boolean;
    guardianAutoMode: boolean; // New: Auto-trigger toggle
    guardianSensitivity: number;
    guardianUIStyle: 'ghost' | 'gutter' | 'hybrid';
    // 快补无果且用户停留时,自动升级到深补全(读笔记正文)。默认关——自动花钱路径需显式开启。
    guardianAutoDeepEscalation: boolean;
    ignoredFolders: string;
    privacyMode: boolean;
    // 记忆召回前用 LLM 把查询扩成同义词/跨语言译词再喂 BM25,补偿纯词法检索"同义/跨语言召不回"。
    // 每轮对话召回额外一次(带缓存+超时兜底)LLM 调用,故默认关——按需开启。仅作用于对话路径,不影响 Guardian 亚秒补全。
    memoryQueryExpansion: boolean;
    // 一跳实体图检索:BM25 种子命中后,把与种子共享实体的记忆(即便词法零重叠)以衰减分带出,提供关联上下文。
    // 纯内存、零 LLM 成本、带停用实体+上限防噪声,默认开。
    memoryGraphRecall: boolean;
    // 矛盾更新:同主题的新事实(改偏好/改名/换项目)退役旧事实,避免召回时新旧偏好并存。
    // 仅 world 单值主题、纯规则、退役只标记不删除(可恢复),默认开。
    memoryConflictUpdate: boolean;

    // --- ⚡ Permissions ---
    vaultWriteScope: VaultWriteScope;
    vaultWriteAllowedFolders: string[];
    allowFileCreation: boolean;
    allowFileModification: boolean;
    allowPluginControl: boolean;
    // 允许 AI 读取第三方插件配置原值；关闭时仅返回键名与类型，敏感字段始终脱敏。
    allowPluginConfigValues: boolean;
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

    // --- 🌐 Language ---
    // 界面语言：'auto' 跟随系统，'en' 英文，'zh' 中文。仅影响面向用户的 UI 文案，不影响 LLM prompt。
    language: Locale;

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
    enableSelectionMenu: true,
    enableGuardian: false,
    guardianAutoMode: true, // Default to true
    guardianSensitivity: 50,
    guardianUIStyle: 'hybrid',
    guardianAutoDeepEscalation: true,
    ignoredFolders: '',
    privacyMode: false,
    memoryQueryExpansion: false,
    memoryGraphRecall: true,
    memoryConflictUpdate: true,

    // Permissions
    vaultWriteScope: 'all-vault',
    vaultWriteAllowedFolders: [],
    allowFileCreation: true,
    allowFileModification: false,
    allowPluginControl: false,
    allowPluginConfigValues: false,
    confirmExecutions: true,

    // Skills（空 = 全部可用，零迁移成本）
    disabledSkills: [],

    // Terminal
    terminalTheme: 'hacker-green',
    terminalFont: 'JetBrains Mono',
    terminalFontSize: 14,
    terminalOpacity: 0.95,

    // Language（保持跟随系统，老用户零感知）
    language: 'auto',

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
    // 轻量落盘：仅写盘，不重建 provider/guardian/knowledge（纯 UI 字段用）。
    saveSettingsLight?(): Promise<void>;
    // 切换界面语言：设定 locale、落盘并即时重渲染所有打开的 ShellView。
    applyLanguageChange?(locale: Locale): Promise<void>;
    // 派生技能的管理入口（设置页读对账状态、重新生成、删除）。
    // 用最小结构类型而非 import PluginWatcher：types.ts 是底层模块，不该反向依赖 skills 层。
    pluginWatcher?: {
        getDerivedSkillStatuses(): any[];
        getGenerationFailures(): ReadonlyMap<string, string>;
        // 返回值不写 any：设置页据 regenerated / blocker 决定提示哪一种结局，
        // any 会让日后改字段名时静默退化成「每次成功都报失败」。
        // blocker 用字面量联合而非 import 那个类型别名：types.ts 不该反向依赖 skills 层。
        regenerateDerivedSkill(pluginId: string): Promise<
            | { regenerated: boolean; failureReason: string | null }
            | { blocker: 'auto-generate-off' | 'plugin-control-off' | 'model-not-ready'
                | 'source-missing' | 'source-excluded' }
        >;
        deleteDerivedSkill(pluginId: string): Promise<boolean>;
    } | null;
    knowledgeRuntime: KnowledgeRuntime | null;
    toolRegistry: ToolRegistry;
}
