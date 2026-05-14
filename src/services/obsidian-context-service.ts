import { App } from 'obsidian';
import { ContextItem } from './context-manager';
import { budgetTextBlock } from './context-budget';

export interface ObsidianContextCollectOptions {
  includeBacklinks?: boolean;
  explicitScopes?: string[];
}

export interface ObsidianContextSnapshot {
  activeNote: { path: string; title: string } | null;
  selection: { text: string; from?: number; to?: number } | null;
  activeHeading: string | null;
  frontmatter: Record<string, unknown>;
  tags: string[];
  outgoingLinks: string[];
  backlinks: Array<{ path: string; summary: string }>;
  recentNotes: Array<{ path: string; title: string }>;
  explicitScopes: string[];
  contextItems: ContextItem[];
}

interface ServiceOptions {
  maxRecentNotes?: number;
  maxBacklinks?: number;
  maxSummaryChars?: number;
  maxSectionChars?: number;
}

const DEFAULT_OPTIONS: Required<ServiceOptions> = {
  maxRecentNotes: 5,
  maxBacklinks: 5,
  maxSummaryChars: 180,
  maxSectionChars: 1200,
};

export class ObsidianContextService {
  private readonly options: Required<ServiceOptions>;

  constructor(
    private readonly app: App,
    options: ServiceOptions = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async collect(
    options: ObsidianContextCollectOptions = {},
  ): Promise<ObsidianContextSnapshot> {
    const explicitScopes = [...(options.explicitScopes ?? [])];
    const activeFile = this.app.workspace.getActiveFile?.();

    if (!activeFile) {
      return {
        activeNote: null,
        selection: null,
        activeHeading: null,
        frontmatter: {},
        tags: [],
        outgoingLinks: [],
        backlinks: [],
        recentNotes: [],
        explicitScopes,
        contextItems: [],
      };
    }

    const content = await this.app.vault.read(activeFile);
    const editor = this.app.workspace.getMostRecentLeaf?.()?.view?.editor;
    const selectionText = this.normalizeSelection(editor?.getSelection?.());
    const selectionLine = this.normalizeLine(editor?.getCursor?.('from')?.line);
    const cache = this.app.metadataCache.getFileCache?.(activeFile) ?? {};
    const tags = this.extractTags(cache);
    const outgoingLinks = this.extractOutgoingLinks(cache);
    const activeHeading = this.findActiveHeading(content, selectionLine);
    const activeSection = this.extractActiveSection(content, activeHeading);
    const backlinks = await this.collectBacklinks(activeFile, options.includeBacklinks === true);
    const recentNotes = this.collectRecentNotes(activeFile.path);

    const contextItems: ContextItem[] = [
      {
        id: `active-note:${activeFile.path}`,
        type: 'file',
        data: activeFile.path,
        summary: `Active note: ${this.toTitle(activeFile)}`,
        content: budgetTextBlock(activeSection, this.options.maxSectionChars),
      },
    ];

    if (selectionText) {
      contextItems.push({
        id: `selection:${activeFile.path}`,
        type: 'text',
        data: 'Selected text',
        summary: 'Current editor selection',
        content: selectionText,
      });
    }

    if (backlinks.length > 0) {
      contextItems.push({
        id: `backlinks:${activeFile.path}`,
        type: 'text',
        data: `Backlinks summary for ${activeFile.path}`,
        summary: `${backlinks.length} backlink notes`,
        content: backlinks
          .map((backlink) => `- ${backlink.path}: ${backlink.summary}`)
          .join('\n'),
      });
    }

    return {
      activeNote: {
        path: activeFile.path,
        title: this.toTitle(activeFile),
      },
      selection: selectionText
        ? {
            text: selectionText,
            from: selectionLine,
            to: selectionLine,
          }
        : null,
      activeHeading,
      frontmatter: cache.frontmatter ?? {},
      tags,
      outgoingLinks,
      backlinks,
      recentNotes,
      explicitScopes,
      contextItems,
    };
  }

  private normalizeSelection(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  private normalizeLine(value: unknown): number | null {
    return typeof value === 'number' && value >= 0 ? value : null;
  }

  private extractTags(cache: any): string[] {
    if (!Array.isArray(cache?.tags)) return [];
    return cache.tags
      .map((tag: any) => (typeof tag?.tag === 'string' ? tag.tag : null))
      .filter((tag: string | null): tag is string => !!tag);
  }

  private extractOutgoingLinks(cache: any): string[] {
    if (!Array.isArray(cache?.links)) return [];
    return cache.links
      .map((link: any) => (typeof link?.link === 'string' ? link.link : null))
      .filter((link: string | null): link is string => !!link);
  }

  private findActiveHeading(content: string, selectionLine: number | null): string | null {
    const lines = content.split('\n');
    const searchLine = selectionLine ?? lines.length - 1;

    for (let index = Math.min(searchLine, lines.length - 1); index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (/^#{1,6}\s+/.test(line)) {
        return line;
      }
    }

    return null;
  }

  private extractActiveSection(content: string, activeHeading: string | null): string {
    if (!activeHeading) {
      return content;
    }

    const lines = content.split('\n');
    const startIndex = lines.findIndex((line) => line.trim() === activeHeading.trim());
    if (startIndex < 0) {
      return content;
    }

    const headingLevel = this.headingLevel(activeHeading);
    let endIndex = lines.length;
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!/^#{1,6}\s+/.test(line)) continue;
      if (this.headingLevel(line) <= headingLevel) {
        endIndex = index;
        break;
      }
    }

    return lines.slice(startIndex, endIndex).join('\n').trim();
  }

  private headingLevel(line: string): number {
    const match = line.match(/^(#{1,6})\s+/);
    return match ? match[1].length : 7;
  }

  private async collectBacklinks(activeFile: any, includeBacklinks: boolean): Promise<Array<{ path: string; summary: string }>> {
    if (!includeBacklinks) return [];
    const backlinkMap = this.app.metadataCache.getBacklinksForFile?.(activeFile);
    if (!backlinkMap) return [];

    const entries = Array.from(backlinkMap instanceof Map ? backlinkMap.keys() : Object.keys(backlinkMap));
    const results: Array<{ path: string; summary: string }> = [];

    for (const path of entries.slice(0, this.options.maxBacklinks)) {
      const file = this.app.vault.getAbstractFileByPath?.(path);
      if (!file) continue;
      const content = await this.app.vault.read(file);
      results.push({
        path,
        summary: this.summarizeText(content),
      });
    }

    return results;
  }

  private collectRecentNotes(activePath: string): Array<{ path: string; title: string }> {
    const recentPaths = this.app.workspace.getLastOpenFiles?.();
    if (!Array.isArray(recentPaths)) return [];

    return recentPaths
      .slice(0, this.options.maxRecentNotes)
      .map((path: string) => ({
        path,
        title: this.basename(path),
      }))
      .filter((note) => typeof note.path === 'string' && note.path.length > 0)
      .sort((a, b) => (a.path === activePath ? -1 : b.path === activePath ? 1 : 0));
  }

  private summarizeText(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return budgetTextBlock(normalized, this.options.maxSummaryChars);
  }

  private toTitle(file: any): string {
    return typeof file?.basename === 'string' && file.basename.length > 0
      ? file.basename
      : this.basename(file?.path || '');
  }

  private basename(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    const value = normalized.split('/').pop() || path;
    return value.replace(/\.[^.]+$/, '');
  }
}
