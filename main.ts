import { Plugin, Notice, MarkdownView, TFile } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { ModelService } from './src/services/model-service';
import { PluginSettings, DEFAULT_SETTINGS, VIEW_TYPE_SHELL, ProviderConfig, PLUGIN_NAME, mergeProviderDefaults } from './src/mcp/types';
import { SettingTab } from './src/settings';
import { ShellView } from './src/ui/shell-view';
import { guardianGutterExtension, updateGuardianState, GuardianState, guardianModeField } from './src/ui/guardian-gutter';
import { ghostTextExtension, showGhostText, showDiagnosticGhostText } from './src/ui/ghost-text';
import { GuardianModal } from './src/ui/guardian-modal';
import { requestGuardianResponse } from './src/ui/guardian-request';
import { GuardianCompletionService, getGuardianAutoDelayMs, shouldScheduleDeepEscalation } from './src/ui/guardian-completion';
import { selectionMenuExtension } from './src/ui/selection-menu';
import { KnowledgeRuntime } from './src/knowledge/runtime';
import { ToolRegistry } from './src/skills/tool-registry';
import { SkillRegistry } from './src/skills/skill-registry';
import { registerVaultTools } from './src/skills/builtin/vault-ops';
import { registerSkillReadTool } from './src/skills/builtin/read-skill';
import { executor as webSearchSkillExecutor, registerTools as registerWebSearchTools } from './src/skills/builtin/web-search/executor';
import { createExecutor as createWebClipperSkillExecutor, registerTools as registerWebClipperTools } from './src/skills/builtin/web-clipper/executor';
import { createExecutor as createKnowledgeSkillExecutor, registerTools as registerKnowledgeTools } from './src/skills/builtin/knowledge/executor';
import { executor as pluginCtrlSkillExecutor, registerTools as registerPluginCtrlTools } from './src/skills/builtin/plugin-ctrl/executor';
import { executor as jsonCanvasSkillExecutor, registerTools as registerJsonCanvasTools } from './src/skills/builtin/json-canvas/executor';
import { executor as obsidianBasesSkillExecutor, registerTools as registerObsidianBasesTools } from './src/skills/builtin/obsidian-bases/executor';
// SKILL.md 通过 esbuild text loader 导入
import webSearchSkillMd from './src/skills/builtin/web-search/SKILL.md';
import webClipperSkillMd from './src/skills/builtin/web-clipper/SKILL.md';
import knowledgeSkillMd from './src/skills/builtin/knowledge/SKILL.md';
import pluginCtrlSkillMd from './src/skills/builtin/plugin-ctrl/SKILL.md';
import obsidianMarkdownSkillMd from './src/skills/builtin/obsidian-markdown/SKILL.md';
import jsonCanvasSkillMd from './src/skills/builtin/json-canvas/SKILL.md';
import obsidianBasesSkillMd from './src/skills/builtin/obsidian-bases/SKILL.md';
import { PluginWatcher } from './src/skills/builtin/plugin-ctrl/plugin-watcher';
import { PluginSkillGenerator } from './src/skills/builtin/plugin-ctrl/skill-generator';
import { InboxAutosaveCoordinator } from './src/services/inbox-autosave';
import { registerBaizerClipProtocolHandler } from './src/services/clip-protocol';
import { saveClipText } from './src/services/clip-input';
import { ObsidianContextService } from './src/services/obsidian-context-service';
import { USER_SKILLS_DIR } from './src/skills/skill-files';
import { logger } from './src/utils/logger';

export default class BaizerPlugin extends Plugin {
    settings: PluginSettings;
    modelService: ModelService;
    knowledgeRuntime: KnowledgeRuntime | null = null;
    guardianCompletionService: GuardianCompletionService;
    guardianContextService: ObsidianContextService;
    toolRegistry: ToolRegistry;
    skillRegistry: SkillRegistry;
    private editorExtensionsRegistered = false;
    private pluginWatcher: PluginWatcher | null = null;
    private inboxAutosave: InboxAutosaveCoordinator | null = null;
    private guardianCheckTimer: number | null = null;
    private guardianRequestSeq = 0;
    // 自动补全在途请求的单飞控制：新请求开始时 abort 上一个，避免并发堆积。
    private guardianInflight: AbortController | null = null;
    // 深补全(手动触发)独立单飞：与自动补全分离,避免昂贵的手动请求被随手打字 abort。
    private guardianDeepInflight: AbortController | null = null;
    // 自动升级到深补全：快补无果+用户停留时的停留确认计时,与已升级锚点记录(防重复烧钱)。
    private guardianEscalationTimer: number | null = null;
    private guardianEscalatedAnchors: Set<string> = new Set();

    private onEditorChange = (editor: any, info: any) => {
        void this.queueGuardianCheck(editor, info);
    };

    async onload() {
        await this.loadSettings();
        new Notice(`${PLUGIN_NAME}: Plugin loaded`);

        // Initialize Skill Architecture
        this.toolRegistry = new ToolRegistry(this.app, this.settings);
        this.skillRegistry = new SkillRegistry(this.toolRegistry);
        this.modelService = new ModelService(this.app, this.settings, this.toolRegistry, this.skillRegistry);
        this.guardianContextService = new ObsidianContextService(this.app);
        this.inboxAutosave = new InboxAutosaveCoordinator({
            app: this.app,
            getInboxPath: () => this.settings.wechatInboxPath,
            saveUrl: async (url: string) => this.toolRegistry.execute('save_webpage', { url }),
            notify: (message: string) => new Notice(message),
        });

        // 注册原子工具
        registerVaultTools(this.toolRegistry);
        registerSkillReadTool(this.toolRegistry, this.skillRegistry);
        registerWebSearchTools(this.toolRegistry);
        registerWebClipperTools(this.toolRegistry, this.modelService);
        registerPluginCtrlTools(this.toolRegistry);
        registerJsonCanvasTools(this.toolRegistry);
        registerObsidianBasesTools(this.toolRegistry);

        // 注册 Skill（从 SKILL.md，executor 为 noop — instructions 注入模式）
        this.skillRegistry.registerBuiltinFromMd(webSearchSkillMd, webSearchSkillExecutor);
        this.skillRegistry.registerBuiltinFromMd(webClipperSkillMd, createWebClipperSkillExecutor(this.modelService));
        this.skillRegistry.registerBuiltinFromMd(obsidianMarkdownSkillMd, { execute: async () => ({ ok: true }) });
        this.skillRegistry.registerBuiltinFromMd(jsonCanvasSkillMd, jsonCanvasSkillExecutor);
        this.skillRegistry.registerBuiltinFromMd(obsidianBasesSkillMd, obsidianBasesSkillExecutor);
        // 可用性由 settings.disabledSkills 控制，与读写权限正交——
        // 不再用 allowPluginControl 决定 plugin-ctrl 是否可用。
        this.skillRegistry.registerBuiltinFromMd(pluginCtrlSkillMd, pluginCtrlSkillExecutor);

        console.log(`[Baizer] SkillRegistry initialized: ${this.toolRegistry.size} tools, ${this.skillRegistry.listSkills().length} skills`);

        // Initialize Knowledge Runtime
        this.knowledgeRuntime = new KnowledgeRuntime(
            this.app,
            this.settings,
            this.modelService,
        );
        await this.knowledgeRuntime.initialize();
        this.guardianCompletionService = this.createGuardianCompletionService();
        this.knowledgeRuntime.registerCommands(this);
        this.knowledgeRuntime.registerEvents(this);

        // Knowledge 工具需要 executor，在 runtime 初始化后注册
        registerKnowledgeTools(
            this.toolRegistry,
            this.knowledgeRuntime.getQueryExecutor(),
            this.knowledgeRuntime.getFileBackExecutor(),
        );
        this.skillRegistry.registerBuiltinFromMd(knowledgeSkillMd, createKnowledgeSkillExecutor(this.toolRegistry));

        // 加载 pi 格式化器（getSkillSummaryText / activateSkill 依赖），并把内置 skill
        // 物化为隐藏目录下的真实文件（read_skill 与系统提示 location 指向它）。
        // 必须在所有内置注册后、loadUserSkills 前——使重扫到的内置文件按同名安全跳过。
        await this.skillRegistry.init();
        await this.skillRegistry.materializeBuiltins(this.app.vault.adapter);

        console.log(`[Baizer] Final: ${this.toolRegistry.size} tools, ${this.skillRegistry.listSkills().length} skills`);

        // 加载用户自定义 Skill
        await this.skillRegistry.loadUserSkills(USER_SKILLS_DIR, this.app);

        console.log(`[Baizer] Skill system ready: ${this.toolRegistry.size} tools, ${this.skillRegistry.listSkills().length} skills`);

        // 防止 hot reload 时重复注册
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_SHELL);
        try {
            this.registerView(
                VIEW_TYPE_SHELL,
                (leaf) => new ShellView(leaf, this.modelService, this)
            );
        } catch (e) {
            // hot reload 时 view type 可能已注册，忽略
            console.log('[Baizer] View type already registered, skipping.');
        }

        // Add ribbon icon for quick access to Baizer
        this.addRibbonIcon('terminal', `Open ${PLUGIN_NAME}`, (evt: MouseEvent) => {
            this.activateView();
        });

        this.addCommand({
            id: 'open-shell',
            name: `Open ${PLUGIN_NAME}`,
            callback: () => this.activateView(),
            hotkeys: [{ modifiers: ["Mod"], key: "j" }]
        });
        this.addCommand({
            id: 'save-url-from-clipboard',
            name: 'Baizer: Save URL from clipboard',
            callback: async () => {
                try {
                    const text = await globalThis.navigator?.clipboard?.readText?.();
                    const result = await saveClipText({
                        text: text || '',
                        saveUrl: async (url: string) => this.toolRegistry.execute('save_webpage', { url }),
                    });

                    if (result.success && result.path) {
                        new Notice(`Saved: ${result.path}`);
                    } else {
                        new Notice(`Failed to save URL: ${result.error || 'unknown error'}`);
                    }
                } catch (e: any) {
                    new Notice(`Failed to read clipboard: ${e?.message || 'unknown error'}`);
                }
            },
        });

        // Manual Guardian Trigger
        this.addCommand({
            id: 'guardian-manual-trigger',
            name: 'Guardian: Manual Trigger',
            callback: () => this.activateGuardianModal(),
            hotkeys: [{ modifiers: ["Mod", "Shift"], key: "g" }]
        });

        // Deep completion: 手动触发,读知识库正文+个性化+连接意图,允许更慢以换取更高质量。
        this.addCommand({
            id: 'guardian-deep-completion',
            name: 'Guardian: Deep completion at cursor',
            editorCallback: (editor) => { void this.runDeepGuardianCheck(editor); },
            hotkeys: [{ modifiers: ["Mod", "Shift"], key: " " }]
        });

        this.addSettingTab(new SettingTab(this.app, this));

        if (!this.editorExtensionsRegistered) {
            this.registerEditorExtension([
                guardianGutterExtension(),
                ghostTextExtension(),
                selectionMenuExtension(this.app, this.modelService)
            ]);
            this.editorExtensionsRegistered = true;
        }

        // Always register the event; runGuardianCheck will check the setting
        this.registerEvent(
            this.app.workspace.on('editor-change', this.onEditorChange)
        );

        // Register Inbox Monitor
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    void this.inboxAutosave?.handleFileModify(file);
                }
            })
        );

        // Register direct clip protocol:
        // obsidian://baizer-clip?url=<encoded-http-url>
        registerBaizerClipProtocolHandler(this, {
            saveUrl: async (url: string) => this.toolRegistry.execute('save_webpage', { url }),
            notify: (message: string) => new Notice(message),
            warn: (message: string) => console.warn(`[Baizer] ${message}`),
        });

        // 启动插件 Skill 自动生成（后台异步，不阻塞）
        const skillGenerator = new PluginSkillGenerator(
            this.app, this.modelService, this.settings,
        );
        this.pluginWatcher = new PluginWatcher(
            this.app, this.skillRegistry, skillGenerator, this.settings,
        );
        this.pluginWatcher.start();
    }

    onunload() {
        if (this.guardianCheckTimer !== null) {
            window.clearTimeout(this.guardianCheckTimer);
            this.guardianCheckTimer = null;
        }
        // 中断在途自动补全请求，避免卸载后回调访问已销毁的状态。
        this.guardianInflight?.abort();
        this.guardianInflight = null;
        this.guardianDeepInflight?.abort();
        this.guardianDeepInflight = null;
        this.clearGuardianEscalationTimer();
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_SHELL);
        if (this.knowledgeRuntime) {
            this.knowledgeRuntime.cleanup();
        }
        this.pluginWatcher?.stop();
        this.modelService.shutdown();
    }

    async activateView() {
        const { workspace } = this.app;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_SHELL);

        if (leaves.length > 0) {
            leaves[0].detach();
        } else {
            const leaf = workspace.getRightLeaf(false);
            await leaf?.setViewState({ type: VIEW_TYPE_SHELL, active: true });
            workspace.revealLeaf(leaf!);
        }
    }

    activateGuardianModal() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
            new Notice('Please open a Markdown file first.');
            return;
        }

        new GuardianModal(this.app, (instruction: string) => {
            this.runGuardianCheck(view.editor, null, instruction);
        }).open();
    }

    async loadSettings() {
        const raw = await this.loadData() || {};
        this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);

        // 数据迁移：旧扁平格式 → 新 providers map
        if (!raw.providers && (raw as any).provider) {
            const old = raw as any;
            this.settings.activeProvider = old.provider || 'gemini';
            this.settings.providers = {
                'gemini': {
                    type: 'gemini' as const,
                    label: 'Google Gemini',
                    apiKey: old.apiKey || '',
                    baseUrl: '',
                    model: old.primaryModel || 'gemini-2.5-flash'
                },
                'openai': {
                    type: 'openai-compatible' as const,
                    label: 'OpenAI',
                    apiKey: old.openaiApiKey || '',
                    baseUrl: old.openaiBaseUrl || 'https://api.openai.com/v1',
                    model: old.openaiModel || 'gpt-4o'
                },
                'deepseek': {
                    type: 'openai-compatible' as const,
                    label: 'DeepSeek',
                    apiKey: old.deepseekApiKey || '',
                    baseUrl: old.deepseekBaseUrl || 'https://api.deepseek.com',
                    model: old.deepseekModel || 'deepseek-chat'
                },
                'qwen': {
                    type: 'openai-compatible' as const,
                    label: 'Qwen',
                    apiKey: old.qwenApiKey || '',
                    baseUrl: old.qwenBaseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                    model: old.qwenModel || 'qwen-turbo'
                }
            };
            // 持久化迁移结果
            await this.saveData(this.settings);
        }

        // 确保 providers 中包含所有默认 provider（防止新增 provider 时旧数据缺失）
        this.settings.deletedProviderIds = Array.isArray(this.settings.deletedProviderIds)
            ? this.settings.deletedProviderIds
            : [];

        if (this.settings.providers) {
            this.settings.providers = mergeProviderDefaults(
                this.settings.providers,
                this.settings.deletedProviderIds
            );
        }

        if (!this.settings.providers[this.settings.activeProvider]) {
            this.settings.activeProvider = Object.keys(this.settings.providers)[0] || 'gemini';
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
        await this.modelService.updateSettings(this.settings);
        this.toolRegistry.updateContext(this.settings);
        if (this.knowledgeRuntime) {
            await this.knowledgeRuntime.updateSettings(this.settings);
        }
        this.guardianCompletionService = this.createGuardianCompletionService();
    }

    private createGuardianCompletionService(): GuardianCompletionService {
        return new GuardianCompletionService({
            settings: this.settings,
            modelService: this.modelService,
            knowledgeRuntime: this.knowledgeRuntime,
            diagnostics: (event) => {
                const { stage, requestId, ...metadata } = event;
                this.logGuardianAuto(stage, {
                    requestSeq: requestId,
                    ...metadata,
                }, stage === 'knowledge-timeout' ? 'warn' : 'info');
            },
        });
    }

    async onFileModify(file: TFile) {
        if (file.path !== this.settings.wechatInboxPath) return;

        const content = await this.app.vault.read(file);

        // Robust Regex: Matches Wikilinks, Markdown Links, OR Raw URLs
        // Group 1: Wikilink [[...]]
        // Group 2: Markdown Link [text](url)
        // Group 3: Raw URL http...
        const regex = /(\[\[.*?\]\])|(\[.*?\]\(.*?\))|(https?:\/\/[^\s\)]+)/g;

        let newContent = content;
        let modified = false;

        const rawUrlMatches = [];
        for (const m of content.matchAll(regex)) {
            if (!m[1] && !m[2] && m[3]) {
                rawUrlMatches.push({
                    url: m[3],
                    index: m.index,
                    length: m[0].length
                });
            }
        }

        if (rawUrlMatches.length === 0) return;

        // We process in reverse order so indices remain valid
        rawUrlMatches.sort((a, b) => b.index! - a.index!);

        for (const m of rawUrlMatches) {
            new Notice(`📥 Auto-saving: ${m.url}`);
            const result = await this.toolRegistry.execute('save_webpage', { url: m.url });

            if (result.success) {
                const finalPath = result.path;
                const linkText = `[[${finalPath}|Saved: ${finalPath.split('/').pop()?.replace('.md', '')}]]`;

                // Apply replacement at specific index
                newContent = newContent.substring(0, m.index) + linkText + newContent.substring(m.index! + m.length);
                modified = true;
            } else {
                new Notice(`❌ Failed to save ${m.url}: ${result.error}`);
            }
        }

        if (modified) {
            await this.app.vault.modify(file, newContent);
        }
    }

    private queueGuardianCheck(editor: any, info: any) {
        // 用户打字即取消待确认的升级:停留被打破,说明不再是「卡住」。
        this.clearGuardianEscalationTimer();
        if (this.guardianCheckTimer !== null) {
            window.clearTimeout(this.guardianCheckTimer);
            this.guardianCheckTimer = null;
            this.logGuardianAuto('debounce reset');
        }

        const activePath = this.app.workspace.getActiveFile?.()?.path || '';
        const decision = this.guardianCompletionService.shouldRunAuto({
            editor,
            activePath,
        });
        if (!decision.ok) {
            this.logGuardianAuto('trigger skipped', {
                reason: decision.reason || 'unknown',
                activePath,
                sensitivity: this.settings.guardianSensitivity,
                uiStyle: this.settings.guardianUIStyle,
            });
            this.showGuardianDiagnosticGhost(editor, decision.reason || 'unknown');
            return;
        }

        const delay = getGuardianAutoDelayMs(this.settings.guardianSensitivity);
        this.logGuardianAuto('trigger scheduled', {
            delayMs: delay,
            activePath,
            sensitivity: this.settings.guardianSensitivity,
            uiStyle: this.settings.guardianUIStyle,
        });
        this.guardianCheckTimer = window.setTimeout(() => {
            this.guardianCheckTimer = null;
            this.logGuardianAuto('debounce fired', {
                activePath,
                delayMs: delay,
            });
            void this.runGuardianCheck(editor, info);
        }, delay);
    }

    private async runAutoGuardianCheck(editor: any) {
        if (!this.settings.guardianAutoMode) {
            this.logGuardianAuto('auto skipped', { reason: 'auto-disabled' });
            this.showGuardianDiagnosticGhost(editor, 'auto-disabled');
            return;
        }

        const cursor = editor.getCursor();
        const lineNumber = cursor.line + 1;
        const view = (editor as any).cm as EditorView;
        const activePath = this.app.workspace.getActiveFile?.()?.path || '';
        if (!view) {
            this.logGuardianAuto('auto skipped', {
                reason: 'missing-editor-view',
                activePath,
                line: lineNumber,
                ch: cursor.ch,
            });
            return;
        }

        if (!view.state.field(guardianModeField)) {
            this.logGuardianAuto('auto skipped', {
                reason: 'guardian-paused',
                activePath,
                line: lineNumber,
                ch: cursor.ch,
            });
            this.showGuardianDiagnosticGhost(editor, 'guardian-paused');
            return;
        }

        const decision = this.guardianCompletionService.shouldRunAuto({ editor, activePath });
        if (!decision.ok) {
            this.logGuardianAuto('auto skipped', {
                reason: decision.reason || 'unknown',
                activePath,
                line: lineNumber,
                ch: cursor.ch,
            });
            this.showGuardianDiagnosticGhost(editor, decision.reason || 'unknown');
            return;
        }

        const requestSeq = ++this.guardianRequestSeq;
        // 单飞：abort 上一个在途请求，让其结果被丢弃；本次新建 controller。
        this.guardianInflight?.abort();
        const inflight = new AbortController();
        this.guardianInflight = inflight;
        const startedAt = Date.now();
        const requestLine = cursor.line;
        const requestCh = cursor.ch;
        const requestLineText = editor.getLine(requestLine) || '';
        const providerConfig = this.modelService.getActiveProviderConfig();

        this.logGuardianAuto('request started', {
            requestSeq,
            activePath,
            line: lineNumber,
            ch: requestCh,
            lineLength: requestLineText.length,
            provider: this.settings.activeProvider,
            providerType: providerConfig?.type,
            model: providerConfig?.model,
            hasApiKey: !!providerConfig?.apiKey?.trim(),
            uiStyle: this.settings.guardianUIStyle,
        });

        updateGuardianState(view, lineNumber, GuardianState.Thinking);

        const isStale = () => {
            const currentCursor = editor.getCursor();
            return requestSeq !== this.guardianRequestSeq
                || currentCursor.line !== requestLine
                || currentCursor.ch !== requestCh
                || (editor.getLine(requestLine) || '') !== requestLineText;
        };

        try {
            const contextStartedAt = Date.now();
            const obsidianContext = await this.guardianContextService.collect({
                includeBacklinks: false,
            });
            this.logGuardianAuto('context collected', {
                requestSeq,
                elapsedMs: Date.now() - contextStartedAt,
                activeHeading: !!obsidianContext.activeHeading,
                tagCount: obsidianContext.tags?.length || 0,
                outgoingLinkCount: obsidianContext.outgoingLinks?.length || 0,
            });

            const generationStartedAt = Date.now();
            const result = await this.guardianCompletionService.completeAuto({
                editor,
                obsidianContext,
                activePath,
                userProfile: this.modelService.getUserProfile(),
                isStale,
                requestId: requestSeq,
                signal: inflight.signal,
            });
            this.logGuardianAuto('completion returned', {
                requestSeq,
                resultType: result.type,
                reason: result.type === 'none' ? result.reason : undefined,
                suggestionLength: result.type === 'completion' ? result.suggestion.length : undefined,
                qualityReasons: result.type === 'completion' ? result.quality.reasons : undefined,
                elapsedMs: Date.now() - generationStartedAt,
                totalElapsedMs: Date.now() - startedAt,
            });

            if (result.type !== 'completion') {
                this.showGuardianDiagnosticGhost(editor, result.reason);
                updateGuardianState(view, lineNumber, GuardianState.Idle);
                // 快补无果:若属 A+B 类且用户停留,安排自动升级到深补全。
                this.maybeScheduleEscalation(editor, result.reason);
                return;
            }

            if (isStale()) {
                this.logGuardianAuto('completion discarded', {
                    requestSeq,
                    reason: 'stale-after-result',
                    totalElapsedMs: Date.now() - startedAt,
                });
                this.showGuardianDiagnosticGhost(editor, 'stale-after-result');
                updateGuardianState(view, lineNumber, GuardianState.Idle);
                return;
            }

            const currentLineCount = view.state.doc.lines;
            if (result.line > currentLineCount) {
                this.logGuardianAuto('completion discarded', {
                    requestSeq,
                    reason: 'line-out-of-bounds',
                    resultLine: result.line,
                    currentLineCount,
                }, 'warn');
                this.showGuardianDiagnosticGhost(editor, 'line-out-of-bounds');
                updateGuardianState(view, lineNumber, GuardianState.Idle);
                return;
            }

            const currentLine = view.state.doc.line(result.line);
            const safeCh = Math.min(result.ch, currentLine.length);

            showGhostText(view, result.suggestion, result.line, safeCh);

            updateGuardianState(
                view,
                result.line,
                this.shouldShowGuardianGutter() ? GuardianState.HasSuggestion : GuardianState.Idle,
            );
            this.logGuardianAuto('completion displayed', {
                requestSeq,
                line: result.line,
                ch: safeCh,
                suggestionLength: result.suggestion.length,
                ghostVisible: this.shouldShowGuardianGhostText(),
                gutterVisible: this.shouldShowGuardianGutter(),
                totalElapsedMs: Date.now() - startedAt,
            });
        } catch (error: any) {
            // 被单飞 abort（新输入触发了新请求）属正常丢弃，不显示为错误。
            if (error?.name === 'AbortError') {
                this.logGuardianAuto('completion aborted', {
                    requestSeq,
                    reason: 'superseded',
                    totalElapsedMs: Date.now() - startedAt,
                });
                updateGuardianState(view, lineNumber, GuardianState.Idle);
                return;
            }
            this.showGuardianDiagnosticGhost(editor, `error:${error?.message || 'unknown'}`);
            logger.error('Auto completion failed', error, 'Baizer Guardian', {
                requestSeq,
                activePath,
                line: lineNumber,
                ch: requestCh,
                totalElapsedMs: Date.now() - startedAt,
            });
            console.error("Guardian Error:", error);
            updateGuardianState(view, lineNumber, GuardianState.Error);
        } finally {
            // 仅当自己仍是最新在途请求时清理引用，避免误删后续请求的 controller。
            if (this.guardianInflight === inflight) {
                this.guardianInflight = null;
            }
        }
    }

    /**
     * 锚点 key:文件路径 + 行号 + 该行全文。行内容/行号一变即视为换位置,
     * 用于区分「停在原地没辙」与「正在往下写」。
     */
    private guardianAnchorKey(editor: any, activePath: string): string {
        const cursor = editor.getCursor();
        return `${activePath}|${cursor.line}|${editor.getLine(cursor.line) || ''}`;
    }

    private clearGuardianEscalationTimer(): void {
        if (this.guardianEscalationTimer !== null) {
            window.clearTimeout(this.guardianEscalationTimer);
            this.guardianEscalationTimer = null;
        }
    }

    /**
     * 快补无果后,若属 A+B 类且开关开、锚点未升过,起 1.2s 停留确认;
     * 计时结束时光标仍在原锚点(用户没走也没打字)才升级到深补全。一锚点只升一次。
     */
    private maybeScheduleEscalation(editor: any, reason: string): void {
        const activePath = this.app.workspace.getActiveFile?.()?.path || '';
        const anchorKey = this.guardianAnchorKey(editor, activePath);

        if (!shouldScheduleDeepEscalation({
            enabled: !!this.settings.guardianAutoDeepEscalation,
            reason,
            alreadyEscalated: this.guardianEscalatedAnchors.has(anchorKey),
        })) {
            return;
        }

        this.clearGuardianEscalationTimer();
        this.guardianEscalationTimer = window.setTimeout(() => {
            this.guardianEscalationTimer = null;
            // 停留确认:光标仍在原锚点才升级——打字/移动/接受都会改变 key 从而取消。
            const stillThere = this.guardianAnchorKey(editor, this.app.workspace.getActiveFile?.()?.path || '');
            if (stillThere !== anchorKey) return;
            if (this.guardianEscalatedAnchors.has(anchorKey)) return;
            this.guardianEscalatedAnchors.add(anchorKey);
            // 限制 set 体积,避免长会话无限增长。
            if (this.guardianEscalatedAnchors.size > 200) {
                this.guardianEscalatedAnchors.clear();
                this.guardianEscalatedAnchors.add(anchorKey);
            }
            this.logGuardianAuto('auto-escalate to deep', { reason, anchorKey });
            void this.runDeepGuardianCheck(editor);
        }, 1200);
    }

    /**
     * 深度补全(手动触发):读知识库正文+注入个性化+连接意图,允许更慢以换高质量。
     * 与自动补全分离:独立单飞控制器,不被打字防抖 abort;手动语义下绕过 paused 闸门。
     */
    private async runDeepGuardianCheck(editor: any) {
        if (!this.settings.enableGuardian) {
            new Notice('Baizer Guardian 未启用，请先在设置中开启。');
            return;
        }
        const view = (editor as any).cm as EditorView;
        if (!view) return;

        const activePath = this.app.workspace.getActiveFile?.()?.path || '';
        const decision = this.guardianCompletionService.shouldRunAuto({ editor, activePath, mode: 'deep' });
        if (!decision.ok) {
            new Notice(`深度补全跳过：${decision.reason || 'unknown'}`);
            return;
        }

        // 独立单飞:abort 上一个深补全(若有),不影响自动补全的 guardianInflight。
        this.guardianDeepInflight?.abort();
        const inflight = new AbortController();
        this.guardianDeepInflight = inflight;

        const cursor = editor.getCursor();
        const requestLine = cursor.line;
        const requestCh = cursor.ch;
        const requestLineText = editor.getLine(requestLine) || '';
        const lineNumber = cursor.line + 1;
        const startedAt = Date.now();
        const requestSeq = ++this.guardianRequestSeq;

        const isStale = () => {
            const c = editor.getCursor();
            return inflight.signal.aborted
                || c.line !== requestLine
                || c.ch !== requestCh
                || (editor.getLine(requestLine) || '') !== requestLineText;
        };

        const notice = new Notice('Baizer Guardian 正在深度补全…', 0);
        updateGuardianState(view, lineNumber, GuardianState.Thinking);
        try {
            const obsidianContext = await this.guardianContextService.collect({ includeBacklinks: true });
            const result = await this.guardianCompletionService.completeAuto({
                editor,
                obsidianContext,
                activePath,
                userProfile: this.modelService.getUserProfile(),
                isStale,
                requestId: requestSeq,
                signal: inflight.signal,
                mode: 'deep',
            });
            notice.hide();
            this.logGuardianAuto('deep completion returned', {
                requestSeq,
                resultType: result.type,
                reason: result.type === 'none' ? result.reason : undefined,
                totalElapsedMs: Date.now() - startedAt,
            });

            if (result.type !== 'completion') {
                new Notice(`深度补全：无建议（${result.reason}）`);
                updateGuardianState(view, lineNumber, GuardianState.Idle);
                return;
            }
            if (isStale()) {
                updateGuardianState(view, lineNumber, GuardianState.Idle);
                return;
            }
            const currentLineCount = view.state.doc.lines;
            if (result.line > currentLineCount) {
                updateGuardianState(view, lineNumber, GuardianState.Idle);
                return;
            }
            const currentLine = view.state.doc.line(result.line);
            const safeCh = Math.min(result.ch, currentLine.length);
            showGhostText(view, result.suggestion, result.line, safeCh);
            updateGuardianState(
                view,
                result.line,
                this.shouldShowGuardianGutter() ? GuardianState.HasSuggestion : GuardianState.Idle,
            );
        } catch (error: any) {
            notice.hide();
            if (error?.name === 'AbortError') {
                updateGuardianState(view, lineNumber, GuardianState.Idle);
                return;
            }
            new Notice(`深度补全失败：${error?.message || 'unknown'}`);
            logger.error('Deep completion failed', error, 'Baizer Guardian', { requestSeq, activePath });
            updateGuardianState(view, lineNumber, GuardianState.Error);
        } finally {
            if (this.guardianDeepInflight === inflight) {
                this.guardianDeepInflight = null;
            }
        }
    }

    private showGuardianDiagnosticGhost(editor: any, reason: string) {
        const view = (editor as any).cm as EditorView;
        if (!view) return;
        const cursor = editor.getCursor();
        const lineNumber = cursor.line + 1;
        const currentLine = editor.getLine(cursor.line) || '';
        const safeCh = Math.min(cursor.ch, currentLine.length);
        showDiagnosticGhostText(view, ` Guardian: ${reason}`, lineNumber, safeCh);
        updateGuardianState(
            view,
            lineNumber,
            this.shouldShowGuardianGutter() ? GuardianState.HasSuggestion : GuardianState.Idle,
        );
    }

    private logGuardianAuto(message: string, metadata?: Record<string, any>, level: 'info' | 'warn' | 'debug' = 'info') {
        const safeMetadata = {
            autoMode: this.settings.guardianAutoMode,
            enabled: this.settings.enableGuardian,
            ...metadata,
        };
        const formattedMessage = `${message}${this.formatGuardianLogMetadata(safeMetadata)}`;
        if (level === 'warn') {
            logger.warn(formattedMessage, 'Baizer Guardian', safeMetadata);
        } else if (level === 'debug') {
            logger.debug(formattedMessage, 'Baizer Guardian', safeMetadata);
        } else {
            logger.info(formattedMessage, 'Baizer Guardian', safeMetadata);
        }
    }

    private formatGuardianLogMetadata(metadata: Record<string, any>): string {
        const keys = [
            'requestSeq',
            'reason',
            'resultType',
            'delayMs',
            'elapsedMs',
            'totalElapsedMs',
            'activePath',
            'line',
            'ch',
            'lineLength',
            'provider',
            'providerType',
            'model',
            'hasApiKey',
            'uiStyle',
            'ghostVisible',
            'gutterVisible',
            'suggestionLength',
            'contextLength',
            'knowledgeLength',
            'responseLength',
            'responsePreview',
            'qualityReasons',
            'activeHeading',
            'tagCount',
            'outgoingLinkCount',
            'sensitivity',
            'autoMode',
            'enabled',
        ];
        const parts = keys
            .filter((key) => metadata[key] !== undefined)
            .map((key) => `${key}=${this.formatGuardianLogValue(metadata[key])}`);
        return parts.length ? ` ${parts.join(' ')}` : '';
    }

    private formatGuardianLogValue(value: any): string {
        if (Array.isArray(value)) return `[${value.join(',')}]`;
        if (typeof value === 'string') return JSON.stringify(value);
        return String(value);
    }

    private shouldShowGuardianGhostText(): boolean {
        return this.settings.guardianUIStyle === 'ghost' || this.settings.guardianUIStyle === 'hybrid';
    }

    private shouldShowGuardianGutter(): boolean {
        return this.settings.guardianUIStyle === 'gutter' || this.settings.guardianUIStyle === 'hybrid';
    }

    async runGuardianCheck(editor: any, info: any, manualInstruction?: string) {
        if (!this.settings.enableGuardian) {
            this.logGuardianAuto(manualInstruction ? 'manual skipped' : 'auto skipped', {
                reason: 'guardian-disabled',
            });
            return;
        }
        if (!manualInstruction) {
            await this.runAutoGuardianCheck(editor);
            return;
        }

        // Auto Mode Check: If not manual instruction and auto mode is disabled, skip.
        if (!manualInstruction && !this.settings.guardianAutoMode) return;

        const cursor = editor.getCursor();
        const lineNumber = cursor.line + 1;
        const view = (editor as any).cm as EditorView;

        if (!view) return;

        // Check Global Guardian Mode (Paused/Active)
        const isGuardianEnabled = view.state.field(guardianModeField);
        if (!manualInstruction && !isGuardianEnabled) return;

        const line = editor.getLine(cursor.line);
        // For auto mode, ensure line has content. For manual mode, we might process empty lines too.
        if (!manualInstruction && (!line.trim() || line.trim().length < 3)) return;

        // Get context: Last 10 lines (approx) to provide better context
        const startLine = Math.max(0, cursor.line - 10);
        const contextLines = [];
        for (let i = startLine; i <= cursor.line; i++) {
            contextLines.push(editor.getLine(i));
        }
        const contextText = contextLines.join('\n');

        updateGuardianState(view, lineNumber, GuardianState.Thinking);

        try {
            let prompt = "";
            let systemPromptOverride = "";

            if (manualInstruction) {
                prompt = `User Instruction: "${manualInstruction}"
Context:
"${contextText}"

Please execute the instruction.
- If it's an edit, return JSON: {"type":"edit", "suggestion":"REPLACED_TEXT"}
- If it's a question, return JSON: {"type":"answer", "suggestion":"ANSWER_TEXT"}
- If no action needed, return JSON: {"type":"none"}
- Ensure the suggestion uses proper Markdown formatting.`;
                systemPromptOverride = "You are a helpful assistant. Return ONLY JSON.";
            } else {
                // Generalized Co-writer Prompt
                prompt = `Role: ${this.settings.systemPrompt || "You are a helpful AI assistant."}
Task: You are a helpful co-writer. Complete the user's thought or continue the text naturally.

Context:
${contextText}

Instructions:
1. Suggest a continuation that flows naturally based on the context.
2. Do NOT repeat the input text.
3. If the text is complete or you have no good suggestion, return "type": "none".
4. Output JSON: {"type": "completion", "suggestion": "MARKDOWN_FORMATTED_TEXT"}
5. Ensure the suggestion uses proper Markdown formatting (bold, italic, lists, code blocks) where appropriate.`;
            }

            const obsidianContext = await new ObsidianContextService(this.app).collect();
            const response = await requestGuardianResponse(this.modelService, {
                prompt,
                systemPromptOverride,
                obsidianContext,
                userProfile: this.modelService.getUserProfile(),
            });

            // 提取第一个完整 JSON 对象（平衡括号计数，避免贪婪 regex 抓到多余内容）
            let data: any;
            const braceStart = response.indexOf('{');
            if (braceStart === -1) {
                updateGuardianState(view, lineNumber, GuardianState.Idle);
                return;
            }
            let depth = 0;
            let inString = false;
            let escape = false;
            let jsonEnd = -1;
            for (let i = braceStart; i < response.length; i++) {
                const ch = response[i];
                if (escape) { escape = false; continue; }
                if (ch === '\\' && inString) { escape = true; continue; }
                if (ch === '"') { inString = !inString; continue; }
                if (inString) continue;
                if (ch === '{') depth++;
                else if (ch === '}') { depth--; if (depth === 0) { jsonEnd = i; break; } }
            }
            if (jsonEnd === -1) {
                updateGuardianState(view, lineNumber, GuardianState.Idle);
                return;
            }
            try {
                data = JSON.parse(response.substring(braceStart, jsonEnd + 1));
            } catch {
                updateGuardianState(view, lineNumber, GuardianState.Idle);
                return;
            }

            // For edits/suggestions
            if (data.suggestion && typeof data.suggestion === 'string') {
                // Re-validate position as document might have changed
                const currentLineCount = view.state.doc.lines;
                if (lineNumber > currentLineCount) {
                    console.warn("Guardian: Line number out of bounds after generation.");
                    updateGuardianState(view, lineNumber, GuardianState.Idle);
                    return;
                }

                const currentLine = view.state.doc.line(lineNumber);
                const safeCh = Math.min(cursor.ch, currentLine.length);

                console.log("Guardian: Showing ghost text", { suggestion: data.suggestion, line: lineNumber, ch: safeCh });
                showGhostText(view, data.suggestion, lineNumber, safeCh);
                updateGuardianState(view, lineNumber, GuardianState.HasSuggestion);
            } else {
                // console.warn("Guardian: Invalid suggestion data", data);
                updateGuardianState(view, lineNumber, GuardianState.Idle);
            }

            if (data.type === 'none') {
                updateGuardianState(view, lineNumber, GuardianState.Idle);
                return;
            }

        } catch (error: any) {
            console.error("Guardian Error:", error);
            updateGuardianState(view, lineNumber, GuardianState.Error);
        }
    }
}
