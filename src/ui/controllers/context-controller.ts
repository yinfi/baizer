import { App } from 'obsidian';
import { ContextManager, ContextItem } from '../../services/context-manager';

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
    if (!container) return;
    container.empty();

    const contexts = this.deps.contextManager.getContexts();
    contexts.forEach(ctx => {
      const chip = container.createDiv({ cls: 'context-chip' });
      chip.createSpan({ cls: 'chip-icon', text: this.getIconForType(ctx.type) });
      chip.createSpan({ cls: 'chip-label', text: ctx.summary || ctx.data });
      const removeBtn = chip.createSpan({ cls: 'chip-remove', text: '脳' });
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onRemove(ctx.id);
      });
    });
  }

  getIconForType(type: string): string {
    switch (type) {
      case 'image': return '🖼️';
      case 'url': return '🌐';
      case 'youtube': return '▶️';
      case 'file': return '📄';
      default: return '📌';
    }
  }
}
