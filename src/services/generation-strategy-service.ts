import { UserProfile } from '../memory/types';
import { ObsidianContextSnapshot } from './obsidian-context-service';

export type GenerationSource = 'shell' | 'guardian' | 'selection-menu' | 'slash-edit';

export type GenerationMode =
  | 'co-write'
  | 'rewrite'
  | 'structure'
  | 'summarize'
  | 'knowledge-link'
  | 'archive'
  | 'naming';

export interface WritingProfile {
  responseStyle: 'concise' | 'balanced' | 'detailed';
  prefersLists: boolean;
  headingDensity: 'low' | 'medium' | 'high';
  noteTone: 'neutral' | 'technical' | 'reflective' | 'action-oriented';
  bannedPhrases: string[];
}

export interface GenerationPlan {
  source: GenerationSource;
  mode: GenerationMode;
  targetShape: 'replacement' | 'outline' | 'answer' | 'knowledge-entry';
  previewRequired: boolean;
  mustPreserveVoice: boolean;
  mustUseObsidianMarkdown: boolean;
  qualityChecklist: string[];
}

export function formatGenerationPlanBlock(
  generationPlan: GenerationPlan,
  writingProfile?: WritingProfile,
): string {
  const lines = [
    '[Generation Plan]',
    `Source: ${generationPlan.source}`,
    `Mode: ${generationPlan.mode}`,
    `Target Shape: ${generationPlan.targetShape}`,
    `Preview Required: ${generationPlan.previewRequired ? 'yes' : 'no'}`,
    `Preserve Voice: ${generationPlan.mustPreserveVoice ? 'yes' : 'no'}`,
    `Use Obsidian Markdown: ${generationPlan.mustUseObsidianMarkdown ? 'yes' : 'no'}`,
  ];

  if (writingProfile) {
    lines.push(
      `Writing Profile: style=${writingProfile.responseStyle}, tone=${writingProfile.noteTone}, headings=${writingProfile.headingDensity}, prefersLists=${writingProfile.prefersLists ? 'yes' : 'no'}`,
    );
  }

  if (generationPlan.qualityChecklist.length > 0) {
    lines.push('Quality Checklist:');
    for (const item of generationPlan.qualityChecklist) {
      lines.push(`- ${item}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

interface ResolvePlanInput {
  userMessage: string;
  source: GenerationSource;
  context: ObsidianContextSnapshot;
  profile?: UserProfile | null;
}

const DEFAULT_WRITING_PROFILE: WritingProfile = {
  responseStyle: 'balanced',
  prefersLists: false,
  headingDensity: 'low',
  noteTone: 'neutral',
  bannedPhrases: ['作为 AI', 'As an AI'],
};

export class GenerationStrategyService {
  resolvePlan(input: ResolvePlanInput): GenerationPlan {
    const normalizedMessage = input.userMessage.trim().toLowerCase();

    if (input.source === 'selection-menu' || input.source === 'slash-edit') {
      return {
        source: input.source,
        mode: 'rewrite',
        targetShape: 'replacement',
        previewRequired: true,
        mustPreserveVoice: true,
        mustUseObsidianMarkdown: true,
        qualityChecklist: [
          'Return only the revised replacement text.',
          'Preserve markdown structure, links, and task syntax.',
          'Improve clarity or structure beyond surface-level word swaps.',
        ],
      };
    }

    if (this.isStructureRequest(normalizedMessage)) {
      return {
        source: input.source,
        mode: 'structure',
        targetShape: 'outline',
        previewRequired: false,
        mustPreserveVoice: true,
        mustUseObsidianMarkdown: true,
        qualityChecklist: [
          'Produce a scan-friendly outline with meaningful headings or bullet groups.',
          'Keep markdown valid for Obsidian, including task lists and links.',
          'Do not drop concrete details that anchor the note context.',
        ],
      };
    }

    if (input.source === 'guardian') {
      return {
        source: input.source,
        mode: 'co-write',
        targetShape: 'replacement',
        previewRequired: false,
        mustPreserveVoice: true,
        mustUseObsidianMarkdown: true,
        qualityChecklist: [
          'Continue the note naturally from the current context.',
          'Stay close to the note voice and local structure.',
          'Return markdown-ready text without meta commentary.',
        ],
      };
    }

    return {
      source: input.source,
      mode: 'summarize',
      targetShape: 'answer',
      previewRequired: false,
      mustPreserveVoice: false,
      mustUseObsidianMarkdown: true,
      qualityChecklist: [
        'Answer the request directly.',
        'Prefer markdown structure that matches the request.',
        'Ground the answer in the available note context.',
      ],
    };
  }

  buildWritingProfile(
    context: ObsidianContextSnapshot,
    profile?: UserProfile | null,
  ): WritingProfile {
    const responseStyle = this.normalizeResponseStyle(profile?.preferences?.responseStyle);
    const noteBody = context.contextItems
      .map((item) => item.content || '')
      .join('\n');

    const prefersLists = /(^|\n)\s*[-*]\s|\[[ xX]\]/.test(noteBody);
    const headingMatches = noteBody.match(/^#{1,6}\s+/gm) ?? [];
    const headingDensity = headingMatches.length >= 3
      ? 'high'
      : headingMatches.length >= 1
        ? 'medium'
        : 'low';
    const noteTone = /```|`[^`]+`|\bconst\b|\bfunction\b|\bapi\b/i.test(noteBody)
      ? 'technical'
      : /\breflect|journal|feeling|思考|复盘/i.test(noteBody)
        ? 'reflective'
        : /\bnext step|todo|plan|行动|待办/i.test(noteBody)
          ? 'action-oriented'
          : 'neutral';

    return {
      responseStyle,
      prefersLists,
      headingDensity,
      noteTone,
      bannedPhrases: [...DEFAULT_WRITING_PROFILE.bannedPhrases],
    };
  }

  private isStructureRequest(message: string): boolean {
    return /重组|大纲|outline|structure|结构/.test(message);
  }

  private normalizeResponseStyle(
    value: string | undefined,
  ): WritingProfile['responseStyle'] {
    if (value === 'concise' || value === 'detailed' || value === 'balanced') {
      return value;
    }
    return DEFAULT_WRITING_PROFILE.responseStyle;
  }
}
