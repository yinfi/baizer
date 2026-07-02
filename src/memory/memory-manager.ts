import { App } from 'obsidian';
import {
    UserProfile,
    DEFAULT_USER_PROFILE,
    MemoryMutationResult,
    MemoryView,
    MemoryViewRequest,
} from './types';
import { MEMORY_DIR } from '../mcp/types';
import {
    createMemoryId,
    DEFAULT_MEMORY_BANK_ID,
    normalizeMemoryText,
    RetainTurnInput,
    RetainLessonInput,
} from './hindsight-types';
import { HindsightConsolidator } from './hindsight-consolidator';
import { importPreviousMemoryFiles, migrateLegacyMemory } from './hindsight-migration';
import { HindsightRetriever } from './hindsight-retriever';
import { HindsightStore } from './hindsight-store';

interface MemoryManagerOptions {
    privacyMode?: boolean;
}

type ForgetMemoryField = 'name' | 'profession' | 'expertise' | 'preferences' | 'workflows' | 'projects' | 'goals' | 'all';

export class MemoryManager {
    private userProfile: UserProfile;
    private initPromise: Promise<void>;
    private hindsightStore: HindsightStore;
    private hindsightRetriever: HindsightRetriever;
    private hindsightConsolidator: HindsightConsolidator;
    private retainedUserTurns = 0;

    private readonly MEMORY_DIR = MEMORY_DIR;
    private readonly PROFILE_FILE = 'user-profile.json';

    constructor(
        private app: App,
        private options: MemoryManagerOptions = {},
    ) {
        this.userProfile = { ...DEFAULT_USER_PROFILE };
        this.hindsightStore = new HindsightStore(app);
        this.hindsightRetriever = new HindsightRetriever(this.hindsightStore);
        this.hindsightConsolidator = new HindsightConsolidator(this.hindsightStore);
        this.initPromise = this.initialize();
    }

    private async initialize() {
        await this.hindsightStore.ready();
        await importPreviousMemoryFiles(this.app, this.hindsightStore);
        await this.loadProfile();
        await migrateLegacyMemory(this.app, this.hindsightStore);
    }

    async ready(): Promise<void> {
        await this.initPromise;
    }

    async clearSession() {
        await this.ready();
    }

    async recallForPrompt(input: {
        query: string;
        source?: 'shell' | 'guardian' | 'selection-menu' | 'slash-edit';
        maxChars?: number;
        now?: number;
    }): Promise<string> {
        await this.ready();
        const includeTypes = input.source === 'guardian'
            ? ['observation', 'world'] as const
            : ['observation', 'world', 'experience'] as const;
        const result = await this.hindsightRetriever.recall({
            query: input.query,
            source: input.source,
            maxChars: input.maxChars ?? 2500,
            includeTypes: [...includeTypes],
            now: input.now,
        });
        return result.promptBlock;
    }

    async getMemoryView(request: MemoryViewRequest = {}): Promise<MemoryView> {
        await this.ready();
        const limit = Math.max(1, Math.min(request.limit ?? 5, 25));
        const memories = await this.hindsightStore.listMemories(DEFAULT_MEMORY_BANK_ID);
        const sorted = [...memories].sort((a, b) => b.mentionedAt - a.mentionedAt);
        const query = request.query?.trim() || '';
        const searchResult = query
            ? await this.hindsightRetriever.recall({
                query,
                maxRecords: limit,
                maxChars: 4000,
                now: request.now,
            })
            : { records: [], promptBlock: '' };

        return {
            privacyMode: this.options.privacyMode === true,
            legacyProfile: this.getProfile(),
            stats: {
                total: memories.length,
                world: memories.filter((memory) => memory.type === 'world').length,
                experience: memories.filter((memory) => memory.type === 'experience').length,
                observation: memories.filter((memory) => memory.type === 'observation').length,
                lastUpdatedAt: memories.length
                    ? Math.max(...memories.map((memory) => memory.updatedAt || memory.mentionedAt))
                    : null,
            },
            sections: {
                observations: sorted.filter((memory) => memory.type === 'observation').slice(0, limit),
                facts: sorted.filter((memory) => memory.type === 'world').slice(0, limit),
                recent: sorted.filter((memory) => memory.type === 'experience').slice(0, limit),
                searchResults: searchResult.records,
                raw: sorted.slice(0, limit),
            },
        };
    }

    async retainTurn(input: RetainTurnInput): Promise<void> {
        await this.ready();
        if (this.options.privacyMode) return;

        const now = input.now ?? Date.now();
        const records = this.buildTurnMemories(input, now);
        if (records.length === 0) return;

        await this.hindsightStore.upsertMemories(records);
        this.retainedUserTurns += 1;
        if (this.retainedUserTurns % 5 === 0) {
            await this.hindsightConsolidator.consolidate({ now });
        }
    }

    /**
     * 用户点踩(负反馈)时,把「这次回答被否定 + 用户给的原因」提炼成一条「应避免」教训写入记忆。
     * - 教训以 observation + polarity:negative 落库,召回时渲染为「avoid: ...」直接约束后续生成。
     * - query 相关性来自 userInput 的 token(写进 tags),使同类提问在未来命中该教训。
     * - 纯规则提炼,不额外调用 LLM:同步、零延迟、移动端安全;reason 即最直接的教训信号。
     * 返回写入的教训文本(供调用方做即时 steering),privacy 模式或内容为空时返回 null。
     */
    async retainLesson(input: RetainLessonInput): Promise<string | null> {
        await this.ready();
        if (this.options.privacyMode) return null;

        const now = input.now ?? Date.now();
        const reason = this.sanitizeMemoryText(input.reason.trim());
        if (!reason) return null;

        const userInput = this.sanitizeMemoryText(input.userInput.trim());
        const topic = userInput ? this.truncateForLesson(userInput, 80) : '';
        // 教训文本:把「场景」与「应避免什么」拼成一句可复用的指令。
        const lessonText = topic
            ? `回答关于「${topic}」一类问题时,应避免:${this.truncateForLesson(reason, 200)}`
            : `应避免:${this.truncateForLesson(reason, 200)}`;

        const tags = Array.from(new Set([
            'feedback-lesson',
            ...this.tagsForText(userInput),
            ...this.tagsForText(reason),
        ])).slice(0, 12);

        const record = this.createMemoryRecord({
            type: 'observation',
            text: lessonText,
            sourceKind: 'chat',
            tags,
            now,
            confidence: 0.8,
            polarity: 'negative',
        });

        await this.hindsightStore.upsertMemories([record]);
        return lessonText;
    }

    /** 教训文本截断:按字符上限裁剪并补省略号,避免把整段差评原文塞进记忆。 */
    private truncateForLesson(text: string, maxChars: number): string {
        const normalized = text.replace(/\s+/g, ' ').trim();
        return normalized.length > maxChars
            ? `${normalized.slice(0, maxChars - 1)}…`
            : normalized;
    }

    async forgetMemory(field: string): Promise<MemoryMutationResult> {
        await this.ready();
        const before = (await this.hindsightStore.listMemories()).length;
        const normalizedField = field.trim().toLowerCase() as ForgetMemoryField;
        if (normalizedField === 'all') {
            await this.hindsightStore.clearMemories();
            const after = (await this.hindsightStore.listMemories()).length;
            return {
                success: true,
                deletedCount: before - after,
                message: 'Cleared all remembered Hindsight memory.',
            };
        }

        await this.hindsightStore.deleteMemories((memory) => this.shouldForgetHindsightMemory(memory, normalizedField));
        const after = (await this.hindsightStore.listMemories()).length;
        return {
            success: true,
            deletedCount: before - after,
            message: `Forgot memory field: ${normalizedField}`,
        };
    }

    async deleteMemoryById(id: string): Promise<MemoryMutationResult> {
        await this.ready();
        const target = id.trim();
        if (!target) {
            return { success: false, deletedCount: 0, message: 'Missing memory id.' };
        }

        const before = (await this.hindsightStore.listMemories()).length;
        await this.hindsightStore.deleteMemories((memory) => memory.id === target);
        const after = (await this.hindsightStore.listMemories()).length;
        return {
            success: before !== after,
            deletedCount: before - after,
            message: before !== after ? `Deleted memory: ${target}` : `Memory not found: ${target}`,
        };
    }

    private buildTurnMemories(input: RetainTurnInput, now: number) {
        const records = [];
        const userText = this.sanitizeMemoryText(input.userMessage.trim());
        if (userText) {
            records.push(this.createMemoryRecord({
                type: this.looksDurable(userText) ? 'world' : 'experience',
                text: this.memoryTextForUserMessage(userText),
                sourceKind: 'chat',
                tags: this.tagsForText(userText),
                now,
            }));
        }

        const assistantText = this.sanitizeMemoryText(input.assistantMessage.trim());
        if (assistantText) {
            records.push(this.createMemoryRecord({
                type: 'experience',
                text: `Assistant outcome: ${assistantText.slice(0, 400)}`,
                sourceKind: 'chat',
                tags: ['assistant-outcome'],
                now,
                confidence: 0.55,
            }));
        }

        return records;
    }

    private shouldForgetHindsightMemory(memory: any, field: ForgetMemoryField): boolean {
        if (!['name', 'profession', 'expertise', 'preferences', 'workflows', 'projects', 'goals'].includes(field)) {
            return false;
        }

        const text = memory.normalizedText || normalizeMemoryText(memory.text || '');
        const tags = new Set((memory.tags || []).map((tag: string) => tag.toLowerCase()));

        switch (field) {
            case 'profession':
                return tags.has('profession') || text.startsWith('user profession:') || text.includes('profession') || this.matchesProfessionMemory(text);
            case 'expertise':
                return tags.has('expertise') || text.startsWith('user expertise:') || text.includes('expertise') || this.matchesExpertiseMemory(text);
            case 'preferences':
                return tags.has('preference') || text.includes('preference') || text.includes('response style');
            case 'workflows':
                return tags.has('workflow') || text.includes('workflow');
            case 'projects':
                return tags.has('project') || text.startsWith('current project:') || text.includes('my project');
            case 'goals':
                return tags.has('goal') || text.startsWith('user goal:') || text.includes('my goal');
            case 'name':
                return tags.has('name') || text.startsWith('user name:') || text.includes('my name is') || this.matchesNameMemory(text);
            default:
                return false;
        }
    }

    private matchesProfessionMemory(text: string): boolean {
        return /\b(?:i am|i'm)\s+(?:an?\s+)?[^.?!\n]{0,80}\b(?:engineer|developer|designer|manager|researcher|writer|student|consultant|architect|analyst)\b/i.test(text)
            || /我是[^。！？\n]{0,40}(?:工程师|开发|经理|设计师|研究员|学生|顾问|架构师|分析师)/i.test(text);
    }

    private matchesExpertiseMemory(text: string): boolean {
        return /\b(?:expert in|skilled in|speciali[sz]e in)\b/i.test(text)
            || /擅长/i.test(text);
    }

    private matchesNameMemory(text: string): boolean {
        return /\b(?:my name is|i am named|i'm named|named|call me)\b/i.test(text)
            || /(?:我叫|叫我|我的名字是)/i.test(text);
    }

    private sanitizeMemoryText(text: string): string {
        if (!text) return '';

        return text
            .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
            .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]')
            .replace(/\bgh[pousr]_[A-Za-z0-9_]{10,}\b/g, '[REDACTED]')
            .replace(/\b(api\s*key|token|password|secret)\s*(?:is|=|:)\s*([^\s,;]+)/gi, '$1 is [REDACTED]');
    }

    private createMemoryRecord(input: {
        type: 'world' | 'experience' | 'observation';
        text: string;
        sourceKind: 'chat' | 'manual';
        tags: string[];
        now: number;
        confidence?: number;
        polarity?: 'positive' | 'negative';
    }) {
        return {
            id: createMemoryId({
                bankId: DEFAULT_MEMORY_BANK_ID,
                type: input.type,
                text: input.text,
                sourceKind: input.sourceKind,
            }),
            bankId: DEFAULT_MEMORY_BANK_ID,
            type: input.type,
            text: input.text,
            normalizedText: normalizeMemoryText(input.text),
            entities: this.extractEntities(input.text),
            tags: input.tags,
            source: { kind: input.sourceKind },
            confidence: input.confidence ?? (input.type === 'world' ? 0.75 : 0.6),
            ...(input.polarity ? { polarity: input.polarity } : {}),
            createdAt: input.now,
            updatedAt: input.now,
            mentionedAt: input.now,
            accessCount: 0,
        };
    }

    private looksDurable(text: string): boolean {
        return /\bI prefer\b|\bmy project\b|\bmy goal\b|\bremember\b|偏好|喜欢|目标|项目|我是|我正在/i.test(text);
    }

    private memoryTextForUserMessage(text: string): string {
        return this.looksDurable(text) ? `User stated: ${text}` : `User asked: ${text}`;
    }

    private tagsForText(text: string): string[] {
        const tags = [];
        const normalizedText = normalizeMemoryText(text);
        if (/prefer|偏好|喜欢/i.test(text)) tags.push('preference');
        if (/project|项目/i.test(text)) tags.push('project');
        if (/goal|目标/i.test(text)) tags.push('goal');
        if (this.matchesProfessionMemory(normalizedText)) tags.push('profession');
        if (this.matchesExpertiseMemory(normalizedText)) tags.push('expertise');
        if (this.matchesNameMemory(normalizedText)) tags.push('name');
        if (tags.length === 0) tags.push('chat');
        return tags;
    }

    private extractEntities(text: string): string[] {
        const matches = text.match(/[A-Z][A-Za-z0-9_.-]*(?:\s+[A-Z][A-Za-z0-9_.-]*)*/g) || [];
        const dotted = text.match(/[a-z0-9_.-]+\/[a-z0-9_.-]+|[a-z0-9_.-]+\.[a-z0-9_.-]+/gi) || [];
        return [...new Set([...matches, ...dotted])]
            .map((entity) => entity.trim())
            .filter((entity) => entity.length >= 2)
            .slice(0, 8);
    }

    getProfile(): UserProfile {
        return { ...this.userProfile };
    }

    async updateProfile(updates: Partial<UserProfile>) {
        await this.ready();
        this.userProfile = { ...this.userProfile, ...updates };
        this.userProfile.metadata.updatedAt = Date.now();
        await this.saveProfile();
    }

    async save() {
        await this.ready();
        await this.saveProfile();
    }

    private async ensureMemoryDir() {
        const adapter = this.app.vault.adapter;
        const dirExists = await adapter.exists(this.MEMORY_DIR);
        if (!dirExists) {
            await adapter.mkdir(this.MEMORY_DIR);
        }
    }

    private async loadProfile() {
        try {
            const path = `${this.MEMORY_DIR}/${this.PROFILE_FILE}`;

            if (await this.app.vault.adapter.exists(path)) {
                const content = await this.app.vault.adapter.read(path);
                this.userProfile = JSON.parse(content);
            }
        } catch (e) {
            console.error('Failed to load profile:', e);
            this.userProfile = { ...DEFAULT_USER_PROFILE };
        }
    }

    private async saveProfile() {
        try {
            await this.ensureMemoryDir();
            const path = `${this.MEMORY_DIR}/${this.PROFILE_FILE}`;
            await this.app.vault.adapter.write(
                path,
                JSON.stringify(this.userProfile, null, 2)
            );
        } catch (e) {
            console.error('Failed to save profile:', e);
        }
    }
}
