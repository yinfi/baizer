import { GenerationPlan } from './generation-strategy-service';

interface EvaluateGenerationQualityInput {
  originalText?: string;
  generatedText: string;
  plan: GenerationPlan;
}

export function evaluateGenerationQuality(
  input: EvaluateGenerationQualityInput,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const generated = normalizeText(input.generatedText);
  const original = normalizeText(input.originalText || '');

  if (!generated) {
    reasons.push('Generated text is empty.');
  }

  if (input.plan.mode === 'rewrite' && original && generated === original) {
    reasons.push('Generated text is too close to the original text.');
  }

  if (input.plan.targetShape === 'outline' && !hasOutlineShape(input.generatedText)) {
    reasons.push('Expected outline-shaped markdown with headings or bullet groups.');
  }

  return {
    ok: reasons.length === 0,
    reasons,
  };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function hasOutlineShape(value: string): boolean {
  return /(^|\n)#{1,6}\s+/.test(value) || /(^|\n)\s*[-*]\s+/.test(value);
}
