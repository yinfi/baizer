/**
 * 流式 Markdown 块级增量渲染的切分工具(方案2 的正确性核心)。
 *
 * 目标:在一段仍在增长的 Markdown 文本里,找出「可以安全冻结渲染」的前缀长度。
 * 已闭合的块可以提前渲染成 HTML 并冻结,尾部未闭合内容继续以纯文本承载,
 * 从而做到「边流边渲染」且开销≈O(n)(每块只渲染一次),而非整段每帧重渲的 O(n²)。
 */

/**
 * 寻找一个「安全的块切分点」:最后一个位于代码围栏之外的空行边界处的偏移。
 * 返回可安全晋升(冻结渲染)的前缀长度;0 表示当前没有可闭合的完整块。
 *
 * 规则:
 *  - 逐行扫描,遇到 ``` 或 ~~~ 围栏起止则翻转「在代码块内」状态(同种标记才闭合)。
 *  - 只在「不在代码块内」时,把一个空行当作块边界。
 *  - 切分点取「最后一个安全空行之后」的位置。保证尾部始终留至少一个可能还在增长的块,
 *    避免把正在流入的半截结构(未闭合的列表/表格/围栏)提前渲染成错误 HTML。
 *  - 行内 Markdown(如 **bold**、`code`)从不触发切分,因为它不产生空行,天然留在尾部。
 */
export function findBlockBoundary(text: string): number {
  let inFence = false;
  let fenceChar = '';
  let lastBoundary = 0;
  let offset = 0;
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const fenceMatch = trimmed.match(/^(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
      } else if (marker === fenceChar) {
        inFence = false;
        fenceChar = '';
      }
    }

    // 累进到本行末尾(除最后一行外都含其后的换行符)对应的绝对偏移。
    offset += line.length + (i < lines.length - 1 ? 1 : 0);

    // 围栏外的空行 = 块边界;切分点落在该空行之后(下一行起始)。
    // i < lines.length - 1 保证最后一行(可能还没收到换行,仍在增长)永不作为边界。
    if (!inFence && trimmed === '' && i < lines.length - 1) {
      lastBoundary = offset;
    }
  }

  return lastBoundary;
}
