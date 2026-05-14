import { App, Notice, TFile } from 'obsidian';
import { PLUGIN_ID } from '../../mcp/types';
import { KnowledgeNoteStatus } from '../../knowledge/status-service';

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

    const status = await statusService.getNoteStatus(activeFile.path);
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
    const header = (this.container as any).createDiv({ cls: 'shell-knowledge-status-header' }) as HTMLElement;
    header.createDiv({ cls: 'shell-knowledge-status-title', text: activeFile.basename });
    header.createDiv({ cls: `shell-knowledge-status-badge is-${status.state}`, text: status.state });

    const meta = (this.container as any).createDiv({ cls: 'shell-knowledge-status-meta' }) as HTMLElement;
    meta.createDiv({
      cls: 'shell-knowledge-status-details',
      text: this.buildSummary(status),
    });

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
          ? `Compiled ${status.compiledAt}`
          : 'Compiled successfully.';
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
