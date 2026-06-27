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

type TestEntry = string | {
  content: string;
  frontmatter?: Record<string, any>;
};

function createApp(entries: Record<string, TestEntry>) {
  const files = new Map<string, { file: TFile; content: string; frontmatter: Record<string, any> }>();
  for (const [path, entry] of Object.entries(entries)) {
    const content = typeof entry === 'string' ? entry : entry.content;
    files.set(path, {
      file: createFile(path),
      content,
      frontmatter: typeof entry === 'string' ? {} : entry.frontmatter || {},
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

  await test('discovery readiness reports insufficient articles below threshold', async () => {
    const service = new OntologyService(createApp({
      'Knowledge Wiki/Articles/a.md': { content: '# A', frontmatter: { topics: ['AI'] } },
      'Knowledge Wiki/Articles/b.md': { content: '# B', frontmatter: { topics: ['AI'] } },
    }), createSettings({ knowledgeOntologyMinArticles: 3 }));

    const readiness = await service.getDiscoveryReadiness();

    expect(readiness.kind).toBe('insufficient_articles');
    expect(readiness.totalCount).toBe(2);
  });

  await test('discovery readiness reports insufficient signal when frequencies are too low', async () => {
    const service = new OntologyService(createApp({
      'Knowledge Wiki/Articles/a.md': { content: '# A', frontmatter: { topics: ['AI'], concepts: ['Agent'] } },
      'Knowledge Wiki/Articles/b.md': { content: '# B', frontmatter: { topics: ['PKM'], concepts: ['Vault'] } },
    }), createSettings({
      knowledgeOntologyMinArticles: 2,
      knowledgeOntologyMinTopicFrequency: 2,
      knowledgeOntologyMinConceptFrequency: 2,
    }));

    const readiness = await service.getDiscoveryReadiness();

    expect(readiness.kind).toBe('insufficient_signal');
    expect(readiness.totalCount).toBe(2);
  });

  await test('discovery readiness uses configured thresholds for article signals', async () => {
    const service = new OntologyService(createApp({
      'Knowledge Wiki/Articles/a.md': {
        content: '# A',
        frontmatter: { topics: ['AI'], concepts: ['Agent'], key_claims: ['A claim'] },
      },
      'Knowledge Wiki/Articles/b.md': {
        content: '# B',
        frontmatter: { topics: ['AI'], concepts: ['Agent'], key_claims: ['B claim'] },
      },
    }), createSettings({
      knowledgeOntologyMinArticles: 2,
      knowledgeOntologyMinTopicFrequency: 2,
      knowledgeOntologyMinConceptFrequency: 2,
    }));

    const readiness = await service.getDiscoveryReadiness();

    expect(readiness.kind).toBe('ready');
    expect(readiness.totalCount).toBe(2);
    expect(readiness.topTopics[0].topic).toBe('AI');
    expect(readiness.topTopics[0].count).toBe(2);
    expect(readiness.topConcepts[0].concept).toBe('Agent');
    expect(readiness.recentClaims[1]).toBe('B claim');
  });
  await test('discovery readiness excludes file_back artifacts from stats', async () => {
    const service = new OntologyService(createApp({
      'Knowledge Wiki/Articles/a.md': {
        content: '# A',
        frontmatter: { topics: ['AI'], concepts: ['Agent'], key_claims: ['A claim'] },
      },
      'Knowledge Wiki/Articles/b.md': {
        content: '# B',
        frontmatter: { topics: ['AI'], concepts: ['Agent'], key_claims: ['B claim'] },
      },
      // file_back 二手归档：主题应被排除，不计入 totalCount 与高频统计
      'Knowledge Wiki/Articles/fb_x.md': {
        content: '# FB',
        frontmatter: {
          knowledge_artifact_type: 'file_back',
          topics: ['Noise', 'Noise2', 'Noise3'],
        },
      },
    }), createSettings({
      knowledgeOntologyMinArticles: 2,
      knowledgeOntologyMinTopicFrequency: 2,
      knowledgeOntologyMinConceptFrequency: 2,
    }));

    const readiness = await service.getDiscoveryReadiness();

    expect(readiness.kind).toBe('ready');
    expect(readiness.totalCount).toBe(2);
    expect(readiness.topTopics[0].topic).toBe('AI');
    expect(readiness.topTopics.length).toBe(1);
  });
  await test('getStatus prefers metadataCache frontmatter over self-parsed YAML', async () => {
    // content 用 2 空格缩进（自研 parseSimpleYaml 要求 >=4 空格，会解析失败），
    // 但 metadataCache 提供完整解析结果 → 应判 valid，验证 cache 优先 + 回退链路。
    const twoSpaceContent = `---
knowledge_artifact_type: ontology_schema
version: 1
categories:
  - name: "Methods"
    description: "Reusable methods"
---
# Knowledge Ontology Schema
`;
    const service = new OntologyService(createApp({
      'Knowledge Wiki/_ontology.md': {
        content: twoSpaceContent,
        frontmatter: {
          knowledge_artifact_type: 'ontology_schema',
          version: 1,
          categories: [{ name: 'Methods', description: 'Reusable methods' }],
        },
      },
    }), createSettings());

    const status = await service.getStatus();

    expect(status.kind).toBe('valid');
    expect(status.schema?.categories[0].name).toBe('Methods');
  });

  await test('getStatus falls back to self-parser when cache frontmatter is absent', async () => {
    // 字符串 entry → mock 的 cache frontmatter 为 {} → 必须回退到 extractFrontmatter。
    const service = new OntologyService(createApp({
      'Knowledge Wiki/_ontology.md': validSchemaContent,
    }), createSettings());

    const status = await service.getStatus();

    expect(status.kind).toBe('valid');
    expect(status.schema?.categories[0].name).toBe('Methods');
  });
}

void runTests();
