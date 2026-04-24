export class ToolRenderer {
  private nodeCount = 0;

  constructor(private timeline: HTMLElement) { }

  addToolCall(name: string, args: any) {
    const node = this.timeline.createDiv({ cls: 'think-node is-tool' });
    node.dataset.toolName = name;
    const header = node.createDiv({ cls: 'think-node-header' });
    header.createSpan({ cls: 'think-node-icon', text: '🔧' });
    header.createSpan({ cls: 'think-node-label', text: name });
    const detail = node.createDiv({ cls: 'think-node-detail' });
    detail.textContent = JSON.stringify(args, null, 2);
    header.addEventListener('click', () => {
      node.toggleClass('is-expanded', !node.hasClass('is-expanded'));
    });
    this.nodeCount++;
  }

  updateToolResult(name: string, result: any, error?: string) {
    const nodes = this.timeline
      .querySelectorAll('.think-node')
      .filter((node: any) => node.hasClass?.('is-tool'));
    let targetNode: HTMLElement | null = null;
    for (let i = nodes.length - 1; i >= 0; i--) {
      if ((nodes[i] as HTMLElement).dataset.toolName === name) {
        targetNode = nodes[i] as HTMLElement;
        break;
      }
    }
    if (!targetNode) return;

    const detail = targetNode.querySelector('.think-node-detail') as HTMLElement;
    if (detail) {
      const resultText = error ? `Error: ${error}` : JSON.stringify(result, null, 2);
      detail.textContent += `\n--- Result ---\n${resultText}`;
    }
  }

  getNodeCount() {
    return this.nodeCount;
  }
}
