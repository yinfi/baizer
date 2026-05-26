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
    return validateCanvasContent(args.content);
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

  let canvas: any;
  try {
    canvas = JSON.parse(content);
  } catch (error: any) {
    return { success: false, errors: [`Invalid JSON: ${error.message}`] };
  }

  if (!canvas || typeof canvas !== 'object' || Array.isArray(canvas)) {
    return { success: false, errors: ['Canvas root must be an object'] };
  }

  const nodes = canvas.nodes ?? [];
  const edges = canvas.edges ?? [];
  if (!Array.isArray(nodes)) errors.push('nodes must be an array when present');
  if (!Array.isArray(edges)) errors.push('edges must be an array when present');
  if (errors.length > 0) return { success: false, errors };

  const nodeIds = new Set<string>();
  const allIds = new Set<string>();

  nodes.forEach((node: any, index: number) => {
    validateId(node?.id, `nodes[${index}].id`, allIds, errors);
    if (typeof node?.id === 'string') nodeIds.add(node.id);

    if (!NODE_TYPES.has(node?.type)) {
      errors.push(`nodes[${index}].type must be one of text, file, link, group`);
    }

    for (const field of ['x', 'y', 'width', 'height']) {
      if (!Number.isInteger(node?.[field])) {
        errors.push(`nodes[${index}].${field} must be an integer`);
      }
    }

    if (node?.type === 'text' && typeof node.text !== 'string') {
      errors.push(`nodes[${index}] text nodes require a text field`);
    }
    if (node?.type === 'file' && typeof node.file !== 'string') {
      errors.push(`nodes[${index}] file nodes require a file field`);
    }
    if (node?.type === 'link' && typeof node.url !== 'string') {
      errors.push(`nodes[${index}] link nodes require a url field`);
    }
  });

  edges.forEach((edge: any, index: number) => {
    validateId(edge?.id, `edges[${index}].id`, allIds, errors);
    for (const field of ['fromNode', 'toNode']) {
      if (typeof edge?.[field] !== 'string') {
        errors.push(`edges[${index}].${field} must be a node id`);
      } else if (!nodeIds.has(edge[field])) {
        errors.push(`edges[${index}].${field} references missing node "${edge[field]}"`);
      }
    }

    for (const field of ['fromSide', 'toSide']) {
      if (edge?.[field] !== undefined && !SIDES.has(edge[field])) {
        errors.push(`edges[${index}].${field} must be one of top, right, bottom, left`);
      }
    }

    for (const field of ['fromEnd', 'toEnd']) {
      if (edge?.[field] !== undefined && !ENDS.has(edge[field])) {
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
