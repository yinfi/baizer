import { PluginSettings } from '../mcp/types';
import { GenerationOptions } from '../models/interfaces';
import { UserProfile } from '../memory/types';
import { ModelService } from '../services/model-service';
import { ObsidianContextSnapshot } from '../services/obsidian-context-service';

export type GuardianMarkdownShape = 'paragraph' | 'list' | 'task' | 'heading' | 'code';

export interface GuardianCompletionContext {
  currentLine: string;
  cursorPrefix: string;
  cursorSuffix: string;
  currentHeading: string | null;
  localBlock: string;
  recentContext: string;
  markdownShape: GuardianMarkdownShape;
  knowledgeContext: string;
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
}

interface GuardianCompletionServiceDeps {
  settings: PluginSettings;
  modelService: ModelService & { isGenerationConfigured?: () => boolean };
  knowledgeRuntime?: GuardianKnowledgeRuntimeLike | null;
  knowledgeTimeoutMs?: number;
  completionTimeoutMs?: number;
  diagnostics?: (event: GuardianCompletionDiagnosticEvent) => void;
}

export interface GuardianCompletionDiagnosticEvent {
  stage: 'build-context-start' | 'build-context-finished' | 'knowledge-start' | 'knowledge-finished' | 'knowledge-timeout' | 'model-start' | 'model-finished' | 'completion-timeout' | 'response-parse-failed' | 'empty-response';
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
  'Return ONLY one compact JSON object.',
  'Do not output reasoning, explanations, markdown fences, or commentary.',
  'Prefer short, natural continuations that preserve the user voice.',
  'Never explain yourself and never mention the knowledge context.',
].join(' ');

const GUARDIAN_GENERATION_OPTIONS: GenerationOptions = {
  temperature: 0.25,
  timeoutMs: 8000,
  skipGenerationPlan: true,
};

export function getGuardianAutoDelayMs(sensitivity: number): number {
  const clamped = clamp(sensitivity, 0, 100);
  return Math.round(1200 - (clamped * 4));
}

export class GuardianCompletionService {
  constructor(private readonly deps: GuardianCompletionServiceDeps) {}

  shouldRunAuto(input: { editor: GuardianEditorLike; activePath?: string }): TriggerDecision {
    const settings = this.deps.settings;
    if (!settings.enableGuardian) return { ok: false, reason: 'disabled' };
    if (!settings.guardianAutoMode) return { ok: false, reason: 'auto-disabled' };
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
    const knowledgeContext = await this.selectKnowledgeContext({
      cursorPrefix,
      localBlock,
      currentHeading,
      obsidianContext: input.obsidianContext,
      requestId: input.requestId,
      activePath: input.activePath,
    });
    const prompt = this.buildPrompt({
      currentLine: line,
      cursorPrefix,
      cursorSuffix,
      currentHeading,
      localBlock,
      recentContext,
      markdownShape,
      knowledgeContext,
      prompt: '',
      line: cursor.line + 1,
      ch,
    });

    return {
      currentLine: line,
      cursorPrefix,
      cursorSuffix,
      currentHeading,
      localBlock,
      recentContext,
      markdownShape,
      knowledgeContext,
      prompt,
      line: cursor.line + 1,
      ch,
    };
  }

  async completeAuto(input: GuardianCompletionRequest): Promise<GuardianCompletionResult> {
    const timeoutMs = this.deps.completionTimeoutMs ?? 9000;
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

    this.emitDiagnostic({
      stage: 'model-start',
      requestId: input.requestId,
      activePath: input.activePath,
      contextLength: context.prompt.length,
    });
    const modelStartedAt = Date.now();
    const response = await this.deps.modelService.generate(
      context.prompt,
      GUARDIAN_SYSTEM_PROMPT,
      'guardian',
      input.obsidianContext,
      input.userProfile,
      GUARDIAN_GENERATION_OPTIONS,
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
    const quality = this.evaluateSuggestion(suggestion, context);
    if (!quality.ok) return { type: 'none', reason: quality.reasons[0] || 'low-quality' };

    return {
      type: 'completion',
      suggestion,
      line: context.line,
      ch: context.ch,
      quality,
    };
  }

  evaluateSuggestion(suggestion: string, context: Pick<GuardianCompletionContext, 'cursorPrefix' | 'currentLine' | 'markdownShape' | 'localBlock'>): GuardianQualityDecision {
    const reasons: string[] = [];
    const trimmed = suggestion.trim();
    const normalizedSuggestion = normalizeForComparison(trimmed);
    const normalizedPrefix = normalizeForComparison(context.cursorPrefix);
    const normalizedLine = normalizeForComparison(context.currentLine);

    if (!trimmed) reasons.push('empty');
    if (normalizedSuggestion && (normalizedSuggestion === normalizedPrefix || normalizedSuggestion === normalizedLine)) {
      reasons.push('repeats-input');
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
      'Continue the note at the cursor. Return JSON: {"type":"completion","suggestion":"..."}.',
      'Default to returning a completion: a short phrase, clause, or next sentence fragment is useful.',
      'Use {"type":"none"} only when the cursor is inside code, the current line is clearly finished, or any continuation would be misleading.',
      'Do not output reasoning, explanations, markdown fences, or commentary.',
      'Keep the suggestion short enough to accept inline. Do not repeat text before the cursor.',
      '',
      `[Markdown Shape] ${context.markdownShape}`,
    ];

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
    cursorPrefix: string;
    localBlock: string;
    currentHeading: string | null;
    obsidianContext?: ObsidianContextSnapshot;
    requestId?: number;
    activePath?: string;
  }): Promise<string> {
    const runtime = this.deps.knowledgeRuntime;
    if (!runtime?.getGuardianKnowledgeContext) return '';

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
    this.emitDiagnostic({
      stage: 'knowledge-start',
      requestId: input.requestId,
      activePath: input.activePath,
      contextLength: query.length,
    });

    const timeoutMs = this.deps.knowledgeTimeoutMs ?? 120;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const raw = await Promise.race([
      runtime.getGuardianKnowledgeContext(query),
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
        stage: 'knowledge-finished',
        requestId: input.requestId,
        activePath: input.activePath,
        elapsedMs: Date.now() - startedAt,
        knowledgeLength: raw.length,
      });
    } else if (!timedOut) {
      this.emitDiagnostic({
        stage: 'knowledge-finished',
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
    return sensitivity >= 70 ? 110 : 140;
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
