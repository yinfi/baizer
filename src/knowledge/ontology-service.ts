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
  parseOntologySchema,
} from './ontology';

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
    if (!this.settings.knowledgeOntologyEnabled) {
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

    const frontmatter = extractFrontmatter(rawContent);
    const schema = parseOntologySchema(frontmatter);
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

    if (!this.settings.knowledgeOntologyEnabled) {
      return { kind: 'disabled', ...emptyStats, message: 'Ontology schema is disabled.' };
    }

    const wikiFolder = this.settings.knowledgeWikiFolder || DEFAULT_WIKI_FOLDER;
    const articlesDir = `${wikiFolder}/Articles`;
    const articles = this.app.vault.getMarkdownFiles()
      .filter((file: TFile) => file.path.startsWith(`${articlesDir}/`));

    const totalCount = articles.length;
    const minArticles = this.settings.knowledgeOntologyMinArticles || 10;
    if (totalCount < minArticles) {
      return {
        kind: 'insufficient_articles',
        ...emptyStats,
        totalCount,
        message: `Only ${totalCount} articles are available; ${minArticles} are required.`,
      };
    }

    const topicCounts = new Map<string, number>();
    const conceptCounts = new Map<string, number>();
    const recentClaims: string[] = [];

    for (const file of articles) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm) continue;

      for (const topic of readTopics(fm)) {
        topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
      }

      for (const concept of readStringArray(fm.concepts)) {
        conceptCounts.set(concept, (conceptCounts.get(concept) || 0) + 1);
      }

      recentClaims.push(...readStringArray(fm.key_claims).slice(0, 3));
    }

    const minTopicFrequency = this.settings.knowledgeOntologyMinTopicFrequency || 3;
    const minConceptFrequency = this.settings.knowledgeOntologyMinConceptFrequency || 2;
    const topTopics = Array.from(topicCounts.entries())
      .filter(([, count]) => count >= minTopicFrequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([topic, count]) => ({ topic, count }));
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
