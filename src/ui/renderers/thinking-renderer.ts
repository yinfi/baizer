export class ThinkingRenderer {
  private currentThinkingNode: HTMLElement | null = null;
  private nodeCount = 0;

  constructor(private timeline: HTMLElement) { }

  appendThinking(content: string) {
    if (!this.currentThinkingNode) {
      this.currentThinkingNode = this.timeline.createDiv({ cls: 'think-node is-thinking' });
      const header = this.currentThinkingNode.createDiv({ cls: 'think-node-header' });
      header.createSpan({ cls: 'think-node-icon', text: '💡' });
      header.createSpan({ cls: 'think-node-label' });
      this.currentThinkingNode.createDiv({ cls: 'think-node-detail' });
      header.addEventListener('click', () => {
        this.currentThinkingNode?.toggleClass('is-expanded', !this.currentThinkingNode.hasClass('is-expanded'));
      });
      this.nodeCount++;
    }

    const detail = this.currentThinkingNode.querySelector('.think-node-detail') as HTMLElement;
    const label = this.currentThinkingNode.querySelector('.think-node-label') as HTMLElement;
    if (detail) detail.textContent = (detail.textContent || '') + content;
    if (label) {
      const fullText = detail?.textContent || '';
      label.textContent = fullText.length > 30 ? `${fullText.substring(0, 30)}...` : fullText;
    }
  }

  finalizeCurrentThinking() {
    if (!this.currentThinkingNode) return;
    this.currentThinkingNode.removeClass('is-thinking');
    this.currentThinkingNode = null;
  }

  getNodeCount() {
    return this.nodeCount;
  }
}
