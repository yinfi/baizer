import { parse } from 'yaml';
import { BuiltinExecutor } from '../../skill-registry';
import { Tool } from '../../types';
import { ToolRegistry } from '../../tool-registry';

const VIEW_TYPES = new Set(['table', 'cards', 'list', 'map']);

export const executor: BuiltinExecutor = {
  async execute() {
    return { ok: true };
  },
};

const validateBaseYaml: Tool = {
  name: 'validate_base_yaml',
  description: 'Validate Obsidian Bases YAML for parseability, view structure, and formula references.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The full .base YAML content to validate' },
    },
    required: ['content'],
  },
  executionMode: 'parallel',
  risk: 'read',
  async execute(args) {
    return validateBaseYamlContent(args?.content);
  },
};

export function registerTools(registry: ToolRegistry): void {
  registry.register(validateBaseYaml);
}

export function validateBaseYamlContent(content: unknown): { success: boolean; errors: string[] } {
  if (typeof content !== 'string') {
    return { success: false, errors: ['content must be a YAML string'] };
  }

  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch (error: unknown) {
    return { success: false, errors: [`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const errors: string[] = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { success: false, errors: ['Base root must be a YAML object'] };
  }
  const base = parsed as Record<string, unknown>;

  validateObjectField(base.formulas, 'formulas', errors);
  validateObjectField(base.properties, 'properties', errors);
  validateObjectField(base.summaries, 'summaries', errors);

  if (!Array.isArray(base.views) || base.views.length === 0) {
    errors.push('views must be a non-empty array');
  } else {
    validateViews(base.views, errors);
  }

  validateFormulaReferences(base, errors);
  return { success: errors.length === 0, errors };
}

function validateObjectField(value: unknown, label: string, errors: string[]): void {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    errors.push(`${label} must be an object when present`);
  }
}

function validateViews(views: unknown[], errors: string[]): void {
  views.forEach((rawView, index) => {
    if (!rawView || typeof rawView !== 'object' || Array.isArray(rawView)) {
      errors.push(`views[${index}] must be an object`);
      return;
    }
    const view = rawView as Record<string, unknown>;

    if (typeof view.type !== 'string' || !VIEW_TYPES.has(view.type)) {
      errors.push(`views[${index}].type must be one of table, cards, list, map`);
    }

    if (view.order !== undefined && !Array.isArray(view.order)) {
      errors.push(`views[${index}].order must be an array when present`);
    }

    if (view.filters !== undefined && !isFilterShape(view.filters)) {
      errors.push(`views[${index}].filters must be a filter string or filter object`);
    }

    if (view.groupBy !== undefined && (!view.groupBy || typeof view.groupBy !== 'object' || Array.isArray(view.groupBy))) {
      errors.push(`views[${index}].groupBy must be an object when present`);
    }

    validateObjectField(view.summaries, `views[${index}].summaries`, errors);
  });
}

function isFilterShape(value: unknown): boolean {
  return typeof value === 'string' || (!!value && typeof value === 'object' && !Array.isArray(value));
}

function validateFormulaReferences(base: Record<string, unknown>, errors: string[]): void {
  const formulas = base.formulas && typeof base.formulas === 'object' && !Array.isArray(base.formulas)
    ? new Set(Object.keys(base.formulas))
    : new Set<string>();

  for (const reference of collectFormulaReferences(base)) {
    const formulaName = reference.slice('formula.'.length);
    if (!formulas.has(formulaName)) {
      errors.push(`Reference ${reference} has no matching formulas.${formulaName} definition`);
    }
  }
}

function collectFormulaReferences(base: Record<string, unknown>): string[] {
  const references = new Set<string>();

  for (const key of Object.keys(truthyObject(base.properties))) {
    addFormulaReference(key, references);
  }

  const views: unknown[] = Array.isArray(base.views) ? base.views : [];
  for (const rawView of views) {
    const view = truthyObject(rawView);
    const order: unknown[] = Array.isArray(view.order) ? view.order : [];
    for (const value of order) {
      addFormulaReference(value, references);
    }
    const groupBy = truthyObject(view.groupBy);
    if (groupBy.property) {
      addFormulaReference(groupBy.property, references);
    }
    for (const key of Object.keys(truthyObject(view.summaries))) {
      addFormulaReference(key, references);
    }
  }

  return [...references];
}

/** 对象则原样返回,其余(含 null/原始值)视为空对象;对应旧代码的 `x?.y || {}` 读取。 */
function truthyObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function addFormulaReference(value: unknown, references: Set<string>): void {
  if (typeof value === 'string' && value.startsWith('formula.')) {
    references.add(value);
  }
}
