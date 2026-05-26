// test/knowledge/ontology-service.test.ts

import { TFile } from 'obsidian';
import { DEFAULT_SETTINGS, PluginSettings } from '../../src/mcp/types';
import { OntologyService } from '../../src/knowledge/ontology-service';
import { computeSchemaHash } from '../../src/knowledge/ontology';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeTruthy: () => { if (!actual) throw new Error('Expected truthy'); },
    toBeUndefined: () => {
      if (actual !== undefined) throw new Error(`Expected undefined but got ${JSON.stringify(actual)}`);
    },
  };
}

async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`  PASS ${name}`); }
  catch (e: any) { console.error(`  FAIL ${name}: ${e.message}`); process.exit(1); }
}

function createFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.basename = path.split('/').pop()?.replace(/\.md$/, '') || path;
  file.extension = 'md';
  return file;
}

function createApp(entries: Record<string, string>) {
  const files = new Map<string, { file: TFile; content: string; frontmatter: Record<string, any> }>();
  for (const [path, content] of Object.entries(entries)) {
    files.set(path, {
      file: createFile(path),
      content,
      frontmatter: {},
    });
  }

  return {
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path)?.file || null,
      read: async (file: TFile) => files.get(file.path)?.content || '',
      getMarkdownFiles: () => Array.from(files.values()).map((entry) => entry.file),
    },
    metadataCache: {
      getFileCache: (file: TFile) => {
        const entry = files.get(file.path);
        return entry ? { frontmatter: entry.frontmatter } : null;
      },
    },
  } as any;
}

function createSettings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    knowledgeWikiFolder: 'Knowledge Wiki',
    ...overrides,
  };
}

const validSchemaContent = `---
knowledge_artifact_type: ontology_schema
version: 1
categories:
  - name: "Methods"
    description: "Reusable methods"
entity_types:
  - name: "Tool"
    description: "Software or platform"
---
# Knowledge Ontology Schema
`;

console.log('=== Ontology Service Tests ===');

async function runTests() {
  await test('returns disabled status when ontology is turned off', async () => {
    const service = new OntologyService(createApp({}), createSettings({
      knowledgeOntologyEnabled: false,
    }));

    const status = await service.getStatus();

    expect(status.kind).toBe('disabled');
    expect(status.schema).toBeUndefined();
  });

  await test('returns missing status when ontology file does not exist', async () => {
    const service = new OntologyService(createApp({}), createSettings());

    const status = await service.getStatus();

    expect(status.kind).toBe('missing');
    expect(status.path).toBe('Knowledge Wiki/_ontology.md');
  });

  await test('returns empty status when ontology file has no content', async () => {
    const service = new OntologyService(createApp({
      'Knowledge Wiki/_ontology.md': '   \n',
    }), createSettings());

    const status = await service.getStatus();

    expect(status.kind).toBe('empty');
    expect(status.schema).toBeUndefined();
  });

  await test('returns invalid status when ontology frontmatter cannot be parsed', async () => {
    const service = new OntologyService(createApp({
      'Knowledge Wiki/_ontology.md': `---
knowledge_artifact_type: note
---
# Not a schema
`,
    }), createSettings());

    const status = await service.getStatus();

    expect(status.kind).toBe('invalid');
    expect(status.schema).toBeUndefined();
  });

  await test('returns valid schema and hash for a parseable ontology file', async () => {
    const service = new OntologyService(createApp({
      'Knowledge Wiki/_ontology.md': validSchemaContent,
    }), createSettings());

    const status = await service.getStatus();

    expect(status.kind).toBe('valid');
    expect(status.schema?.categories[0].name).toBe('Methods');
    expect(status.schema?.entity_types[0].name).toBe('Tool');
    expect(status.hash).toBe(computeSchemaHash(validSchemaContent));
  });

  await test('loadSchema returns null for invalid ontology file', async () => {
    const service = new OntologyService(createApp({
      'Knowledge Wiki/_ontology.md': '',
    }), createSettings());

    const loaded = await service.loadSchema();

    expect(loaded).toBe(null);
  });
}

void runTests();

