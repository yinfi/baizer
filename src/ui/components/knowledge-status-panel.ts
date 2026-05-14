import { App, Notice, TFile } from 'obsidian';
import { PLUGIN_ID } from '../../mcp/types';
import { KnowledgeNoteStatus, KnowledgeGlobalCounts } from '../../knowledge/status-service';

interface KnowledgeStatusPanelOptions {
  app: App;
  plugin?: any;
}

export class KnowledgeStatusPanel {
  constructor(
    private readonly container: HTMLElement,
    private readonly options: KnowledgeStatusPanelOptions,
  ) {}

  async refresh() {
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

    const [status, counts] = await Promise.all([
      statusService.getNoteStatus(activeFile.path),
      statusService.getGlobalCounts(),
    ]);

    if (!status) {
      this.renderEmpty('Knowledge status is unavailable for this note.');
      return;
    }

    this.renderStatus(activeFile, status, counts, runtime);
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
    counts: KnowledgeGlobalCounts,
    runtime: any,
  ) {
    const header = (this.container as any).createDiv({ cls: 'shell-knowledge-status-header' }) as HTMLElement;
    header.createDiv({ cls: 'shell-knowledge-status-title', text: activeFile.basename });
    header.createDiv({ cls: `shell-knowledge-status-badge is-${status.state}`, text: status.state });

    const meta = (this.container as any).createDiv({ cls: 'shell-knowledge-status-meta' }) as HTMLElement;
    meta.createDiv({ cls: 'shell-knowledge-status-path', text: activeFile.path });
    meta.createDiv({
      cls: 'shell-knowledge-status-details',
      text: this.buildMetaSummary(activeFile, status),
    });

    const countsRow = (this.container as any).createDiv({ cls: 'shell-knowledge-status-counts' }) as HTMLElement;
    countsRow.createDiv({ cls: 'shell-knowledge-status-count', text: `Pending ${counts.pending}` });
    countsRow.createDiv({ cls: 'shell-knowledge-status-count', text: `Stale ${counts.stale}` });
    countsRow.createDiv({ cls: 'shell-knowledge-status-count', text: `Failed ${counts.failed}` });

    const actions = (this.container as any).createDiv({ cls: 'shell-knowledge-status-actions' }) as HTMLElement;
    this.createAction(actions, 'Compile Current Note', async () => {
      const result = await runtime?.compileByPath?.(activeFile.path);
      if (result) {
        new Notice(`Knowledge compile: ${result.success} success, ${result.failed} failed`);
      }
      await this.refresh();
    });
    this.createAction(actions, 'Open Knowledge Index', () => {
      (this.options.app as any).commands?.executeCommandById?.(`${PLUGIN_ID}:knowledge-open-index`);
    });
    this.createAction(actions, 'Run Knowledge Lint', () => {
      (this.options.app as any).commands?.executeCommandById?.(`${PLUGIN_ID}:knowledge-lint`);
    });
  }

  private createAction(container: HTMLElement, label: string, handler: () => void | Promise<void>) {
    const button = (container as any).createEl('button', {
      cls: 'shell-knowledge-status-action',
      text: label,
      attr: { type: 'button' },
    }) as HTMLElement;
    button.addEventListener('click', () => {
      void handler();
    });
  }

  private buildMetaSummary(activeFile: TFile, status: KnowledgeNoteStatus) {
    const parts = [
      `Backlinks ${this.countBacklinks(activeFile)}`,
    ];

    if (status.compiledAt) {
      parts.push(`Compiled ${status.compiledAt}`);
    }

    if (status.summaryPath) {
      parts.push(`Summary ${status.summaryPath}`);
    }

    if (status.error) {
      parts.push(`Error ${status.error}`);
    }

    return parts.join(' • ');
  }

  private countBacklinks(file: TFile) {
    const backlinks = this.options.app.metadataCache.getBacklinksForFile?.(file);
    if (backlinks instanceof Map) {
      return backlinks.size;
    }

    if (backlinks && typeof backlinks === 'object') {
      return Object.keys(backlinks).length;
    }

    return 0;
  }
}
