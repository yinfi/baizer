import { Plugin } from "obsidian";
import { OntologyUpdateMode } from "../knowledge/types";
import { Locale } from "../i18n/zh";
import type { KnowledgeRuntime } from "../knowledge/runtime";
import type { ToolRegistry } from "../skills/tool-registry";
import type { ModelService } from "../services/model-service";

// ===== 品牌配置 — 改名只需改这里 =====
export const PLUGIN_ID = 'baizer';
export const PLUGIN_NAME = 'Baizer';
export const VIEW_TYPE_SHELL = `${PLUGIN_ID}-shell-view`;
export const MEMORY_DIR = `.obsidian/${PLUGIN_ID}-memory`;
export const PLUGIN_DATA_DIR = `.obsidian/${PLUGIN_ID}`;

declare module "obsidian" {
    interface App {
        /** Obsidian 未公开：插件宿主。getPlugin 返回第三方插件实例，形状由各插件自定义（外部数据）。 */
        plugins: {
            manifests: Record<string, PluginManifest>;
            enabledPlugins: Set<string>;
            getPlugin(id: string): any;
        };
        commands: {
            listCommands(): Command[];
            executeCommandById(id: string): boolean;
        };
        /**
         * Obsidian 未公开：设置面板宿主。只声明实际用到的成员。
         * 热键页签在 openTabById('hotkeys') 之后才有 activeTab。
         */
        setting: {
            open(): void;
            openTabById(id: string): void;
            activeTab: { setQuery(query: string): void };
        };
        /** Obsidian 未公开：核心插件（bases 等）的开关状态。 */
        internalPlugins?: {
            plugins?: Record<string, { enabled: boolean } | undefined>;
        };
    }
    interface MetadataCache {
        /** Obsidian 未公开：是否已完成首次索引（未初始化时 `resolved` 事件才是可靠信号）。 */
        initialized?: boolean;
    }
}

// --- Provider 配置 ---
/**
 * provider 使用的线协议（wire protocol）。
 * - 'openai-compatible' : OpenAI 兼容接口，端点方言由 apiFlavor 决定
 * - 'anthropic'         : Anthropic 原生 Messages 协议（api = 'anthropic-messages'，
 *                         POST {baseUrl}/v1/messages，认证头 x-api-key + anthropic-version）
 *
 * 两种协议各自独立，互不伪装：anthropic 不是 openai-compatible 的一个 flavor。
 *
 * 历史上还有第三种 'gemini'（Google Generative AI），已被移除 —— 它会把
 * @google/genai 与 pi-ai 的 google-generative-ai api 拖进单文件 bundle，而
 * Obsidian Sync Standard 不同步超过 5MB 的文件。见 pruneUnsupportedProviders。
 */
export type ProviderType = 'openai-compatible' | 'anthropic';

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
    /**
     * 服务地址（Base URL）——**不含端点路径**，端点由各协议 SDK/实现自行追加。
     * - openai-compatible : OpenAI SDK 的 baseURL，SDK 追加 /chat/completions 或 /responses
     * - anthropic         : Anthropic SDK 的 baseURL，SDK 追加 /v1/messages
     *                       （故官方端点写 https://api.anthropic.com，不要再带 /v1）
     */
    baseUrl: string;
    model: string;
    /** OpenAI 兼容协议的 API 端点方言；缺省 = 'completions'。见 OpenAIApiFlavor。仅对 type='openai-compatible' 有意义。 */
    apiFlavor?: OpenAIApiFlavor;
    /**
     * 随每次 LLM 请求附带的自定义 header（某些 OpenAI 兼容端点要求的非标准 header，
     * 如 opencode.ai Go 网关的 x-opencode-session）。
     * 值支持 {{conversationId}} 占位符，运行时替换为当前对话的稳定会话 ID；
     * 无 conversationId 的一次性调用（/edit、file-back 等）会整体跳过含该占位符的 header。
     */
    customHeaders?: Record<string, string>;
}

export const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
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
    },
    'anthropic': {
        type: 'anthropic',
        label: 'Anthropic',
        apiKey: '',
        // 官方端点不带 /v1：Anthropic SDK 会自行追加 /v1/messages。
        // 兼容网关（实现 Anthropic Messages 协议）改这里即可。
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5'
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

    // --- 🎧 Video Transcription (ASR) ---
    /**
     * 转写端点（Base URL，**不含端点路径**，插件追加 /audio/transcriptions）。
     * 留空 = 沿用当前 provider 的 baseUrl，但仅当它是 openai-compatible ——
     * Anthropic 的地址上没有 /audio/transcriptions，回退过去只会得到 404。
     * 只配了 Anthropic 的用户在这里填一个 OpenAI 方言的转写服务即可转写。
     */
    asrBaseUrl: string;
    /** 转写端点的 API Key。留空 = 沿用当前 provider 的 apiKey（回环/自建服务通常不需要）。 */
    asrApiKey: string;
    /** 转写模型。留空 = 'whisper-1'（改动前写死的值）。 */
    asrModel: string;
    /** 音频语言（ISO-639-1，如 'zh' / 'en'）。留空 = 交给端点自动判断。 */
    asrLanguage: string;

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

/** 转写模型的内置默认值。改动前它被写死在 video-transcription.ts 里。 */
export const DEFAULT_ASR_MODEL = 'whisper-1';

export const DEFAULT_SETTINGS: PluginSettings = {
    // Core
    // 'openai' 是 DEFAULT_PROVIDERS 的第一项：'gemini' 被移除后它就是新的出厂默认。
    activeProvider: 'openai',
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

    // Video transcription (ASR)
    // 两个空串 + 空模型 = 与改动前完全一致的行为：沿用 provider 的地址与 key，模型 whisper-1。
    // 既有 OpenAI 兼容用户不需要做任何事；只配 Anthropic 的用户填上 asrBaseUrl 即可转写。
    asrBaseUrl: '',
    asrApiKey: '',
    asrModel: DEFAULT_ASR_MODEL,
    asrLanguage: '',

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

/**
 * 判断一个持久化配置里的 provider.type 是否仍受支持。
 *
 * 入参刻意收成 unknown：它直接面对 data.json 的内容，可能是历史类型、
 * 拼错的值或干脆不是字符串，调用方不该为了调用它先做一次不安全的断言。
 */
export function isSupportedProviderType(type: unknown): type is ProviderType {
    return type === 'openai-compatible' || type === 'anthropic';
}

/**
 * 丢弃协议已不支持的 provider 条目（历史上 type:'gemini' 的配置是主要来源）。
 *
 * 为什么是「丢弃」而不是「留着」：留下的条目会在 ModelService.buildModelForConfig
 * 的 default 分支被降级成 OpenAI-compatible，于是用户得到一个「名字还叫 Gemini、
 * 实际按 OpenAI 协议去请求 Google 端点」的坏 provider —— 报错指向的是协议错误，
 * 而真正的原因是这份配置已经不可能工作。
 *
 * 判据只看 config.type，不看 map 的 key：用户把一个自建 OpenAI 兼容服务命名为
 * "my-gemini" 是完全合法的，不该被误删。
 *
 * 纯函数，loadSettings 与测试共用同一份判据。
 */
export function pruneUnsupportedProviders(
    providers: Record<string, ProviderConfig> = {}
): Record<string, ProviderConfig> {
    const kept: Record<string, ProviderConfig> = {};

    for (const [id, config] of Object.entries(providers)) {
        if (config && isSupportedProviderType(config.type)) {
            kept[id] = config;
        }
    }

    return kept;
}

/**
 * 读取旧版扁平设置（data.json 里没有 providers、只有 provider + 各家 xxxApiKey）
 * 里的字符串字段，配合调用处的 `|| 默认值` 使用。
 *
 * 与 isSupportedProviderType 同样的理由：入参直接面对 data.json，可能是数字、对象，
 * 或干脆是别的写法，调用方不该为了调用它先做一次不安全的断言。返回 undefined 表示
 * 「这里没有可用的字符串」，默认值由调用方决定。
 *
 * 注意这是一处有意的行为收口：旧实现写作 `old.openaiApiKey || ''`，脏数据下的
 * `apiKey: 123` 会被原样写进 ProviderConfig；现在这类值按「未设置」处理。
 * 字符串（含空串）与旧实现逐值一致——空串仍会走调用处的 `|| 默认值`。
 */
export function legacyFlatString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/** 转写端点与模型的可配置覆盖项。空字符串一律表示「沿用 provider / 内置默认」。 */
export interface AsrOverrides {
    asrBaseUrl?: string;
    asrApiKey?: string;
    asrModel?: string;
    asrLanguage?: string;
}

export interface ResolvedAsrConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    language: string;
    /** 'settings' = 用户在设置里显式配了端点；'provider' = 沿用 openai-compatible provider。 */
    source: 'settings' | 'provider';
}

/**
 * 无法解析出转写端点时的说明。
 *
 * 门禁从「provider 类型」改成「有没有端点」之后，这句话就是用户唯一能看到的线索，
 * 因此它必须同时说清「为什么没做」与「怎么才能做」。
 */
export const NO_ASR_ENDPOINT_MESSAGE =
    'No transcription endpoint is configured. Set the transcription endpoint (Base URL) in Settings -> Capture, '
    + 'or switch to an OpenAI-compatible provider whose base URL serves /audio/transcriptions.';

/**
 * 解析实际要打的转写端点。
 *
 * 顺序刻意如此：用户显式配置 > 沿用当前 openai-compatible provider > 放弃。
 * 「沿用 provider」这一条是既有用户零迁移的保证：什么都没配的 OpenAI 兼容用户，
 * 行为与改动前完全一致（同一个 baseUrl、同一个 key、同一个 whisper-1）。
 *
 * 反过来，Anthropic provider 的 baseUrl 上没有 /audio/transcriptions，所以**不**回退到它 ——
 * 否则用户会收到一个指向 api.anthropic.com 的 404，而真正的原因是「没配转写端点」。
 *
 * 纯函数，与 mergeProviderDefaults / pruneUnsupportedProviders 同类：只看配置，不碰 DOM、不碰网络。
 */
export function resolveAsrConfig(params: {
    asr?: AsrOverrides | null;
    provider?: ProviderConfig | null;
}): ResolvedAsrConfig | null {
    const explicitBaseUrl = (params.asr?.asrBaseUrl ?? '').trim();
    const provider = params.provider ?? null;
    const providerFallback = provider && provider.type === 'openai-compatible' ? provider : null;

    const baseUrl = explicitBaseUrl || (providerFallback?.baseUrl ?? '').trim();
    if (!baseUrl) return null;

    return {
        baseUrl,
        apiKey: (params.asr?.asrApiKey ?? '').trim() || (providerFallback?.apiKey ?? '').trim(),
        model: (params.asr?.asrModel ?? '').trim() || DEFAULT_ASR_MODEL,
        language: (params.asr?.asrLanguage ?? '').trim(),
        source: explicitBaseUrl ? 'settings' : 'provider',
    };
}

export interface IPlugin extends Plugin {
    settings: PluginSettings;
    /** 具体实现是 ModelService（main.ts 的 BaizerPlugin 已声明为该类型）。 */
    modelService: ModelService;
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
