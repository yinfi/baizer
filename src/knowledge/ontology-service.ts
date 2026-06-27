import { App, TFile } from 'obsidian';
import { PluginSettings } from '../mcp/types';
import {
  DEFAULT_WIKI_FOLDER,
  OntologyDiscoveryReadiness,
  ONTOLOGY_SCHEMA_FILENAME,
  OntologyStatus,
} from './types';
import {
  computeSchemaHash,
  extractFrontmatter,
  buildDiscoveryPrompt,
  buildOntologyFile,
  parseDiscoveryResponse,
  parseOntologySchema,
} from './ontology';
import { normalizeTopicSlug } from './types';

export class OntologyService {
  constructor(
    private app: App,
    private settings: PluginSettings,
  ) {}

  updateSettings(settings: PluginSettings): void {
    this.settings = settings;
  }

  getSchemaPath(): string {
    const wikiFolder = this.settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER;
    return `${wikiFolder}/${ONTOLOGY_SCHEMA_FILENAME}`;
  }

  async getStatus(): Promise<OntologyStatus> {
    const path = this.getSchemaPath();
    if (this.settings.knowledgeOntologyEnabled === false) {
      return { kind: 'disabled', path, message: 'Ontology schema is disabled.' };
    }

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return { kind: 'missing', path, message: 'Ontology schema does not exist.' };
    }

    const rawContent = await this.app.vault.read(file);
    if (rawContent.trim().length === 0) {
      return { kind: 'empty', path, message: 'Ontology schema file is empty.' };
    }

    // 优先用 Obsidian metadataCache 的 frontmatter（完整 YAML 解析，支持 2 空格缩进、
    // 行内注释等自研 parseSimpleYaml 不认的写法）；cache 未就绪或解析不出 schema 时，
    // 回退到自研 extractFrontmatter。_ontology.md 被鼓励用户手编，鲁棒性优先。
    const cachedFm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    let schema = parseOntologySchema(cachedFm);
    if (!schema) {
      schema = parseOntologySchema(extractFrontmatter(rawContent));
    }
    if (!schema) {
      return { kind: 'invalid', path, message: 'Ontology schema frontmatter is invalid.' };
    }

    return {
      kind: 'valid',
      path,
      schema,
      hash: computeSchemaHash(rawContent),
    };
  }

  async loadSchema(): Promise<{ schema: NonNullable<OntologyStatus['schema']>; hash: string } | null> {
    const status = await this.getStatus();
    if (status.kind !== 'valid' || !status.schema || !status.hash) return null;
    return { schema: status.schema, hash: status.hash };
  }

  async getDiscoveryReadiness(): Promise<OntologyDiscoveryReadiness> {
    const path = this.getSchemaPath();
    const emptyStats = {
      path,
      totalCount: 0,
      topTopics: [],
      topConcepts: [],
      recentClaims: [],
    };

    if (this.settings.knowledgeOntologyEnabled === false) {
      return { kind: 'disabled', ...emptyStats, message: 'Ontology schema is disabled.' };
    }

    const wikiFolder = this.settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER;
    const articlesDir = `${wikiFolder}/Articles`;
    // 只统计一手编译产物：排除 file_back（AI 回答的二手归档），
    // 否则对话产物的主题会污染 ontology discovery 的高频统计，使 schema 偏离源知识。
    const articles = this.app.vault.getMarkdownFiles()
      .filter((file: TFile) => file.path.startsWith(`${articlesDir}/`))
      .filter((file: TFile) => {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        return fm?.knowledge_artifact_type !== 'file_back';
      });

    const totalCount = articles.length;
    const minArticles = this.settings.knowledgeOntologyMinArticles ?? 10;
    if (totalCount < minArticles) {
      return {
        kind: 'insufficient_articles',
        ...emptyStats,
        totalCount,
        message: `Only ${totalCount} articles are available; ${minArticles} are required.`,
      };
    }

    const topicCounts = new Map<string, number>();
    const topicLabels = new Map<string, string>();
    const conceptCounts = new Map<string, number>();
    const recentClaims: string[] = [];

    for (const file of articles) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm) continue;

      // 按归一化 slug 聚合 topic，合并 "Second Brain"/"second-brain" 等变体；
      // 单篇内 slug 去重，显示 label 取首次出现的原始写法。
      const seenSlugs = new Set<string>();
      for (const topic of readTopics(fm)) {
        const slug = normalizeTopicSlug(topic);
        if (!slug || seenSlugs.has(slug)) continue;
        seenSlugs.add(slug);
        topicCounts.set(slug, (topicCounts.get(slug) || 0) + 1);
        if (!topicLabels.has(slug)) topicLabels.set(slug, topic);
      }

      for (const concept of readStringArray(fm.concepts)) {
        conceptCounts.set(concept, (conceptCounts.get(concept) || 0) + 1);
      }

      recentClaims.push(...readStringArray(fm.key_claims).slice(0, 3));
    }

    const minTopicFrequency = this.settings.knowledgeOntologyMinTopicFrequency ?? 3;
    const minConceptFrequency = this.settings.knowledgeOntologyMinConceptFrequency ?? 2;
    const topTopics = Array.from(topicCounts.entries())
      .filter(([, count]) => count >= minTopicFrequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([slug, count]) => ({ topic: topicLabels.get(slug) || slug, count }));
    const topConcepts = Array.from(conceptCounts.entries())
      .filter(([, count]) => count >= minConceptFrequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([concept, count]) => ({ concept, count }));

    if (topTopics.length === 0 && topConcepts.length === 0) {
      return {
        kind: 'insufficient_signal',
        path,
        totalCount,
        topTopics,
        topConcepts,
        recentClaims: recentClaims.slice(-20),
        message: 'No topics or concepts meet the configured frequency thresholds.',
      };
    }

    return {
      kind: 'ready',
      path,
      totalCount,
      topTopics,
      topConcepts,
      recentClaims: recentClaims.slice(-20),
    };
  }

  async generateDiscoveryCandidate(
    generateFn: (prompt: string) => Promise<string>,
  ): Promise<{ readiness: OntologyDiscoveryReadiness; content?: string; error?: string }> {
    const readiness = await this.getDiscoveryReadiness();
    if (readiness.kind !== 'ready') return { readiness };

    const prompt = buildDiscoveryPrompt({
      totalCount: readiness.totalCount,
      topTopics: readiness.topTopics,
      topConcepts: readiness.topConcepts,
      recentClaims: readiness.recentClaims,
    });
    const response = await generateFn(prompt);
    const schema = parseDiscoveryResponse(response);
    if (!schema) {
      return { readiness, error: 'Failed to parse ontology discovery response.' };
    }

    return { readiness, content: buildOntologyFile(schema) };
  }

  async createSchemaFile(content: string): Promise<string> {
    const path = this.getSchemaPath();
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      const existingContent = await this.app.vault.read(existing);
      if (existingContent.trim().length === 0) {
        await this.app.vault.modify(existing, content);
        return path;
      }
      throw new Error(`Ontology schema already exists: ${path}`);
    }
    if (existing) throw new Error(`Ontology schema path is not a file: ${path}`);

    const wikiFolder = this.settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER;
    if (!this.app.vault.getAbstractFileByPath(wikiFolder) && typeof this.app.vault.createFolder === 'function') {
      await this.app.vault.createFolder(wikiFolder);
    }

    await this.app.vault.create(path, content);
    return path;
  }
}

function readTopics(fm: Record<string, any>): string[] {
  const raw = fm.topics;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((topic: any) => {
      if (typeof topic === 'string') return topic;
      if (topic && typeof topic.label === 'string') return topic.label;
      return '';
    })
    .filter((topic: string) => topic.length > 0);
}

function readStringArray(raw: any): string[] {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [raw];
    } catch {
      return [raw];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map(String).filter((value) => value.length > 0);
}
