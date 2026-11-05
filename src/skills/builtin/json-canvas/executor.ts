import { BuiltinExecutor } from '../../skill-registry';
import { Tool } from '../../types';
import { ToolRegistry } from '../../tool-registry';
import { asString, isPlainRecord, prop } from '../../../utils/narrow';

const NODE_TYPES = new Set(['text', 'file', 'link', 'group']);
const SIDES = new Set(['top', 'right', 'bottom', 'left']);
const ENDS = new Set(['none', 'arrow']);

export const executor: BuiltinExecutor = {
  async execute() {
    return { ok: true };
  },
};

const validateJsonCanvas: Tool = {
  name: 'validate_json_canvas',
  description: 'Validate JSON Canvas content for parseability, unique IDs, required node fields, and valid edge references.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The full .canvas JSON content to validate' },
    },
    required: ['content'],
  },
  executionMode: 'parallel',
  risk: 'read',
  async execute(args: unknown) {
    return validateCanvasContent(prop(args, 'content'));
  },
};

export function registerTools(registry: ToolRegistry): void {
  registry.register(validateJsonCanvas);
}

export function validateCanvasContent(content: unknown): { success: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof content !== 'string') {
    return { success: false, errors: ['content must be a JSON string'] };
  }

  let canvas: unknown;
  try {
    canvas = JSON.parse(content);
  } catch (error) {
    return { success: false, errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }

  if (!isPlainRecord(canvas)) {
    return { success: false, errors: ['Canvas root must be an object'] };
  }

  // null/undefined 沿用改动前 `?? []` 的语义（视为未提供 → 空数组）；只有非数组才报错。
  const nodes = canvas.nodes ?? [];
  const edges = canvas.edges ?? [];
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    if (!Array.isArray(nodes)) errors.push('nodes must be an array when present');
    if (!Array.isArray(edges)) errors.push('edges must be an array when present');
    return { success: false, errors };
  }

  const nodeIds = new Set<string>();
  const allIds = new Set<string>();

  nodes.forEach((node: unknown, index: number) => {
    validateId(prop(node, 'id'), `nodes[${index}].id`, allIds, errors);
    const nodeId = asString(prop(node, 'id'));
    if (nodeId !== undefined) nodeIds.add(nodeId);

    const nodeType = asString(prop(node, 'type'));
    if (nodeType === undefined || !NODE_TYPES.has(nodeType)) {
      errors.push(`nodes[${index}].type must be one of text, file, link, group`);
    }

    for (const field of ['x', 'y', 'width', 'height']) {
      if (!Number.isInteger(prop(node, field))) {
        errors.push(`nodes[${index}].${field} must be an integer`);
      }
    }

    if (nodeType === 'text' && typeof prop(node, 'text') !== 'string') {
      errors.push(`nodes[${index}] text nodes require a text field`);
    }
    if (nodeType === 'file' && typeof prop(node, 'file') !== 'string') {
      errors.push(`nodes[${index}] file nodes require a file field`);
    }
    if (nodeType === 'link' && typeof prop(node, 'url') !== 'string') {
      errors.push(`nodes[${index}] link nodes require a url field`);
    }
  });

  edges.forEach((edge: unknown, index: number) => {
    validateId(prop(edge, 'id'), `edges[${index}].id`, allIds, errors);
    for (const field of ['fromNode', 'toNode']) {
      const nodeRef = asString(prop(edge, field));
      if (nodeRef === undefined) {
        errors.push(`edges[${index}].${field} must be a node id`);
      } else if (!nodeIds.has(nodeRef)) {
        errors.push(`edges[${index}].${field} references missing node "${nodeRef}"`);
      }
    }

    for (const field of ['fromSide', 'toSide']) {
      const side = prop(edge, field);
      if (side !== undefined && !SIDES.has(asString(side) ?? '')) {
        errors.push(`edges[${index}].${field} must be one of top, right, bottom, left`);
      }
    }

    for (const field of ['fromEnd', 'toEnd']) {
      const end = prop(edge, field);
      if (end !== undefined && !ENDS.has(asString(end) ?? '')) {
        errors.push(`edges[${index}].${field} must be none or arrow`);
      }
    }
  });

  return { success: errors.length === 0, errors };
}

function validateId(
  id: unknown,
  label: string,
  seen: Set<string>,
  errors: string[],
): void {
  if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) {
    errors.push(`${label} must be a unique 16-character lowercase hexadecimal string`);
    return;
  }

  if (seen.has(id)) {
    errors.push(`Duplicate id "${id}"`);
    return;
  }

  seen.add(id);
}
