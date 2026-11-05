import { BuiltinExecutor } from '../../skill-registry';
import { Tool } from '../../types';
import { ToolRegistry } from '../../tool-registry';
import { thrownMessage } from '../../../utils/thrown-message';

const NODE_TYPES = new Set(['text', 'file', 'link', 'group']);
const SIDES = new Set(['top', 'right', 'bottom', 'left']);
const ENDS = new Set(['none', 'arrow']);

/** 工具 args 是模型生成的 JSON，.canvas 内容也是外部输入：先窄化再读字段。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** 只在类型正确时取字符串，避免把非字符串值塞进 Set.has / 模板串。 */
function readStringField(value: unknown, key: string): string | undefined {
  const field = readField(value, key);
  return typeof field === 'string' ? field : undefined;
}

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
    return validateCanvasContent(readField(args, 'content'));
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
  } catch (error: unknown) {
    return { success: false, errors: [`Invalid JSON: ${thrownMessage(error)}`] };
  }

  if (!isRecord(canvas)) {
    return { success: false, errors: ['Canvas root must be an object'] };
  }

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
    const nodeId = readStringField(node, 'id');
    validateId(nodeId, `nodes[${index}].id`, allIds, errors);
    if (nodeId !== undefined) nodeIds.add(nodeId);

    const nodeType = readStringField(node, 'type');
    if (!nodeType || !NODE_TYPES.has(nodeType)) {
      errors.push(`nodes[${index}].type must be one of text, file, link, group`);
    }

    for (const field of ['x', 'y', 'width', 'height']) {
      if (!Number.isInteger(readField(node, field))) {
        errors.push(`nodes[${index}].${field} must be an integer`);
      }
    }

    if (nodeType === 'text' && typeof readField(node, 'text') !== 'string') {
      errors.push(`nodes[${index}] text nodes require a text field`);
    }
    if (nodeType === 'file' && typeof readField(node, 'file') !== 'string') {
      errors.push(`nodes[${index}] file nodes require a file field`);
    }
    if (nodeType === 'link' && typeof readField(node, 'url') !== 'string') {
      errors.push(`nodes[${index}] link nodes require a url field`);
    }
  });

  edges.forEach((edge: unknown, index: number) => {
    validateId(readField(edge, 'id'), `edges[${index}].id`, allIds, errors);
    for (const field of ['fromNode', 'toNode']) {
      const value = readStringField(edge, field);
      if (value === undefined) {
        errors.push(`edges[${index}].${field} must be a node id`);
      } else if (!nodeIds.has(value)) {
        errors.push(`edges[${index}].${field} references missing node "${value}"`);
      }
    }

    for (const field of ['fromSide', 'toSide']) {
      const value = readField(edge, field);
      if (value !== undefined && !(typeof value === 'string' && SIDES.has(value))) {
        errors.push(`edges[${index}].${field} must be one of top, right, bottom, left`);
      }
    }

    for (const field of ['fromEnd', 'toEnd']) {
      const value = readField(edge, field);
      if (value !== undefined && !(typeof value === 'string' && ENDS.has(value))) {
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
