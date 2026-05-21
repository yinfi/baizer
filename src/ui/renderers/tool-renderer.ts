import { ToolRunState } from '../types';

interface ToolRendererOptions {
  now?: () => number;
  onToolUpdate?: (run: ToolRunState) => void;
}

export function getToolSummary(name: string, input: Record<string, unknown> = {}) {
  const lowerName = name.toLowerCase();
  const path = firstString(input, ['path', 'filePath', 'filename', 'target']);
  const query = firstString(input, ['query', 'q', 'prompt', 'topic']);
  const url = firstString(input, ['url', 'href']);
  const command = firstString(input, ['command', 'action']);

  if (lowerName.startsWith('plugin-') || lowerName.includes('plugin')) {
    return `Plugin: ${name}`;
  }

  if (lowerName.includes('read') && path) {
    return `Read: ${basename(path)}`;
  }

  if ((lowerName.includes('write') || lowerName.includes('create') || lowerName.includes('save')) && path) {
    return `Write: ${basename(path)}`;
  }

  if ((lowerName.includes('edit') || lowerName.includes('modify') || lowerName.includes('update')) && path) {
    return `Edit: ${basename(path)}`;
  }

  if (lowerName.includes('delete') && path) {
    return `Delete: ${basename(path)}`;
  }

  if (lowerName.includes('search') && query) {
    return `Search: ${truncate(query)}`;
  }

  if ((lowerName.includes('web') || lowerName.includes('url') || lowerName.includes('clip')) && (url || query)) {
    return `Web: ${truncate(url || query)}`;
  }

  if ((lowerName.includes('knowledge') || lowerName.includes('wiki') || lowerName.includes('file_back')) && (query || path)) {
    return `Knowledge: ${truncate(query || path)}`;
  }

  if (command) {
    return `${name}: ${truncate(command)}`;
  }

  return name;
}

export function getToolStatus(_result?: unknown, error?: string) {
  return error ? 'Error' : 'Completed';
}

export class ToolRenderer {
  private nodeCount = 0;
  private readonly now: () => number;
  private readonly runsById = new Map<string, ToolRunState>();

  constructor(private timeline: HTMLElement, private options: ToolRendererOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  addToolCall(name: string, args: Record<string, unknown> = {}) {
    const id = `tool-${this.nodeCount + 1}`;
    const node = (this.timeline as any).createDiv({ cls: 'ocli-tool-call think-node is-tool is-running' }) as HTMLElement;
    node.dataset.toolName = name;
    node.dataset.toolRunId = id;

    const header = (node as any).createDiv({ cls: 'ocli-tool-header think-node-header' }) as HTMLElement;
    (header as any).createSpan({ cls: 'ocli-tool-icon think-node-icon', text: 'tool' });
    (header as any).createSpan({ cls: 'ocli-tool-label think-node-label', text: getToolSummary(name, args) });
    (header as any).createSpan({ cls: 'ocli-tool-status', text: 'Running' });
    this.setAttribute(header, 'role', 'button');
    this.setAttribute(header, 'tabindex', '0');
    this.setAttribute(header, 'aria-expanded', 'false');

    const detail = (node as any).createDiv({ cls: 'ocli-tool-detail think-node-detail' }) as HTMLElement;
    detail.textContent = `--- Input ---\n${safeStringify(args)}`;

    header.addEventListener('click', () => this.toggleExpanded(node, header));
    header.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      this.toggleExpanded(node, header);
    });

    const run: ToolRunState = {
      id,
      name,
      status: 'running',
      input: args,
      startedAt: this.now(),
    };
    this.runsById.set(id, run);
    this.options.onToolUpdate?.({ ...run, input: { ...run.input } });
    this.nodeCount++;
  }

  updateToolResult(name: string, result: unknown, error?: string) {
    const targetNode = this.findLatestNode(name);
    if (!targetNode) return;

    const detail = targetNode.querySelector('.ocli-tool-detail') as HTMLElement
      ?? targetNode.querySelector('.think-node-detail') as HTMLElement;
    const statusCandidate = targetNode.querySelector('.ocli-tool-status') as HTMLElement;
    const status = statusCandidate && this.hasClass(statusCandidate, 'ocli-tool-status')
      ? statusCandidate
      : null;
    const resultText = error ? `Error: ${error}` : safeStringify(result);

    if (detail) {
      detail.textContent += `\n--- Result ---\n${resultText}`;
    }
    if (status) {
      status.textContent = getToolStatus(result, error);
    }

    this.removeClass(targetNode, 'is-running');
    this.addClass(targetNode, error ? 'is-error' : 'is-complete');

    const id = targetNode.dataset.toolRunId;
    const previousRun = id ? this.runsById.get(id) : null;
    if (previousRun) {
      const updatedRun: ToolRunState = {
        ...previousRun,
        status: error ? 'error' : 'completed',
        result,
        error,
        finishedAt: this.now(),
      };
      this.runsById.set(previousRun.id, updatedRun);
      this.options.onToolUpdate?.({
        ...updatedRun,
        input: { ...updatedRun.input },
      });
    }
  }

  getNodeCount() {
    return this.nodeCount;
  }

  private findLatestNode(name: string): HTMLElement | null {
    const nodes = this.getToolNodes();
    for (let i = nodes.length - 1; i >= 0; i--) {
      if ((nodes[i] as HTMLElement).dataset.toolName === name) {
        return nodes[i] as HTMLElement;
      }
    }
    return null;
  }

  private getToolNodes() {
    const newNodes = Array.from(this.timeline.querySelectorAll('.ocli-tool-call'));
    if (newNodes.length > 0) return newNodes;

    return Array.from(this.timeline.querySelectorAll('.think-node'))
      .filter((node: any) => node.hasClass?.('is-tool') || node.classList?.contains?.('is-tool'));
  }

  private toggleExpanded(node: HTMLElement, header: HTMLElement) {
    const expanded = !this.hasClass(node, 'is-expanded');
    this.toggleClass(node, 'is-expanded', expanded);
    this.setAttribute(header, 'aria-expanded', String(expanded));
  }

  private setAttribute(el: HTMLElement, name: string, value: string) {
    if (typeof (el as any).setAttribute === 'function') {
      (el as any).setAttribute(name, value);
    }
  }

  private hasClass(el: HTMLElement, name: string) {
    if (typeof (el as any).hasClass === 'function') {
      return (el as any).hasClass(name);
    }
    return el.classList.contains(name);
  }

  private addClass(el: HTMLElement, name: string) {
    if (typeof (el as any).addClass === 'function') {
      (el as any).addClass(name);
    } else {
      el.classList.add(name);
    }
  }

  private removeClass(el: HTMLElement, name: string) {
    if (typeof (el as any).removeClass === 'function') {
      (el as any).removeClass(name);
    } else {
      el.classList.remove(name);
    }
  }

  private toggleClass(el: HTMLElement, name: string, enabled: boolean) {
    if (typeof (el as any).toggleClass === 'function') {
      (el as any).toggleClass(name, enabled);
      return;
    }

    if (enabled) this.addClass(el, name);
    else this.removeClass(el, name);
  }
}

function firstString(input: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function truncate(value: string) {
  return value.length > 80 ? `${value.substring(0, 77)}...` : value;
}

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function safeStringify(value: unknown) {
  if (typeof value === 'string') return value;

  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch (_error) {
    return String(value);
  }
}
