import { App, TFile } from 'obsidian';
import { PluginSettings } from '../mcp/types';
import {
  DEFAULT_WIKI_FOLDER,
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
}

