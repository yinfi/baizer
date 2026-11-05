import { parse } from 'yaml';
import { BuiltinExecutor } from '../../skill-registry';
import { Tool } from '../../types';
import { ToolRegistry } from '../../tool-registry';
import { asArray, asRecord, asString, isPlainRecord, prop } from '../../../utils/narrow';

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
  async execute(args: unknown) {
    return validateBaseYamlContent(prop(args, 'content'));
  },
};

export function registerTools(registry: ToolRegistry): void {
  registry.register(validateBaseYaml);
}

export function validateBaseYamlContent(content: unknown): { success: boolean; errors: string[] } {
  if (typeof content !== 'string') {
    return { success: false, errors: ['content must be a YAML string'] };
  }

  let base: unknown;
  try {
    base = parse(content);
  } catch (error) {
    return { success: false, errors: [`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const errors: string[] = [];
  if (!isPlainRecord(base)) {
    return { success: false, errors: ['Base root must be a YAML object'] };
  }

  validateObjectField(base.formulas, 'formulas', errors);
  validateObjectField(base.properties, 'properties', errors);
  validateObjectField(base.summaries, 'summaries', errors);

  const views = asArray(base.views);
  if (!views || views.length === 0) {
    errors.push('views must be a non-empty array');
  } else {
    validateViews(views, errors);
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
  views.forEach((view, index) => {
    if (!isPlainRecord(view)) {
      errors.push(`views[${index}] must be an object`);
      return;
    }

    const viewType = asString(view.type);
    if (viewType === undefined || !VIEW_TYPES.has(viewType)) {
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
  const rawFormulas = base.formulas;
  const formulas = isPlainRecord(rawFormulas)
    ? new Set(Object.keys(rawFormulas))
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

  for (const key of Object.keys(asRecord(base.properties))) {
    addFormulaReference(key, references);
  }

  for (const view of asArray(base.views) ?? []) {
    for (const value of asArray(prop(view, 'order')) ?? []) {
      addFormulaReference(value, references);
    }
    const groupByProperty = prop(prop(view, 'groupBy'), 'property');
    if (groupByProperty) {
      addFormulaReference(groupByProperty, references);
    }
    for (const key of Object.keys(asRecord(prop(view, 'summaries')))) {
      addFormulaReference(key, references);
    }
  }

  return [...references];
}

function addFormulaReference(value: unknown, references: Set<string>): void {
  if (typeof value === 'string' && value.startsWith('formula.')) {
    references.add(value);
  }
}
