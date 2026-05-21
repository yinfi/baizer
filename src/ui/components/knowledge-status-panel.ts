import { App, Notice, TFile, setIcon } from 'obsidian';
import { PLUGIN_ID } from '../../mcp/types';
import { KnowledgeNoteStatus } from '../../knowledge/status-service';

interface KnowledgeStatusPanelOptions {
  app: App;
  plugin?: any;
  onAddRelatedContext?: (path: string) => void;
  onExcludeCurrentContext?: (path: string) => void;
  onOpenKnowledgeSettings?: () => void;
  setIcon?: (el: HTMLElement, icon: string) => void;
}

export class KnowledgeStatusPanel {
  private readonly setIconFn: (el: HTMLElement, icon: string) => void;
  private refreshSeq = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: KnowledgeStatusPanelOptions,
  ) {
    this.setIconFn = options.setIcon ?? setIcon;
  }

  async refresh() {
    const seq = ++this.refreshSeq;
    this.container.empty();
    (this.container as any).addClass?.('shell-knowledge-status-panel') ?? this.container.classList.add('shell-knowledge-status-panel');

    const activeFile = this.options.app.workspace.getActiveFile?.();
    if (!(activeFile instanceof TFile)) {
      this.renderEmpty('Open a note to view knowledge status.');
      return;
    }

    const runtime = this.options.plugin?.knowledgeRuntime;
    const statusService = runtime?.getStatusService?.();
    if (!statusService) {
      this.renderEmpty('Knowledge system is not available.');
      return;
    }

    const status = await statusService.getNoteStatus(activeFile.path);
    if (seq !== this.refreshSeq) {
      return;
    }
    if (!status) {
      this.renderEmpty('Knowledge status is unavailable for this note.');
      return;
    }

    this.renderStatus(activeFile, status, runtime);
  }

  private renderEmpty(message: string) {
    const body = (this.container as any).createDiv({ cls: 'shell-knowledge-status-empty' }) as HTMLElement;
    if (typeof (body as any).setText === 'function') {
      (body as any).setText(message);
    } else {
      body.textContent = message;
    }
  }

  private renderStatus(
    activeFile: TFile,
    status: KnowledgeNoteStatus,
    runtime: any,
  ) {
    const strip = (this.container as any).createDiv({
      cls: `shell-knowledge-status-strip is-${status.state}`,
      attr: {
        role: 'button',
        tabindex: '0',
        'aria-label': `Current note: ${activeFile.basename}. ${this.buildSummary(status)}`,
      },
    }) as HTMLElement;

    const icon = (strip as any).createDiv({ cls: 'shell-knowledge-status-file-icon' }) as HTMLElement;
    this.setIconFn(icon, 'file-text');
    (strip as any).createSpan({ cls: 'shell-knowledge-status-title', text: activeFile.basename });

    const exclude = (strip as any).createEl('button', {
      cls: 'shell-knowledge-status-exclude clickable-icon',
      attr: {
        type: 'button',
        'aria-label': 'Exclude current note from context',
        title: 'Exclude current note from context',
      },
    }) as HTMLElement;
    this.setIconFn(exclude, 'x');
    exclude.addEventListener('click', (event) => {
      event.stopPropagation();
      this.options.onExcludeCurrentContext?.(activeFile.path);
    });

    strip.addEventListener('click', () => {
      this.toggleMoreMenu(strip, activeFile, status);
    });
    strip.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      this.toggleMoreMenu(strip, activeFile, status);
    });
  }

  private toggleMoreMenu(parent: HTMLElement, activeFile: TFile, status: KnowledgeNoteStatus) {
    const existing = parent.querySelector?.('.shell-knowledge-status-action-row');
    if (existing) {
      existing.remove();
      return;
    }

    const menu = (parent as any).createDiv({ cls: 'shell-knowledge-status-action-row' }) as HTMLElement;
    this.createMenuItem(menu, 'Compile note', 'refresh-cw', async () => {
      const result = await (this.options.plugin?.knowledgeRuntime ?? null)?.compileByPath?.(activeFile.path);
      if (result) {
        new Notice(`Knowledge compile: ${result.success} success, ${result.failed} failed`);
      }
      await this.refresh();
    });
    this.createMenuItem(menu, 'Add backlinks', 'network', () => {
      this.options.onAddRelatedContext?.(activeFile.path);
    });
    this.createMenuItem(menu, 'Open wiki summary', 'external-link', () => {
      const summaryPath = status.summaryPath;
      if (summaryPath && typeof (this.options.app.workspace as any)?.openLinkText === 'function') {
        void (this.options.app.workspace as any).openLinkText(summaryPath, '', false);
        return;
      }
      (this.options.app as any).commands?.executeCommandById?.(`${PLUGIN_ID}:knowledge-open-index`);
    });
    this.createMenuItem(menu, 'Run knowledge lint', 'scan-line', () => {
      (this.options.app as any).commands?.executeCommandById?.(`${PLUGIN_ID}:knowledge-lint`);
    });
    this.createMenuItem(menu, 'Copy note path', 'copy', () => {
      void globalThis.navigator?.clipboard?.writeText?.(activeFile.path);
      new Notice('Copied note path.');
    });
    this.createMenuItem(menu, 'Settings', 'settings', () => {
      this.options.onOpenKnowledgeSettings?.();
    });
  }

  private createMenuItem(
    container: HTMLElement,
    label: string,
    icon: string,
    handler: () => void | Promise<void>,
  ) {
    const item = (container as any).createEl('button', {
      cls: 'shell-knowledge-status-icon-action',
      attr: { type: 'button', 'aria-label': label, title: label },
    }) as HTMLElement;
    this.setIconFn(item, icon);
    item.addEventListener('click', () => {
      void handler();
    });
  }

  private buildSummary(status: KnowledgeNoteStatus) {
    switch (status.state) {
      case 'failed':
        return `Failed: ${this.summarizeError(status.error)}`;
      case 'stale':
        return 'Needs recompilation.';
      case 'pending':
        return 'Waiting to compile.';
      case 'processing':
        return 'Compiling now.';
      case 'done':
        return status.compiledAt
          ? `\u5df2\u540c\u6b65 \u00b7 Compiled ${status.compiledAt}`
          : '\u5df2\u540c\u6b65 \u00b7 Compiled successfully.';
      case 'unregistered':
      default:
        return 'Not added to the knowledge wiki.';
    }
  }

  private summarizeError(error: string | null) {
    if (!error) {
      return 'unknown error';
    }

    const normalized = error.replace(/\s+/g, ' ').trim();
    if (/quota exceeded|exceeded your current quota/i.test(normalized)) {
      return 'quota exceeded';
    }

    if (/rate limit/i.test(normalized)) {
      return 'rate limited';
    }

    if (/timed out|timeout/i.test(normalized)) {
      return 'request timed out';
    }

    if (/network/i.test(normalized)) {
      return 'network error';
    }

    const withoutUrls = normalized.replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
    const sentence = withoutUrls.split(/[.!?]/)[0]?.trim() || withoutUrls;
    return sentence.slice(0, 120) || 'unknown error';
  }
}
