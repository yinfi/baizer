import { App } from 'obsidian';
import { ContextManager, ContextItem } from '../../services/context-manager';
import { ContextChips } from '../components/context-chips';

interface ContextControllerDeps {
  app: App;
  contextManager: ContextManager;
}

export class ContextController {
  constructor(private deps: ContextControllerDeps) { }

  async collectCommandContext(): Promise<{ contextItems: ContextItem[]; selection: string }> {
    const contextItems = await this.deps.contextManager.resolveContexts();
    const activeFile = this.deps.app.workspace.getActiveFile();

    if (activeFile) {
      contextItems.push({
        id: 'active-file',
        type: 'file',
        data: activeFile.path,
        content: await this.deps.app.vault.read(activeFile),
      });
    }

    let selection = '';
    const activeLeaf = this.deps.app.workspace.getMostRecentLeaf();
    if (activeLeaf?.view) {
      const editor = (activeLeaf.view as any).editor;
      if (editor) {
        selection = editor.getSelection();
      }
    }

    return { contextItems, selection };
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
      default: return 'sticky-note';
    }
  }
}
