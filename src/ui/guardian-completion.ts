import { PluginSettings } from '../mcp/types';
import { GenerationOptions } from '../models/interfaces';
import { UserProfile } from '../memory/types';
import { ModelService } from '../services/model-service';
import { ObsidianContextSnapshot } from '../services/obsidian-context-service';

export type GuardianMarkdownShape = 'paragraph' | 'list' | 'task' | 'heading' | 'code';

// 补全模式：fast=自动触发,亚秒级,元数据检索;deep=手动触发,读正文+连接意图,允许更慢。
export type GuardianCompletionMode = 'fast' | 'deep';

export interface GuardianCompletionContext {
  currentLine: string;
  cursorPrefix: string;
  cursorSuffix: string;
  currentHeading: string | null;
  localBlock: string;
  recentContext: string;
  markdownShape: GuardianMarkdownShape;
  knowledgeContext: string;
  voiceHint: string;
  mode: GuardianCompletionMode;
  prompt: string;
  line: number;
  ch: number;
}

export interface GuardianCompletionRequest {
  editor: GuardianEditorLike;
  obsidianContext?: ObsidianContextSnapshot;
  activePath?: string;
  userProfile?: UserProfile | null;
  isStale?: () => boolean;
  requestId?: number;
  signal?: AbortSignal;
  mode?: GuardianCompletionMode;
}

export type GuardianCompletionResult =
  | { type: 'completion'; suggestion: string; line: number; ch: number; quality: GuardianQualityDecision }
  | { type: 'none'; reason: string };

export interface GuardianQualityDecision {
  ok: boolean;
  reasons: string[];
}

interface GuardianEditorLike {
  getCursor(): { line: number; ch: number };
  getLine(line: number): string;
  lineCount?(): number;
}

interface GuardianKnowledgeRuntimeLike {
  getGuardianKnowledgeContext?(editorContext: string): Promise<string>;
  getGuardianDeepKnowledgeContext?(editorContext: string): Promise<string>;
}

interface GuardianCompletionServiceDeps {
  settings: PluginSettings;
  modelService: ModelService & { isGenerationConfigured?: () => boolean };
  knowledgeRuntime?: GuardianKnowledgeRuntimeLike | null;
  knowledgeTimeoutMs?: number;
  completionTimeoutMs?: number;
  deepKnowledgeTimeoutMs?: number;
  deepCompletionTimeoutMs?: number;
  cacheTtlMs?: number;
  diagnostics?: (event: GuardianCompletionDiagnosticEvent) => void;
}

export interface GuardianCompletionDiagnosticEvent {
  stage: 'build-context-start' | 'build-context-finished' | 'knowledge-start' | 'knowledge-finished' | 'knowledge-timeout' | 'deep-knowledge-start' | 'deep-knowledge-finished' | 'model-start' | 'model-finished' | 'completion-timeout' | 'response-parse-failed' | 'empty-response' | 'cache-hit';
  requestId?: number;
  activePath?: string;
  elapsedMs?: number;
  contextLength?: number;
  knowledgeLength?: number;
  responseLength?: number;
  responsePreview?: string;
}

interface TriggerDecision {
  ok: boolean;
  reason?: 'disabled' | 'auto-disabled' | 'ignored-folder' | 'empty' | 'too-short';
}

const GUARDIAN_SYSTEM_PROMPT = [
  'You are Baizer Guardian, a low-latency inline writing completer for Obsidian notes.',
  'Return ONLY one JSON object.',
  'Do not output reasoning, explanations, markdown fences, or commentary.',
  'Silence is better than a weak guess: only continue when you are confident the continuation is what the writer actually intends.',
  'When in doubt, return none. Never produce generic filler just to have something to say.',
  'Preserve the user voice and never mention the knowledge context.',
].join(' ');

const GUARDIAN_DEEP_SYSTEM_PROMPT = [
  'You are Baizer Guardian in deep mode, a writing partner with access to the user\'s own knowledge notes.',
  'Return ONLY one JSON object.',
  'Do not output reasoning, explanations, markdown fences, or commentary.',
  'You may take a beat longer to produce something genuinely valuable: when the user\'s notes offer a relevant angle, evidence, or connection, weave it in concretely and cite the note title.',
  'Still return none rather than forcing an irrelevant connection or generic filler.',
  'Preserve the user voice.',
].join(' ');

const GUARDIAN_GENERATION_OPTIONS: GenerationOptions = {
  temperature: 0.25,
  skipGenerationPlan: true,
};

export function getGuardianAutoDelayMs(sensitivity: number): number {
  const clamped = clamp(sensitivity, 0, 100);
  return Math.round(1200 - (clamped * 4));
}

// A+B 类无果 reason 白名单:模型主动 none + 质检过滤,语义=「浅层已尽力但此处值得更深」。
// 排除 C(故障:completion-timeout/empty-response/invalid-json/model-not-configured/...)
// 与 D(拒绝/失效:stale/stale-after-result/line-out-of-bounds、触发闸门 disabled/too-short 等)。
export const GUARDIAN_ESCALATION_REASONS: ReadonlySet<string> = new Set([
  'explicit-none', 'repeats-input', 'duplicates-suffix', 'too-long',
  'filler-opening', 'no-substance', 'wrong-markdown-shape', 'meta-commentary',
  'low-quality', 'empty',
]);

/**
 * 纯判定:快补无果后是否应「安排」自动升级到深补全。
 * 不含光标停留判定(那是调用方在计时结束时用实时光标做的二次确认)。
 */
export function shouldScheduleDeepEscalation(input: {
  enabled: boolean;
  reason: string;
  alreadyEscalated: boolean;
}): boolean {
  if (!input.enabled) return false;
  if (input.alreadyEscalated) return false;
  return GUARDIAN_ESCALATION_REASONS.has(input.reason);
}

export class GuardianCompletionService {
  // 短时补全缓存：消除「Esc 后重触发/光标抖动/同位置重复请求」造成的重复 API 调用。
  // 只缓存成功的 completion；键含光标前后文与局部块,内容一变即不命中。
  private readonly completionCache = new Map<string, { suggestion: string; quality: GuardianQualityDecision; expiresAt: number }>();
  private static readonly CACHE_MAX_ENTRIES = 32;

  constructor(private readonly deps: GuardianCompletionServiceDeps) {}

  shouldRunAuto(input: { editor: GuardianEditorLike; activePath?: string; mode?: GuardianCompletionMode }): TriggerDecision {
    const settings = this.deps.settings;
    if (!settings.enableGuardian) return { ok: false, reason: 'disabled' };
    // deep 是手动触发,不受自动开关约束;仅 fast 受 guardianAutoMode 控制。
    if (input.mode !== 'deep' && !settings.guardianAutoMode) return { ok: false, reason: 'auto-disabled' };
    if (this.isIgnoredPath(input.activePath || '')) return { ok: false, reason: 'ignored-folder' };

    const cursor = input.editor.getCursor();
    const line = input.editor.getLine(cursor.line) || '';
    const prefix = line.slice(0, Math.max(0, cursor.ch)).trim();
    if (!prefix) return { ok: false, reason: 'empty' };

    const minChars = this.minTriggerChars();
    if (stripMarkdownPrefix(prefix).length < minChars) return { ok: false, reason: 'too-short' };

    return { ok: true };
  }

  async buildContext(input: GuardianCompletionRequest): Promise<GuardianCompletionContext> {
    const mode: GuardianCompletionMode = input.mode || 'fast';
    const cursor = input.editor.getCursor();
    const lineCount = this.getLineCount(input.editor, cursor.line);
    const line = input.editor.getLine(cursor.line) || '';
    const ch = Math.min(Math.max(0, cursor.ch), line.length);
    const cursorPrefix = line.slice(0, ch);
    const cursorSuffix = line.slice(ch);
    const markdownShape = this.detectMarkdownShape(input.editor, cursor.line);
    const localBlock = this.extractLocalBlock(input.editor, cursor.line, lineCount, markdownShape);
    const recentContext = this.extractRecentContext(input.editor, cursor.line);
    const currentHeading = input.obsidianContext?.activeHeading || this.findHeading(input.editor, cursor.line);
    const voiceHint = buildVoiceHint(input.userProfile);
    const knowledgeContext = await this.selectKnowledgeContext({
      mode,
      cursorPrefix,
      localBlock,
      currentHeading,
      obsidianContext: input.obsidianContext,
      requestId: input.requestId,
      activePath: input.activePath,
    });
    const base = {
      currentLine: line,
      cursorPrefix,
      cursorSuffix,
      currentHeading,
      localBlock,
      recentContext,
      markdownShape,
      knowledgeContext,
      voiceHint,
      mode,
      line: cursor.line + 1,
      ch,
    };
    const prompt = this.buildPrompt({ ...base, prompt: '' });

    return { ...base, prompt };
  }

  async completeAuto(input: GuardianCompletionRequest): Promise<GuardianCompletionResult> {
    const mode: GuardianCompletionMode = input.mode || 'fast';
    const timeoutMs = mode === 'deep'
      ? (this.deps.deepCompletionTimeoutMs ?? 20000)
      : (this.deps.completionTimeoutMs ?? 9000);
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        this.completeAutoInner(input),
        new Promise<GuardianCompletionResult>((resolve) => {
          timeoutHandle = setTimeout(() => {
            this.emitDiagnostic({
              stage: 'completion-timeout',
              requestId: input.requestId,
              activePath: input.activePath,
              elapsedMs: timeoutMs,
            });
            resolve({ type: 'none', reason: 'completion-timeout' });
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async completeAutoInner(input: GuardianCompletionRequest): Promise<GuardianCompletionResult> {
    const trigger = this.shouldRunAuto({
      editor: input.editor,
      activePath: input.activePath,
      mode: input.mode,
    });
    if (!trigger.ok) return { type: 'none', reason: trigger.reason || 'skipped' };
    if (this.deps.modelService.isGenerationConfigured?.() === false) {
      return { type: 'none', reason: 'model-not-configured' };
    }

    this.emitDiagnostic({
      stage: 'build-context-start',
      requestId: input.requestId,
      activePath: input.activePath,
    });
    const contextStartedAt = Date.now();
    const context = await this.buildContext(input);
    this.emitDiagnostic({
      stage: 'build-context-finished',
      requestId: input.requestId,
      activePath: input.activePath,
      elapsedMs: Date.now() - contextStartedAt,
      contextLength: context.prompt.length,
      knowledgeLength: context.knowledgeContext.length,
    });
    if (input.isStale?.()) return { type: 'none', reason: 'stale' };

    // 缓存查询：同一光标上下文短时内重复触发,直接复用上次结果,跳过 API。
    const cacheKey = this.buildCacheKey(context);
    const cached = this.readCache(cacheKey);
    if (cached) {
      this.emitDiagnostic({
        stage: 'cache-hit',
        requestId: input.requestId,
        activePath: input.activePath,
        responseLength: cached.suggestion.length,
      });
      return {
        type: 'completion',
        suggestion: cached.suggestion,
        line: context.line,
        ch: context.ch,
        quality: cached.quality,
      };
    }

    this.emitDiagnostic({
      stage: 'model-start',
      requestId: input.requestId,
      activePath: input.activePath,
      contextLength: context.prompt.length,
    });
    const modelStartedAt = Date.now();
    const response = await this.deps.modelService.generate(
      context.prompt,
      context.mode === 'deep' ? GUARDIAN_DEEP_SYSTEM_PROMPT : GUARDIAN_SYSTEM_PROMPT,
      'guardian',
      input.obsidianContext,
      input.userProfile,
      {
        ...GUARDIAN_GENERATION_OPTIONS,
        // deep 模式给更高 temperature,为「连接/惊喜」留发挥空间;fast 保持稳健。
        temperature: context.mode === 'deep' ? 0.5 : GUARDIAN_GENERATION_OPTIONS.temperature,
        signal: input.signal,
      },
    );
    this.emitDiagnostic({
      stage: 'model-finished',
      requestId: input.requestId,
      activePath: input.activePath,
      elapsedMs: Date.now() - modelStartedAt,
      responseLength: response.length,
    });

    if (input.isStale?.()) return { type: 'none', reason: 'stale' };

    if (!response.trim()) {
      this.emitDiagnostic({
        stage: 'empty-response',
        requestId: input.requestId,
        activePath: input.activePath,
        responseLength: response.length,
      });
      return { type: 'none', reason: 'empty-response' };
    }

    const parsed = parseGuardianJson(response);
    let suggestion: string;
    if (!parsed) {
      suggestion = extractPlainSuggestion(response);
      if (!suggestion) {
        this.emitDiagnostic({
          stage: 'response-parse-failed',
          requestId: input.requestId,
          activePath: input.activePath,
          responseLength: response.length,
          responsePreview: previewResponse(response),
        });
        return { type: 'none', reason: 'invalid-json' };
      }
    } else {
      if (parsed.type === 'none') return { type: 'none', reason: 'explicit-none' };
      if (parsed.type !== 'completion') return { type: 'none', reason: 'unexpected-type' };
      if (typeof parsed.suggestion !== 'string') return { type: 'none', reason: 'missing-suggestion' };
      suggestion = parsed.suggestion.trim();
    }
    // 超长不再整条丢弃：截到最近的句子/子句边界，保留有用的前半段。
    // 模型常「首句到位、后面啰嗦」，截断比丢弃更能真正帮到写作。
    if (suggestion.length > this.maxSuggestionChars()) {
      suggestion = truncateToBoundary(suggestion, this.maxSuggestionChars());
    }
    const quality = this.evaluateSuggestion(suggestion, context);
    if (!quality.ok) return { type: 'none', reason: quality.reasons[0] || 'low-quality' };

    this.writeCache(cacheKey, suggestion, quality);

    return {
      type: 'completion',
      suggestion,
      line: context.line,
      ch: context.ch,
      quality,
    };
  }

  evaluateSuggestion(suggestion: string, context: Pick<GuardianCompletionContext, 'cursorPrefix' | 'cursorSuffix' | 'currentLine' | 'markdownShape' | 'localBlock'>): GuardianQualityDecision {
    const reasons: string[] = [];
    const trimmed = suggestion.trim();
    const normalizedSuggestion = normalizeForComparison(trimmed);
    const normalizedPrefix = normalizeForComparison(context.cursorPrefix);
    const normalizedLine = normalizeForComparison(context.currentLine);
    const normalizedSuffix = normalizeForComparison(context.cursorSuffix || '');

    if (!trimmed) reasons.push('empty');
    if (normalizedSuggestion && (normalizedSuggestion === normalizedPrefix || normalizedSuggestion === normalizedLine)) {
      reasons.push('repeats-input');
    }
    // 与光标后已有文本重复：补出来的内容用户已经写了，纯属噪音。
    if (normalizedSuggestion && normalizedSuffix && (normalizedSuggestion === normalizedSuffix || normalizedSuffix.startsWith(normalizedSuggestion))) {
      reasons.push('duplicates-suffix');
    }
    // 纯标点/无实质字符：没有任何字母数字或 CJK 字符,等于没补。
    if (trimmed && !/[\p{L}\p{N}]/u.test(trimmed)) {
      reasons.push('no-substance');
    }
    // 套话开头：以「总的来说/综上/总而言之/总结一下」等空洞过渡词起头的填充。
    if (FILLER_OPENING.test(trimmed)) {
      reasons.push('filler-opening');
    }
    if (trimmed.length > this.maxSuggestionChars()) {
      reasons.push('too-long');
    }
    if (/\b(as an ai|作为ai|作为 AI|根据知识库|knowledge base)\b/i.test(trimmed)) {
      reasons.push('meta-commentary');
    }
    if ((context.markdownShape === 'list' || context.markdownShape === 'task') && /^#{1,6}\s/.test(trimmed)) {
      reasons.push('wrong-markdown-shape');
    }
    if (context.markdownShape === 'heading' && /^[-*+]\s/.test(trimmed)) {
      reasons.push('wrong-markdown-shape');
    }

    return { ok: reasons.length === 0, reasons };
  }

  private buildPrompt(context: GuardianCompletionContext): string {
    const lines = [
      '[Task]',
      'Continue the note at the cursor only when you are confident it genuinely helps. Return JSON: {"type":"completion","suggestion":"..."} or {"type":"none"}.',
      'Prefer {"type":"none"} whenever: the current sentence already reads as finished, the cursor sits mid-word, the intent is ambiguous, or the only continuation you can think of is generic filler.',
      'When you do continue, write one focused, concrete continuation that advances the specific idea — usually one complete sentence, or one complete list item when in a list. Never pad with vague throat-clearing.',
      'Do not output reasoning, explanations, markdown fences, or commentary.',
      'Target about 60-180 characters when the context supports it. Keep it focused enough to accept inline. Do not repeat text before or after the cursor.',
    ];

    // 连接意图(仅 deep):有相关笔记时,鼓励做有依据、点出处的连接,而非平铺续写。
    if (context.mode === 'deep') {
      lines.push('When the relevant notes below genuinely connect to what is being written, prefer a continuation that surfaces that connection or insight (cite the note title), instead of a plain forward continuation. Only do this when the connection is real — never force it.');
    }

    lines.push('', `[Markdown Shape] ${context.markdownShape}`);

    // 作者画像(两模式都用):让补全贴合用户的语言/风格/领域,而非通用腔调。
    if (context.voiceHint) {
      lines.push('[Author Profile]');
      lines.push(context.voiceHint);
    }

    if (context.currentHeading) {
      lines.push(`[Heading] ${context.currentHeading}`);
    }
    if (context.knowledgeContext) {
      lines.push('[Relevant Knowledge]');
      lines.push(context.knowledgeContext);
    }
    if (context.recentContext) {
      lines.push('[Recent Context]');
      lines.push(context.recentContext);
    }
    lines.push('[Current Block]');
    lines.push(context.localBlock);
    lines.push('[Cursor]');
    lines.push(`${context.cursorPrefix}<CURSOR>${context.cursorSuffix}`);
    lines.push('');
    lines.push('Return only JSON.');

    return lines.join('\n');
  }

  private async selectKnowledgeContext(input: {
    mode: GuardianCompletionMode;
    cursorPrefix: string;
    localBlock: string;
    currentHeading: string | null;
    obsidianContext?: ObsidianContextSnapshot;
    requestId?: number;
    activePath?: string;
  }): Promise<string> {
    const runtime = this.deps.knowledgeRuntime;
    const deep = input.mode === 'deep';
    // deep 读正文(更慢更值);fast 读元数据(亚秒级)。任一缺失则跳过。
    const fetcher = deep
      ? runtime?.getGuardianDeepKnowledgeContext
      : runtime?.getGuardianKnowledgeContext;
    if (!fetcher) return '';

    const signals = [
      input.currentHeading || '',
      ...(input.obsidianContext?.tags || []),
      ...(input.obsidianContext?.outgoingLinks || []),
      input.cursorPrefix,
      input.localBlock,
    ]
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (stripMarkdownPrefix(signals).length < 12) return '';

    const startedAt = Date.now();
    const query = signals.slice(0, 600);
    // 知识超时:fast 放宽到 400ms(原 120 太苛刻,本地检索常被误丢);deep 给 2500ms 读文件。
    const timeoutMs = deep
      ? (this.deps.deepKnowledgeTimeoutMs ?? 2500)
      : (this.deps.knowledgeTimeoutMs ?? 400);
    const startStage = deep ? 'deep-knowledge-start' : 'knowledge-start';
    const finishStage = deep ? 'deep-knowledge-finished' : 'knowledge-finished';

    this.emitDiagnostic({
      stage: startStage,
      requestId: input.requestId,
      activePath: input.activePath,
      contextLength: query.length,
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const raw = await Promise.race([
      fetcher.call(runtime, query),
      new Promise<string>((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          this.emitDiagnostic({
            stage: 'knowledge-timeout',
            requestId: input.requestId,
            activePath: input.activePath,
            elapsedMs: Date.now() - startedAt,
          });
          resolve('');
        }, timeoutMs);
      }),
    ]);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (raw) {
      this.emitDiagnostic({
        stage: finishStage,
        requestId: input.requestId,
        activePath: input.activePath,
        elapsedMs: Date.now() - startedAt,
        knowledgeLength: raw.length,
      });
    } else if (!timedOut) {
      this.emitDiagnostic({
        stage: finishStage,
        requestId: input.requestId,
        activePath: input.activePath,
        elapsedMs: Date.now() - startedAt,
        knowledgeLength: 0,
      });
    }
    return trimKnowledgeContext(raw);
  }

  private emitDiagnostic(event: GuardianCompletionDiagnosticEvent): void {
    this.deps.diagnostics?.(event);
  }

  private buildCacheKey(context: GuardianCompletionContext): string {
    // 键含光标前后文、markdown 形态与局部块：任一变化即视为新上下文,不复用旧补全。
    return [
      context.line,
      context.markdownShape,
      context.cursorPrefix,
      context.cursorSuffix,
      context.localBlock,
    ].join(' ');
  }

  private readCache(key: string): { suggestion: string; quality: GuardianQualityDecision } | null {
    const entry = this.completionCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.completionCache.delete(key);
      return null;
    }
    // 触碰即刷新 LRU 顺序：删后重插,使其排到 Map 末尾。
    this.completionCache.delete(key);
    this.completionCache.set(key, entry);
    return { suggestion: entry.suggestion, quality: entry.quality };
  }

  private writeCache(key: string, suggestion: string, quality: GuardianQualityDecision): void {
    const ttl = this.deps.cacheTtlMs ?? 5000;
    if (ttl <= 0) return;
    this.completionCache.set(key, { suggestion, quality, expiresAt: Date.now() + ttl });
    // 容量上限：超出则按插入顺序淘汰最旧条目（Map 迭代序即插入序）。
    while (this.completionCache.size > GuardianCompletionService.CACHE_MAX_ENTRIES) {
      const oldest = this.completionCache.keys().next().value;
      if (oldest === undefined) break;
      this.completionCache.delete(oldest);
    }
  }

  private isIgnoredPath(path: string): boolean {
    if (!path) return false;
    const normalized = path.replace(/\\/g, '/');
    return (this.deps.settings.ignoredFolders || '')
      .split(/\r?\n/)
      .map((item) => item.trim().replace(/\\/g, '/'))
      .filter(Boolean)
      .some((pattern) => normalized === pattern || normalized.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`));
  }

  private minTriggerChars(): number {
    const sensitivity = clamp(this.deps.settings.guardianSensitivity ?? 50, 0, 100);
    return sensitivity >= 75 ? 1 : sensitivity >= 35 ? 2 : 3;
  }

  private maxSuggestionChars(): number {
    const sensitivity = clamp(this.deps.settings.guardianSensitivity ?? 50, 0, 100);
    return sensitivity >= 70 ? 220 : 280;
  }

  private getLineCount(editor: GuardianEditorLike, cursorLine: number): number {
    if (typeof editor.lineCount === 'function') return editor.lineCount();
    let count = cursorLine + 1;
    while (editor.getLine(count)) count += 1;
    return count;
  }

  private detectMarkdownShape(editor: GuardianEditorLike, cursorLine: number): GuardianMarkdownShape {
    if (this.isInsideCodeFence(editor, cursorLine)) return 'code';
    const line = editor.getLine(cursorLine) || '';
    if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) return 'task';
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) return 'list';
    if (/^#{1,6}\s+/.test(line)) return 'heading';
    return 'paragraph';
  }

  private extractLocalBlock(editor: GuardianEditorLike, cursorLine: number, lineCount: number, shape: GuardianMarkdownShape): string {
    const isBoundary = (line: string) => {
      if (!line.trim()) return true;
      if (shape !== 'heading' && /^#{1,6}\s+/.test(line)) return true;
      if ((shape === 'list' || shape === 'task') && !/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) return true;
      return false;
    };

    let start = cursorLine;
    while (start > 0 && !isBoundary(editor.getLine(start - 1) || '')) {
      start -= 1;
    }

    let end = cursorLine;
    while (end + 1 < lineCount && !isBoundary(editor.getLine(end + 1) || '')) {
      end += 1;
    }

    const lines: string[] = [];
    for (let i = start; i <= end; i += 1) {
      lines.push(editor.getLine(i) || '');
    }
    return lines.join('\n').slice(0, 900);
  }

  private extractRecentContext(editor: GuardianEditorLike, cursorLine: number): string {
    const lines: string[] = [];
    const start = Math.max(0, cursorLine - 4);
    for (let i = start; i <= cursorLine; i += 1) {
      lines.push(editor.getLine(i) || '');
    }
    return lines.join('\n').slice(0, 700);
  }

  private findHeading(editor: GuardianEditorLike, cursorLine: number): string | null {
    for (let i = cursorLine; i >= 0; i -= 1) {
      const line = (editor.getLine(i) || '').trim();
      if (/^#{1,6}\s+/.test(line)) return line;
    }
    return null;
  }

  private isInsideCodeFence(editor: GuardianEditorLike, cursorLine: number): boolean {
    let fences = 0;
    for (let i = 0; i <= cursorLine; i += 1) {
      if (/^\s*```/.test(editor.getLine(i) || '')) fences += 1;
    }
    return fences % 2 === 1;
  }
}

function parseGuardianJson(response: string): any | null {
  for (let start = response.indexOf('{'); start >= 0; start = response.indexOf('{', start + 1)) {
    const candidate = extractJsonObjectAt(response, start);
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function extractJsonObjectAt(response: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < response.length; i += 1) {
    const ch = response[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return response.slice(start, i + 1);
    }
  }
  return null;
}

function extractPlainSuggestion(response: string): string {
  const trimmed = response
    .trim()
    .replace(/^```(?:json|markdown|md)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  if (!trimmed) return '';
  if (/^\s*(?:sure|当然|可以|以下是|here is|as an ai)\b/i.test(trimmed)) return '';
  if (trimmed.includes('{') || trimmed.includes('}')) return '';

  const firstLine = trimmed.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  return firstLine.slice(0, 160).trim();
}

function previewResponse(response: string): string {
  return response
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function trimKnowledgeContext(value: string): string {
  if (!value.trim()) return '';
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join('\n')
    .slice(0, 500);
}

function normalizeForComparison(value: string): string {
  return stripMarkdownPrefix(value)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function stripMarkdownPrefix(value: string): string {
  return value
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/^\s*\[[ xX]\]\s+/, '')
    .trim();
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * 从 UserProfile 拼一行紧凑「作者画像」,注入补全 prompt,让续写贴合用户语气/领域。
 * 直接注入而非走 planner——planner 是聊天导向的重 prompt,且补全要求全局 systemPrompt 不泄漏。
 * profile 缺省/字段空 → 返回空串(调用方据此不注入,保证零副作用)。
 */
function buildVoiceHint(profile?: UserProfile | null): string {
  if (!profile) return '';
  const parts: string[] = [];
  const style = profile.preferences?.responseStyle?.trim();
  const language = profile.preferences?.language?.trim();
  const expertise = (profile.expertise || []).filter(Boolean).slice(0, 4);
  const topics = (profile.preferences?.topics || []).filter(Boolean).slice(0, 4);
  const projects = (profile.context?.currentProjects || []).filter(Boolean).slice(0, 3);

  if (language) parts.push(`Writes in ${language}`);
  if (style) parts.push(`preferred style: ${style}`);
  if (profile.profession?.trim()) parts.push(`role: ${profile.profession.trim()}`);
  if (expertise.length) parts.push(`expertise: ${expertise.join(', ')}`);
  if (topics.length) parts.push(`recurring topics: ${topics.join(', ')}`);
  if (projects.length) parts.push(`current projects: ${projects.join(', ')}`);

  if (parts.length === 0) return '';
  return `Match this writer — ${parts.join('; ')}. Mirror their voice, do not announce these facts.`;
}

// 空洞过渡词开头：中英文常见套话,补全以此起头几乎都是填充而非实质内容。
// 用负向前瞻 (?![a-z]) 代替 \b——\b 基于 \w,对 CJK 字符无效。
const FILLER_OPENING = /^\s*(?:总的来说|综上所述|综上|总而言之|总结一下|总结来说|一般来说|总体而言|众所周知|不言而喻|值得一提的是|需要注意的是|in conclusion|in summary|to sum up|overall|generally speaking|it is worth noting that|needless to say)(?![a-z])/i;

// 句子结束标点（中英文）：截断时优先在此处断开,保留完整句。
const SENTENCE_END = /[。！？!?…]/g;
// 子句边界标点：次选断点,保留完整子句。
const CLAUSE_END = /[；;，,、)）]/g;

/**
 * 把超长补全截到最近的语义边界,而非整条丢弃。
 * 优先级：limit 内最后一个句末标点 > 最后一个子句标点 > 最后一个空白(英文词边界) > 硬截。
 * 句末标点保留,子句/空白处的尾随标点去掉,避免留下半截标点。
 */
function truncateToBoundary(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;

  const window = trimmed.slice(0, limit);

  const lastSentenceEnd = lastMatchIndex(window, SENTENCE_END);
  if (lastSentenceEnd >= limit * 0.4) {
    return window.slice(0, lastSentenceEnd + 1).trim();
  }

  const lastClauseEnd = lastMatchIndex(window, CLAUSE_END);
  if (lastClauseEnd >= limit * 0.4) {
    return window.slice(0, lastClauseEnd).trim().replace(/[，,、；;]+$/, '');
  }

  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace >= limit * 0.4) {
    return window.slice(0, lastSpace).trim();
  }

  return window.trim();
}

function lastMatchIndex(text: string, pattern: RegExp): number {
  let result = -1;
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    result = match.index;
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
  }
  return result;
}
