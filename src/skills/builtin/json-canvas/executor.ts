import { BuiltinExecutor } from '../../skill-registry';
import { Tool } from '../../types';
import { ToolRegistry } from '../../tool-registry';

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
  async execute(args) {
    return validateCanvasContent(args?.content);
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error: unknown) {
    return { success: false, errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { success: false, errors: ['Canvas root must be an object'] };
  }
  const canvas = parsed as Record<string, unknown>;

  const nodes = canvas.nodes ?? [];
  const edges = canvas.edges ?? [];
  if (!Array.isArray(nodes)) errors.push('nodes must be an array when present');
  if (!Array.isArray(edges)) errors.push('edges must be an array when present');
  if (errors.length > 0) return { success: false, errors };

  const nodeList: unknown[] = Array.isArray(nodes) ? nodes : [];
  const edgeList: unknown[] = Array.isArray(edges) ? edges : [];

  const nodeIds = new Set<string>();
  const allIds = new Set<string>();

  nodeList.forEach((rawNode, index) => {
    const node = asFields(rawNode);
    validateId(node.id, `nodes[${index}].id`, allIds, errors);
    if (typeof node.id === 'string') nodeIds.add(node.id);

    if (!inSet(NODE_TYPES, node.type)) {
      errors.push(`nodes[${index}].type must be one of text, file, link, group`);
    }

    for (const field of ['x', 'y', 'width', 'height']) {
      if (!Number.isInteger(node[field])) {
        errors.push(`nodes[${index}].${field} must be an integer`);
      }
    }

    if (node.type === 'text' && typeof node.text !== 'string') {
      errors.push(`nodes[${index}] text nodes require a text field`);
    }
    if (node.type === 'file' && typeof node.file !== 'string') {
      errors.push(`nodes[${index}] file nodes require a file field`);
    }
    if (node.type === 'link' && typeof node.url !== 'string') {
      errors.push(`nodes[${index}] link nodes require a url field`);
    }
  });

  edgeList.forEach((rawEdge, index) => {
    const edge = asFields(rawEdge);
    validateId(edge.id, `edges[${index}].id`, allIds, errors);
    for (const field of ['fromNode', 'toNode']) {
      const target = edge[field];
      if (typeof target !== 'string') {
        errors.push(`edges[${index}].${field} must be a node id`);
      } else if (!nodeIds.has(target)) {
        errors.push(`edges[${index}].${field} references missing node "${target}"`);
      }
    }

    for (const field of ['fromSide', 'toSide']) {
      if (edge[field] !== undefined && !inSet(SIDES, edge[field])) {
        errors.push(`edges[${index}].${field} must be one of top, right, bottom, left`);
      }
    }

    for (const field of ['fromEnd', 'toEnd']) {
      if (edge[field] !== undefined && !inSet(ENDS, edge[field])) {
        errors.push(`edges[${index}].${field} must be none or arrow`);
      }
    }
  });

  return { success: errors.length === 0, errors };
}

/** 数组元素可能是任意 JSON 值;非对象(null/原始值)按「没有任何字段」读取。 */
function asFields(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** 集合成员判断:非字符串必然不在(集合里只有字符串)。 */
function inSet(set: Set<string>, value: unknown): boolean {
  return typeof value === 'string' && set.has(value);
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
