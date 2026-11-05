import { parse } from 'yaml';
import { BuiltinExecutor } from '../../skill-registry';
import { Tool } from '../../types';
import { ToolRegistry } from '../../tool-registry';
import { thrownMessage } from '../../../utils/thrown-message';

const VIEW_TYPES = new Set(['table', 'cards', 'list', 'map']);

/** 工具 args 是模型生成的 JSON，.base 内容也是外部输入：先窄化再读字段。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isObjectValue(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function readField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

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
    return validateBaseYamlContent(readField(args, 'content'));
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
  } catch (error: unknown) {
    return { success: false, errors: [`Invalid YAML: ${thrownMessage(error)}`] };
  }

  const errors: string[] = [];
  if (!isRecord(base)) {
    return { success: false, errors: ['Base root must be a YAML object'] };
  }

  validateObjectField(base.formulas, 'formulas', errors);
  validateObjectField(base.properties, 'properties', errors);
  validateObjectField(base.summaries, 'summaries', errors);

  const views = base.views;
  if (!Array.isArray(views) || views.length === 0) {
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
    if (!isRecord(view)) {
      errors.push(`views[${index}] must be an object`);
      return;
    }

    const viewType = view.type;
    if (typeof viewType !== 'string' || !VIEW_TYPES.has(viewType)) {
      errors.push(`views[${index}].type must be one of table, cards, list, map`);
    }

    if (view.order !== undefined && !Array.isArray(view.order)) {
      errors.push(`views[${index}].order must be an array when present`);
    }

    if (view.filters !== undefined && !isFilterShape(view.filters)) {
      errors.push(`views[${index}].filters must be a filter string or filter object`);
    }

    if (view.groupBy !== undefined && !isRecord(view.groupBy)) {
      errors.push(`views[${index}].groupBy must be an object when present`);
    }

    validateObjectField(view.summaries, `views[${index}].summaries`, errors);
  });
}

function isFilterShape(value: unknown): boolean {
  return typeof value === 'string' || (!!value && typeof value === 'object' && !Array.isArray(value));
}

function validateFormulaReferences(base: Record<string, unknown>, errors: string[]): void {
  const formulas = isRecord(base.formulas)
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

  const properties = base.properties;
  if (isObjectValue(properties)) {
    for (const key of Object.keys(properties)) {
      addFormulaReference(key, references);
    }
  }

  const views = base.views;
  for (const view of Array.isArray(views) ? views : []) {
    const order = readField(view, 'order');
    for (const value of Array.isArray(order) ? order : []) {
      addFormulaReference(value, references);
    }
    const groupByProperty = readField(readField(view, 'groupBy'), 'property');
    if (groupByProperty) {
      addFormulaReference(groupByProperty, references);
    }
    const summaries = readField(view, 'summaries');
    if (isObjectValue(summaries)) {
      for (const key of Object.keys(summaries)) {
        addFormulaReference(key, references);
      }
    }
  }

  return [...references];
}

function addFormulaReference(value: unknown, references: Set<string>): void {
  if (typeof value === 'string' && value.startsWith('formula.')) {
    references.add(value);
  }
}
