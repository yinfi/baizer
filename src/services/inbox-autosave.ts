import { App, TFile } from 'obsidian';

export interface RawUrlMatch {
  url: string;
  index: number;
  length: number;
}

export interface InboxAutosaveOptions {
  app: App;
  getInboxPath: () => string;
  saveUrl: (url: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  notify?: (message: string) => void;
}

export function extractRawUrlMatches(content: string): RawUrlMatch[] {
  const regex = /(\[\[.*?\]\])|(\[.*?\]\(.*?\))|(https?:\/\/[^\s\)]+)/g;
  const matches: RawUrlMatch[] = [];

  for (const match of content.matchAll(regex)) {
    if (!match[1] && !match[2] && match[3] && match.index !== undefined) {
      matches.push({
        url: match[3],
        index: match.index,
        length: match[0].length,
      });
    }
  }

  return matches;
}

function buildSavedLink(path: string): string {
  return `[[${path}|Saved: ${path.split('/').pop()?.replace('.md', '')}]]`;
}

function replaceMatchesWithLinks(
  content: string,
  replacements: Array<{ url: string; path: string }>,
): { content: string; modified: boolean } {
  const currentMatches = extractRawUrlMatches(content);
  const pendingMatches = [...currentMatches];
  const edits: Array<{ index: number; length: number; text: string }> = [];

  for (const replacement of replacements) {
    const matchIndex = pendingMatches.findIndex(match => match.url === replacement.url);
    if (matchIndex === -1) continue;

    const match = pendingMatches[matchIndex];
    pendingMatches.splice(matchIndex, 1);
    edits.push({
      index: match.index,
      length: match.length,
      text: buildSavedLink(replacement.path),
    });
  }

  if (edits.length === 0) {
    return { content, modified: false };
  }

  edits.sort((a, b) => b.index - a.index);
  let nextContent = content;
  for (const edit of edits) {
    nextContent = nextContent.slice(0, edit.index) + edit.text + nextContent.slice(edit.index + edit.length);
  }

  return { content: nextContent, modified: true };
}

export class InboxAutosaveCoordinator {
  private readonly fileQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: InboxAutosaveOptions) {}

  async handleFileModify(file: TFile): Promise<void> {
    if (file.path !== this.options.getInboxPath()) return;

    const previous = this.fileQueues.get(file.path) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.processFile(file))
      .finally(() => {
        if (this.fileQueues.get(file.path) === next) {
          this.fileQueues.delete(file.path);
        }
      });

    this.fileQueues.set(file.path, next);
    await next;
  }

  private async processFile(file: TFile): Promise<void> {
    const initialContent = await this.options.app.vault.read(file);
    const matches = extractRawUrlMatches(initialContent);
    if (matches.length === 0) return;

    const replacements: Array<{ url: string; path: string }> = [];

    for (const match of matches) {
      this.options.notify?.(`Auto-saving: ${match.url}`);
      const result = await this.options.saveUrl(match.url);
      if (result.success && result.path) {
        replacements.push({ url: match.url, path: result.path });
      } else if (result.error) {
        this.options.notify?.(`Failed to save ${match.url}: ${result.error}`);
      }
    }

    if (replacements.length === 0) return;

    const latestContent = await this.options.app.vault.read(file);
    const rewritten = replaceMatchesWithLinks(latestContent, replacements);
    if (!rewritten.modified) return;

    await this.options.app.vault.modify(file, rewritten.content);
  }
}
