import { App } from 'obsidian';
import {
    MemoryMutationResult,
    MemoryView,
    MemoryViewRequest,
} from './types';
import {
    collectSupersededIds,
    createMemoryId,
    DEFAULT_MEMORY_BANK_ID,
    normalizeMemoryText,
    sanitizeMemoryText,
    tokenizeForRetrieval,
    withTextTimeout,
    RetainTurnInput,
    RetainLessonInput,
} from './hindsight-types';
import { HindsightConsolidator } from './hindsight-consolidator';
import { importPreviousMemoryFiles, migrateLegacyMemory } from './hindsight-migration';
import { HindsightRetriever } from './hindsight-retriever';
import { HindsightStore } from './hindsight-store';
import { logger } from '../utils/logger';

interface MemoryManagerOptions {
    privacyMode?: boolean;
    /**
     * 无状态 LLM 生成回调(由 ModelService 注入,避免循环依赖)。
     * 提供时 retain/consolidate 走 LLM 提炼精炼记忆(符合"偏好可复用记忆而非原始转储"的 directive);
     * 缺省或调用失败时回退到纯规则沉淀。
     */
    generate?: (prompt: string, systemPrompt?: string) => Promise<string>;
    /**
     * 召回前 LLM 查询扩展开关。开启且注入了 generate 时,对话路径(非 Guardian)召回前
     * 把 query 扩成同义词/跨语言译词再喂 BM25,补偿纯词法检索的同义/跨语言漏召回。
     */
    queryExpansion?: boolean;
    /**
     * 一跳实体图检索开关。开启时召回把与 BM25 种子共享实体的邻居也带出(衰减分)。
     * 纯内存零 LLM 成本,对话/Guardian 均安全。
     */
    graphRecall?: boolean;
    /**
     * 矛盾更新开关。开启时 upsertDeduped 对同主题的 world 单值记忆(偏好/名字/职业等)
     * 做退役替换:新事实 supersedes 旧事实,旧的从召回消失(留库可恢复)。
     */
    conflictUpdate?: boolean;
    /**
     * 后台 LLM 提炼/归纳的超时(ms)。provider 卡死时,超时→回退纯规则,绝不让在途沉淀
     * 永不结束(否则 flush() 死循环,拖住设置切换/插件卸载)。默认 8s;测试可注入小值。
     */
    distillTimeoutMs?: number;
}

type ForgetMemoryField = 'name' | 'profession' | 'expertise' | 'preferences' | 'workflows' | 'projects' | 'goals' | 'all';

export class MemoryManager {
    private initPromise: Promise<void>;
    private hindsightStore: HindsightStore;
    private hindsightRetriever: HindsightRetriever;
    private hindsightConsolidator: HindsightConsolidator;
    // 记忆库 directives(disposition/立场)缓存:默认 bank 的 directives 是静态的,取一次即可。
    private directivesHintCache: string | null = null;
    // 查询扩展缓存:同一 query 只付一次 LLM 费用(归一化 key → 扩展词串)。有界,超量淘汰最旧。
    private queryExpansionCache = new Map<string, string>();
    private static readonly QUERY_EXPANSION_CACHE_MAX = 100;
    private static readonly QUERY_EXPANSION_TIMEOUT_MS = 2000;
    // 后台提炼/归纳的默认超时:比查询扩展(2s)宽松,后台任务不阻塞对话热路径。
    private static readonly DEFAULT_DISTILL_TIMEOUT_MS = 8000;
    // 后台沉淀任务集合:retain 走 fire-and-forget,flush 时 await 排空,插件卸载前不丢在途写。
    private pendingRetains = new Set<Promise<void>>();

    constructor(
        private app: App,
        private options: MemoryManagerOptions = {},
    ) {
        this.hindsightStore = new HindsightStore(app);
        this.hindsightRetriever = new HindsightRetriever(this.hindsightStore);
        this.hindsightConsolidator = new HindsightConsolidator(
            this.hindsightStore,
            options.generate,
            options.distillTimeoutMs ?? MemoryManager.DEFAULT_DISTILL_TIMEOUT_MS,
        );
        this.initPromise = this.initialize();
    }

    private async initialize() {
        await this.hindsightStore.ready();
        // 隐私模式语义是「这台机器不沉淀我的数据」,把旧数据搬进新库与之冲突,故整体跳过迁移导入。
        if (!this.options.privacyMode) {
            await importPreviousMemoryFiles(this.app, this.hindsightStore);
            await migrateLegacyMemory(this.app, this.hindsightStore);
        }
    }

    async ready(): Promise<void> {
        await this.initPromise;
    }

    async clearSession() {
        await this.ready();
    }

    /** 排空所有在途后台沉淀并确保落盘。设置变更/插件卸载前调用,避免丢在途写。 */
    async flush(): Promise<void> {
        await this.ready();
        // 反复排空:await 期间可能又有新的 retain 入队。
        while (this.pendingRetains.size > 0) {
            await Promise.all([...this.pendingRetains]);
        }
        await this.hindsightStore.flush();
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
        // 对话路径(非 Guardian)按需做 LLM 查询扩展,补偿纯词法检索的同义/跨语言漏召回;
        // Guardian 亚秒补全绝不扩展。扩展词并入原 query 后交给 BM25(打分逻辑不变)。
        const query = input.source === 'guardian'
            ? input.query
            : await this.maybeExpandQuery(input.query);
        const result = await this.hindsightRetriever.recall({
            query,
            source: input.source,
            maxChars: input.maxChars ?? 2500,
            includeTypes: [...includeTypes],
            now: input.now,
            graphRecall: this.options.graphRecall === true,
        });
        return result.promptBlock;
    }

    /**
     * LLM 查询扩展:把 query 扩成"原词 + 同义词 + 跨语言译词",并入一个字符串交给 BM25。
     * 未开启 / 未注入 generate / 空 query → 原样返回。命中缓存直接返回。
     * LLM 超时或失败 → 回退原 query(withTimeout 恒 resolve,绝不阻塞召回)。
     */
    private async maybeExpandQuery(rawQuery: string): Promise<string> {
        const generate = this.options.generate;
        const query = rawQuery.trim();
        if (!this.options.queryExpansion || typeof generate !== 'function' || !query) {
            return rawQuery;
        }

        const cacheKey = normalizeMemoryText(query);
        const cached = this.queryExpansionCache.get(cacheKey);
        if (cached !== undefined) return cached;

        const system = '你是检索查询扩展器。给定一句查询,输出它的同义词与跨语言译词(中↔英),'
            + '用于扩大关键词召回。只输出词/短语的 JSON 数组(如 ["部署","发布","deploy"]),'
            + '最多 8 个,不要解释,不要输出原句整句。';
        const timeout = MemoryManager.QUERY_EXPANSION_TIMEOUT_MS;
        let expanded = query;
        try {
            const raw = await withTextTimeout(generate(query, system), timeout);
            const terms = this.parseDistilledLines(raw);
            if (terms.length > 0) {
                // 原 query 打头保证原始信号不被稀释,扩展词追加。
                expanded = `${query} ${terms.join(' ')}`;
            }
        } catch {
            expanded = rawQuery;
        }

        this.putQueryExpansionCache(cacheKey, expanded);
        return expanded;
    }

    /** 写入查询扩展缓存,超出上限时淘汰最旧一条(Map 迭代序即插入序)。 */
    private putQueryExpansionCache(key: string, value: string): void {
        if (this.queryExpansionCache.size >= MemoryManager.QUERY_EXPANSION_CACHE_MAX) {
            const oldest = this.queryExpansionCache.keys().next().value;
            if (oldest !== undefined) this.queryExpansionCache.delete(oldest);
        }
        this.queryExpansionCache.set(key, value);
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

    /**
     * 沉淀一轮对话。fire-and-forget:不阻塞对话回合,后台 LLM 提炼(失败回退纯规则)。
     * 调用方无需 await;需要确保落盘时(设置变更/卸载)调 flush()。
     */
    async retainTurn(input: RetainTurnInput): Promise<void> {
        if (this.options.privacyMode) return;
        const task = this.retainTurnAsync(input)
            .catch((e) => logger.warn('retainTurn failed', 'MemoryManager', { error: String(e) }));
        const tracked = task.finally(() => { this.pendingRetains.delete(tracked); });
        this.pendingRetains.add(tracked);
        // 返回被追踪的任务:调用方可选择 await(测试/需确定性落盘时)或忽略(对话热路径 fire-and-forget)。
        return tracked;
    }

    private async retainTurnAsync(input: RetainTurnInput): Promise<void> {
        await this.ready();
        const now = input.now ?? Date.now();

        // 成本闸门:LLM 提炼不是每轮都跑。仅当本轮"可能含可复用信息"时才付费调用 LLM,
        // 否则直接走零成本规则路径(纯闲聊问答规则路径也不会入库)。判据:
        //   - 用户消息 looksDurable(含偏好/项目/目标/自我陈述信号),或
        //   - 本轮发生了工具操作(有实际动作,值得记结果)。
        const userText = sanitizeMemoryText(input.userMessage.trim());
        const hadToolAction = Array.isArray(input.toolResults) && input.toolResults.length > 0;
        const worthDistilling = (!!userText && this.looksDurable(userText)) || hadToolAction;

        // 优先 LLM 提炼精炼记忆(符合 directive:可复用记忆而非原始转储);未配置/不值得/失败回退纯规则。
        let records = worthDistilling ? await this.distillTurnMemories(input, now) : null;
        if (records === null) {
            records = this.buildTurnMemories(input, now);
        }
        if (records.length === 0) return;

        await this.upsertDeduped(records, now);

        const counter = await this.bumpConsolidateCounter();
        if (counter % 5 === 0) {
            await this.hindsightConsolidator.consolidate({ now });
        }
    }

    /**
     * LLM 沉淀:把 user+assistant 一轮提炼成 0-N 条精炼、可复用的记忆(每条一句话)。
     * 返回 null = 交给上层规则回退(未注入 generate / LLM 失败 / LLM 超时 / LLM 判定无可记);
     * 返回 [] = 输入真空(user、assistant 都空),规则回退也产不出记录,无需回退。
     */
    private async distillTurnMemories(input: RetainTurnInput, now: number): Promise<any[] | null> {
        const generate = this.options.generate;
        if (typeof generate !== 'function') return null;

        const userText = sanitizeMemoryText(input.userMessage.trim());
        const assistantText = sanitizeMemoryText(input.assistantMessage.trim());
        if (!userText && !assistantText) return [];

        const system = '你是记忆提炼器。从一轮对话中提取"未来可复用的持久事实/偏好/决策",'
            + '忽略寒暄与一次性问答。每条不超过 40 字。同时抽出该条涉及的实体'
            + '(人名/项目/技术/产品/概念,中英文均可,每条最多 4 个)。'
            + '以 JSON 数组返回,元素形如 {"text":"用户偏好X","entities":["X"]};'
            + '无值得记忆的内容返回 []。不要输出任何解释。'
            + await this.directivesHint();
        const prompt = `用户: ${userText.slice(0, 800)}\n助手: ${assistantText.slice(0, 800)}`;

        // 套超时:provider 卡死时超时→空串→(下方)当作"无可记"→返回 null 交给规则回退,
        // 绝不让在途沉淀永不结束(否则 flush() 死循环,拖住设置切换/插件卸载)。
        const timeout = this.options.distillTimeoutMs ?? MemoryManager.DEFAULT_DISTILL_TIMEOUT_MS;
        const raw = await withTextTimeout(generate(prompt, system), timeout);

        const items = this.parseDistilledItems(raw);
        // 空结果(LLM 判无可记 / 超时空串 / 解析不出):返回 null 交给规则回退,
        // 而非 []——否则 durable 用户事实会被 distill 静默吞掉,规则保底路径拿不到机会。
        if (items.length === 0) return null;

        return items.map((item) => this.createMemoryRecord({
            type: this.looksDurable(item.text) ? 'world' : 'experience',
            text: item.text,
            sourceKind: 'chat',
            tags: this.tagsForText(item.text),
            now,
            confidence: 0.7,
            entities: item.entities,
        }));
    }

    /**
     * 解析 distill 的结构化返回:元素为 {text, entities}(新格式)或纯字符串(旧格式/降级)。
     * text 走脱敏+去前缀符号,entities 原样(交给 createMemoryRecord 的 normalizeEntities 清洗)。
     */
    private parseDistilledItems(raw: string): Array<{ text: string; entities?: string[] }> {
        const text = (raw || '').trim();
        if (!text) return [];
        let parsed: any;
        try {
            parsed = JSON.parse(text);
        } catch {
            // 非 JSON:退化成按行的纯文本(无实体)。
            return text.split('\n')
                .map((line) => sanitizeMemoryText(line.replace(/^[-*\d.\s]+/, '').trim()))
                .filter((line) => line.length >= 2)
                .slice(0, 5)
                .map((line) => ({ text: line }));
        }
        if (!Array.isArray(parsed)) return [];
        const result: Array<{ text: string; entities?: string[] }> = [];
        for (const el of parsed) {
            // 兼容:元素可能是对象 {text,entities} 或纯字符串。
            const rawText = typeof el === 'string' ? el : (el && typeof el.text === 'string' ? el.text : '');
            const clean = sanitizeMemoryText(rawText.replace(/^[-*\d.\s]+/, '').trim());
            if (clean.length < 2) continue;
            const entities = (el && Array.isArray(el.entities))
                ? el.entities.map((x: any) => String(x))
                : undefined;
            result.push({ text: clean, entities });
            if (result.length >= 5) break;
        }
        return result;
    }

    /** 解析 LLM 返回:优先当 JSON 数组,失败则按行切分;去空、去长、限量。 */
    private parseDistilledLines(raw: string): string[] {
        const text = (raw || '').trim();
        if (!text) return [];
        let items: string[] = [];
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) items = parsed.map((x) => String(x));
        } catch {
            items = text.split('\n');
        }
        return items
            .map((line) => sanitizeMemoryText(line.replace(/^[-*\d.\s]+/, '').trim()))
            .filter((line) => line.length >= 2)
            .slice(0, 5);
    }

    /**
     * 记忆库 directives(disposition/立场)拼成一段 system prompt 追加文本,注入到提炼/归纳中,
     * 让 LLM 真正遵守"偏好精炼可复用记忆、不存密钥"等规矩(此前 directives 定义了却从不参与决策)。
     * 默认 bank 的 directives 是静态的,首次读后缓存。取不到返回空串。
     */
    private async directivesHint(): Promise<string> {
        if (this.directivesHintCache !== null) return this.directivesHintCache;
        let hint = '';
        try {
            const banks = await this.hindsightStore.listBanks();
            const bank = banks.find((b) => b.id === DEFAULT_MEMORY_BANK_ID) || banks[0];
            const directives = bank?.directives?.filter((d) => d.trim()) ?? [];
            if (directives.length > 0) {
                hint = `\n遵守以下记忆准则:\n${directives.map((d) => `- ${d}`).join('\n')}`;
            }
        } catch {
            hint = '';
        }
        this.directivesHintCache = hint;
        return hint;
    }

    /**
     * Mental Models 层:把最高层、最可信的 observation(consolidate 产出的用户画像)拼成
     * 一个「无条件注入每轮 prompt」的用户画像块。与 recallForPrompt 的区别是它不受 BM25 词法
     * 门控——用户问"今天天气"也应看到"该用户偏好简洁技术回答"这类长期画像。
     * 仅取 observation(已是归纳结论),按 confidence×recency 排序取前 N,带字符预算。
     * 无 observation 时返回空串。与 [Relevant Memory] 可能有轻微重复(observation 也会被召回),
     * 但 observation 数量少、是高价值结论,接受这点冗余换"永远在场"。
     */
    async getMentalModelBlock(input: { maxRecords?: number; maxChars?: number; now?: number } = {}): Promise<string> {
        await this.ready();
        const maxRecords = input.maxRecords ?? 3;
        const maxChars = input.maxChars ?? 600;
        const now = input.now ?? Date.now();
        // 退役过滤:与 BM25 召回共用 collectSupersededIds。此前本层直取全部 observation,
        // 导致被 consolidate 收敛退役的过期用户画像仍被无条件注入(新旧结论同时在场)。
        // superseded 基于全部记录构建(supersedes 可指向任意类型),再 filter observation。
        const allMemories = await this.hindsightStore.listMemories(DEFAULT_MEMORY_BANK_ID);
        const superseded = collectSupersededIds(allMemories);
        const observations = allMemories
            .filter((m) => m.type === 'observation' && !superseded.has(m.id));
        if (observations.length === 0) return '';

        // 排序键:confidence 为主,recency(14天半衰)为辅,与 retriever 的时近口径一致。
        const scored = observations
            .map((m) => {
                const ageMs = Math.max(0, now - m.mentionedAt);
                const recency = 1 / (1 + ageMs / (1000 * 60 * 60 * 24 * 14));
                return { m, score: m.confidence + recency * 0.5 };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, maxRecords)
            .map((x) => x.m);

        let used = '[User Model]\n'.length;
        const lines: string[] = [];
        for (const m of scored) {
            const line = `- ${m.text}\n`;
            if (lines.length > 0 && used + line.length > maxChars) break;
            lines.push(line);
            used += line.length;
        }
        if (lines.length === 0) return '';
        return `[User Model]\n${lines.join('')}`;
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
        const reason = sanitizeMemoryText(input.reason.trim());
        if (!reason) return null;

        const userInput = sanitizeMemoryText(input.userInput.trim());
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

    /**
     * 纯规则沉淀(LLM 未配置或失败时的回退)。质量门槛,避免原始转储:
     * - 用户消息:仅当 looksDurable(含偏好/项目/目标/自我陈述等信号)才存,存为 world;普通问答流水账不入库。
     * - 助手输出:仅当本轮有工具操作(toolResults,有实际动作发生)或用户消息 durable 时才存;否则丢弃闲聊回答。
     */
    private buildTurnMemories(input: RetainTurnInput, now: number) {
        const records = [];
        const userText = sanitizeMemoryText(input.userMessage.trim());
        const userDurable = !!userText && this.looksDurable(userText);

        if (userDurable) {
            records.push(this.createMemoryRecord({
                type: 'world',
                text: this.memoryTextForUserMessage(userText),
                sourceKind: 'chat',
                tags: this.tagsForText(userText),
                now,
            }));
        }

        const assistantText = sanitizeMemoryText(input.assistantMessage.trim());
        const hadToolAction = Array.isArray(input.toolResults) && input.toolResults.length > 0;
        if (assistantText && (hadToolAction || userDurable)) {
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

    /**
     * 去重写入:与库内"同 tag 集且文本高相似(token Jaccard ≥ 0.8)"的记录视为同一条,
     * 只更新其 mentionedAt(+可选 accessCount),不新增;否则正常 upsert。避免近义改写句无限堆叠。
     */
    private async upsertDeduped(records: any[], now: number): Promise<void> {
        const existing = await this.hindsightStore.listMemoriesRaw(DEFAULT_MEMORY_BANK_ID);
        const toWrite: any[] = [];

        for (const record of records) {
            const dup = existing.find((e) =>
                e.type === record.type
                && this.sameTagSet(e.tags, record.tags)
                && this.tokenJaccard(e.normalizedText, record.normalizedText) >= 0.8);
            if (dup) {
                // 命中重复(近义改写):刷新时近度,复用旧 id/累积计数,写回旧记录。
                toWrite.push({ ...dup, mentionedAt: now, updatedAt: now });
                continue;
            }

            // 矛盾更新:同主题但内容变了(改偏好/改名/换项目)→ 新记录退役旧记录。
            // 仅对 world 单值主题启用,experience(经历累积)与多值主题不替换,把误退役压到最低。
            if (this.options.conflictUpdate !== false) {
                const stale = this.findStaleSameTopic(record, existing);
                if (stale.length > 0) {
                    record.supersedes = stale.map((s) => s.id);
                }
            }
            toWrite.push(record);
        }
        await this.hindsightStore.upsertMemories(toWrite);
    }

    // world 单值主题:同一主题只应有一个当前值,新值到来时旧值退役。多值主题(如 expertise 可有多个)不在此列。
    private static readonly SINGLE_VALUE_TOPICS = ['preference', 'name', 'profession', 'project', 'goal'];

    // 同主题退役的相似度窗口:低于下限视为"不同槽位的并存值"(如深色主题 vs 简洁回答),不退役;
    // 高于去重阈(0.8)是近义,已在上游合并。二者之间才是"同维度改了值",退役。
    private static readonly TOPIC_REPLACE_MIN = 0.15;
    private static readonly TOPIC_REPLACE_MAX = 0.8;

    /**
     * 找出应被新记录退役的旧 world 记录。判据:同一单值主题 tag + 相似度落在 [MIN, MAX) 窗口。
     * 精度取舍:只退役窗口内"最相似"的一条(同维度改值),不误伤同 tag 但不同槽位的并存偏好;
     * 相似度过低(<MIN)说明是不同槽位,一律不退役。多值主题/experience 一律不触发。
     */
    private findStaleSameTopic(record: any, existing: any[]): any[] {
        if (record.type !== 'world') return [];
        const recordTopics = record.tags.filter((t: string) =>
            MemoryManager.SINGLE_VALUE_TOPICS.includes(t));
        if (recordTopics.length === 0) return [];
        const topicSet = new Set(recordTopics);

        let best: any = null;
        let bestSim = 0;
        for (const e of existing) {
            if (e.type !== 'world' || e.id === record.id) continue;
            if (!e.tags.some((t: string) => topicSet.has(t))) continue;
            const sim = this.tokenJaccard(e.normalizedText, record.normalizedText);
            if (sim >= MemoryManager.TOPIC_REPLACE_MIN
                && sim < MemoryManager.TOPIC_REPLACE_MAX
                && sim > bestSim) {
                best = e;
                bestSim = sim;
            }
        }
        return best ? [best] : [];
    }

    private sameTagSet(a: string[], b: string[]): boolean {
        if (a.length !== b.length) return false;
        const setA = new Set(a);
        return b.every((tag) => setA.has(tag));
    }

    /**
     * 两段文本的 token Jaccard 相似度(交集/并集),用于近义去重。
     * 用 tokenizeForRetrieval(CJK bigram + latin token),使中文也能按子串重叠度量相似,
     * 而非退化成"整串完全相等才去重"。
     */
    private tokenJaccard(a: string, b: string): number {
        const ta = new Set(tokenizeForRetrieval(a));
        const tb = new Set(tokenizeForRetrieval(b));
        if (ta.size === 0 && tb.size === 0) return 1;
        let inter = 0;
        for (const t of ta) if (tb.has(t)) inter += 1;
        const union = ta.size + tb.size - inter;
        return union === 0 ? 0 : inter / union;
    }

    private async bumpConsolidateCounter(): Promise<number> {
        return this.hindsightStore.bumpConsolidateCounter();
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

    private createMemoryRecord(input: {
        type: 'world' | 'experience' | 'observation';
        text: string;
        sourceKind: 'chat' | 'manual';
        tags: string[];
        now: number;
        confidence?: number;
        polarity?: 'positive' | 'negative';
        // LLM 结构化抽取的实体(优先);缺省时回退正则版 extractEntities。
        entities?: string[];
    }) {
        const entities = (input.entities && input.entities.length > 0)
            ? this.normalizeEntities(input.entities)
            : this.extractEntities(input.text);
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
            entities,
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
        // 第一人称信号(用户原话):I prefer / my project / 我是 / 偏好 ...
        // 第三人称信号(LLM distill 输出口径,如 "User prefers concise answers." / "用户偏好X"):
        //   distill 的 system prompt 让 LLM 产出的正是第三人称陈述,此前分类器只认第一人称,
        //   导致这类长期事实被错分成 experience(丢失矛盾退役/画像归纳资格),故必须一并识别。
        return /\bI prefer\b|\bmy project\b|\bmy goal\b|\bremember\b|偏好|喜欢|目标|项目|我是|我正在|用户/i.test(text)
            || /\buser\s+(?:prefers?|likes?|wants?|uses?|is\s+an?|works?\s+(?:on|as))\b/i.test(text)
            || /\buser['’]s\s+(?:preference|project|goal|name|profession)\b/i.test(text);
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
        // 英文/技术标识:大写开头词组 + 带点/斜杠 token。
        const matches = text.match(/[A-Z][A-Za-z0-9_.-]*(?:\s+[A-Z][A-Za-z0-9_.-]*)*/g) || [];
        const dotted = text.match(/[a-z0-9_.-]+\/[a-z0-9_.-]+|[a-z0-9_.-]+\.[a-z0-9_.-]+/gi) || [];
        // 中文实体信号(正则版对中文此前几乎为零):
        //   《...》书名/作品名、「...」/『...』术语引用、【...】标注,取括号内内容。
        const bracketed = (text.match(/《([^》]{1,20})》|「([^」]{1,20})」|『([^』]{1,20})』|【([^】]{1,20})】/g) || [])
            .map((m) => m.replace(/^[《「『【]|[》」』】]$/g, ''));
        //   "关于X的""X项目""X系统"这类结构里 X 是 2-8 个连续中文字。
        const cjkPhrases = (text.match(/[一-鿿]{2,8}(?=项目|系统|平台|框架|模型|方案|计划)/g) || []);
        return [...new Set([...matches, ...dotted, ...bracketed, ...cjkPhrases])]
            .map((entity) => entity.trim())
            .filter((entity) => entity.length >= 2)
            .slice(0, 8);
    }

    /** 清洗 LLM 给的实体:去空白/去空/去重/限长/限量,口径与正则版 extractEntities 一致。 */
    private normalizeEntities(entities: string[]): string[] {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const raw of entities) {
            const entity = String(raw).trim();
            if (entity.length < 2) continue;
            const key = entity.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(entity);
            if (result.length >= 8) break;
        }
        return result;
    }

    // 遗留 user-profile.json 子系统已退役(#6):它 write-only、永远默认值、对生成零效果。
    // 旧文件的迁移导入(profileToMemories)由 hindsight-migration 承担,不依赖此处的 live 状态。
    // save() 保留为兼容空实现:调用方(flushMemorySession)仍会调,但已无 profile 可存。
    async save() {
        await this.ready();
    }
}
