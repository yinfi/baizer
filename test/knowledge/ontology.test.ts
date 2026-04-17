// test/knowledge/ontology.test.ts

import {
  parseOntologySchema,
  validateOntologySchema,
  computeSchemaHash,
  buildDiscoveryPrompt,
  parseDiscoveryResponse,
  buildOntologyFile,
  extractFrontmatter,
} from '../../src/knowledge/ontology';
import { OntologySchema } from '../../src/knowledge/types';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy`); },
    toBeFalsy: () => { if (actual) throw new Error(`Expected falsy`); },
    toBeDefined: () => { if (actual === undefined) throw new Error(`Expected defined`); },
    toBeNull: () => { if (actual !== null) throw new Error(`Expected null but got ${JSON.stringify(actual)}`); },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected))
        throw new Error(`Expected to contain "${expected}"`);
    },
    toHaveLength: (expected: number) => {
      if (!Array.isArray(actual) || actual.length !== expected)
        throw new Error(`Expected length ${expected} but got ${Array.isArray(actual) ? actual.length : 'non-array'}`);
    },
  };
}

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); process.exit(1); }
}

console.log('=== Ontology Tests ===');

// --- parseOntologySchema ---

test('parseOntologySchema returns valid schema from frontmatter', () => {
  const fm = {
    knowledge_artifact_type: 'ontology_schema',
    version: 1,
    categories: [
      { name: '心智模型', description: '可复用的思维框架' },
      { name: '方法论', description: '具体的操作方法' },
    ],
    entity_types: [
      { name: '人物', description: '文章中提到的关键人物' },
    ],
  };
  const schema = parseOntologySchema(fm);
  expect(schema).toBeDefined();
  expect(schema!.version).toBe(1);
  expect(schema!.categories).toHaveLength(2);
  expect(schema!.entity_types).toHaveLength(1);
  expect(schema!.categories[0].name).toBe('心智模型');
});

test('parseOntologySchema returns null for missing artifact_type', () => {
  const fm = { version: 1, categories: [{ name: 'A', description: 'B' }] };
  expect(parseOntologySchema(fm)).toBeNull();
});

test('parseOntologySchema returns null for empty categories and entity_types', () => {
  const fm = { knowledge_artifact_type: 'ontology_schema', categories: [], entity_types: [] };
  expect(parseOntologySchema(fm)).toBeNull();
});

test('parseOntologySchema returns null for null input', () => {
  expect(parseOntologySchema(null)).toBeNull();
});

test('parseOntologySchema filters invalid category entries', () => {
  const fm = {
    knowledge_artifact_type: 'ontology_schema',
    categories: [
      { name: '有效', description: '描述' },
      { name: '', description: '空名' },
      { description: '无名' },
      'not-an-object',
    ],
    entity_types: [],
  };
  const schema = parseOntologySchema(fm);
  expect(schema).toBeDefined();
  expect(schema!.categories).toHaveLength(1);
  expect(schema!.categories[0].name).toBe('有效');
});

// --- validateOntologySchema ---

test('validateOntologySchema passes for valid schema', () => {
  const schema: OntologySchema = {
    version: 1,
    categories: [{ name: 'A', description: 'desc' }],
    entity_types: [{ name: 'B', description: 'desc' }],
  };
  expect(validateOntologySchema(schema)).toHaveLength(0);
});

test('validateOntologySchema detects empty schema', () => {
  const schema: OntologySchema = { version: 1, categories: [], entity_types: [] };
  const errors = validateOntologySchema(schema);
  expect(errors.length > 0).toBeTruthy();
});

test('validateOntologySchema detects duplicate category names', () => {
  const schema: OntologySchema = {
    version: 1,
    categories: [
      { name: 'A', description: '1' },
      { name: 'A', description: '2' },
    ],
    entity_types: [],
  };
  const errors = validateOntologySchema(schema);
  expect(errors.length > 0).toBeTruthy();
});

// --- computeSchemaHash ---

test('computeSchemaHash returns consistent 8-char hex', () => {
  const hash1 = computeSchemaHash('some content');
  const hash2 = computeSchemaHash('some content');
  expect(hash1).toBe(hash2);
  expect(hash1.length).toBe(8);
});

test('computeSchemaHash returns different hash for different content', () => {
  const hash1 = computeSchemaHash('content A');
  const hash2 = computeSchemaHash('content B');
  expect(hash1 !== hash2).toBeTruthy();
});

// --- buildDiscoveryPrompt ---

test('buildDiscoveryPrompt includes stats in prompt', () => {
  const prompt = buildDiscoveryPrompt({
    totalCount: 100,
    topTopics: [{ topic: 'AI', count: 20 }, { topic: '编程', count: 15 }],
    topConcepts: [{ concept: 'LLM', count: 10 }],
    recentClaims: ['观点1', '观点2'],
  });
  expect(prompt).toContain('100 篇文章');
  expect(prompt).toContain('"AI"（20 篇）');
  expect(prompt).toContain('"LLM"（10 篇）');
  expect(prompt).toContain('观点1');
  expect(prompt).toContain('categories');
  expect(prompt).toContain('entity_types');
});

// --- parseDiscoveryResponse ---

test('parseDiscoveryResponse parses valid JSON response', () => {
  const response = '```json\n{"categories":[{"name":"技术","description":"技术类"}],"entity_types":[{"name":"人物","description":"人"}]}\n```';
  const schema = parseDiscoveryResponse(response);
  expect(schema).toBeDefined();
  expect(schema!.categories).toHaveLength(1);
  expect(schema!.entity_types).toHaveLength(1);
  expect(schema!.version).toBe(1);
});

test('parseDiscoveryResponse returns null for invalid JSON', () => {
  expect(parseDiscoveryResponse('not json')).toBeNull();
});

// --- buildOntologyFile ---

test('buildOntologyFile generates valid markdown with frontmatter', () => {
  const schema: OntologySchema = {
    version: 1,
    categories: [{ name: '心智模型', description: '思维框架' }],
    entity_types: [{ name: '人物', description: '关键人物' }],
  };
  const content = buildOntologyFile(schema);
  expect(content).toContain('knowledge_generated: true');
  expect(content).toContain('knowledge_artifact_type: ontology_schema');
  expect(content).toContain('version: 1');
  expect(content).toContain('name: "心智模型"');
  expect(content).toContain('name: "人物"');
  expect(content).toContain('# Knowledge Ontology Schema');
});

// --- extractFrontmatter ---

test('extractFrontmatter parses basic key-value pairs', () => {
  const content = '---\nknowledge_artifact_type: ontology_schema\nversion: 1\n---\nBody text';
  const fm = extractFrontmatter(content);
  expect(fm).toBeDefined();
  expect(fm!.knowledge_artifact_type).toBe('ontology_schema');
  expect(fm!.version).toBe(1);
});

test('extractFrontmatter parses array of objects', () => {
  const content = `---
knowledge_artifact_type: ontology_schema
version: 1
categories:
  - name: "心智模型"
    description: "可复用的思维框架"
  - name: "方法论"
    description: "具体的操作方法"
entity_types:
  - name: "人物"
    description: "关键人物"
---
Body`;
  const fm = extractFrontmatter(content);
  expect(fm).toBeDefined();
  expect(Array.isArray(fm!.categories)).toBeTruthy();
  expect(fm!.categories.length).toBe(2);
  expect(fm!.categories[0].name).toBe('心智模型');
  expect(fm!.categories[0].description).toBe('可复用的思维框架');
  expect(fm!.entity_types.length).toBe(1);
});

test('extractFrontmatter returns null for no frontmatter', () => {
  expect(extractFrontmatter('Just body text')).toBeNull();
});

// --- Roundtrip: buildOntologyFile → extractFrontmatter → parseOntologySchema ---

test('roundtrip: buildOntologyFile output can be parsed back to schema', () => {
  const original: OntologySchema = {
    version: 1,
    categories: [
      { name: '心智模型', description: '可复用的思维框架' },
      { name: '方法论', description: '具体的操作方法' },
    ],
    entity_types: [
      { name: '人物', description: '文章中提到的关键人物' },
      { name: '工具', description: '提到的软件或工具' },
    ],
  };
  const fileContent = buildOntologyFile(original);
  const fm = extractFrontmatter(fileContent);
  expect(fm).toBeDefined();
  const parsed = parseOntologySchema(fm);
  expect(parsed).toBeDefined();
  expect(parsed!.categories).toHaveLength(2);
  expect(parsed!.entity_types).toHaveLength(2);
  expect(parsed!.categories[0].name).toBe('心智模型');
  expect(parsed!.categories[1].name).toBe('方法论');
  expect(parsed!.entity_types[0].name).toBe('人物');
  expect(parsed!.entity_types[1].name).toBe('工具');
});

console.log('All ontology tests passed!');
