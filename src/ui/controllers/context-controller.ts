import { App } from 'obsidian';
import { ContextManager, ContextItem } from '../../services/context-manager';
import { ObsidianContextService } from '../../services/obsidian-context-service';
import { ContextChips } from '../components/context-chips';

interface ContextControllerDeps {
  app: App;
  contextManager: ContextManager;
  obsidianContextService?: ObsidianContextService;
}

interface CollectCommandContextOptions {
  includeCurrent?: boolean;
}

export class ContextController {
  constructor(private deps: ContextControllerDeps) { }

  async collectCommandContext(options: CollectCommandContextOptions = {}): Promise<{ contextItems: ContextItem[]; selection: string }> {
    const includeCurrent = options.includeCurrent !== false;
    const selectedScopes = this.deps.contextManager.getContexts()
      .filter((ctx) => ctx.type === 'scope' && ctx.scope)
      .map((ctx) => ctx.scope === 'tag' && ctx.tag ? `tag:${ctx.tag}` : ctx.scope!)
      .filter((scope, index, items) => items.indexOf(scope) === index);
    const explicitScopes = [
      ...(includeCurrent ? ['current'] : []),
      ...selectedScopes,
    ]
      .filter((scope, index, items) => items.indexOf(scope) === index);
    const contextItems = await this.deps.contextManager.resolveContexts();
    const obsidianContextService = this.deps.obsidianContextService
      ?? new ObsidianContextService(this.deps.app);
    const snapshot = await obsidianContextService.collect({
      includeBacklinks: explicitScopes.includes('backlinks'),
      includeCurrent,
      explicitScopes,
    });

    return {
      contextItems: [...snapshot.contextItems, ...contextItems],
      selection: snapshot.selection?.text || '',
    };
  }

  renderContextChips(container: HTMLElement, onRemove: (id: string) => void) {
    new ContextChips(container, {
      onRemove,
      onOpenFile: (path) => this.deps.app.workspace.openLinkText(path, '', false),
    }).update(this.deps.contextManager.getContexts());
  }

  getIconForType(type: string): string {
    switch (type) {
      case 'image': return 'image';
      case 'url': return 'link';
      case 'youtube': return 'youtube';
      case 'file': return 'file-text';
      case 'scope': return 'at-sign';
      default: return 'sticky-note';
    }
  }
}
