import { EditorView } from '@codemirror/view';
import { ModelService } from '../../services/model-service';
import { buildActionPrompt } from './action-registry';
import { showInlineDiff, clearInlineDiff, InlineDiffCallbacks } from './inline-diff';

export interface RewriteRequest {
  actionId: string;
  selection: string;
  from: number;
  to: number;
}

/**
 * 运行一次改写:
 * 1. 立即展示 loading 状态
 * 2. 调用 ModelService.generate
 * 3. 成功 → preview 状态；失败 → error 状态
 * 返回当次 AbortController,供调用方在需要时中止(例如用户再次触发新改写)。
 */
export function runRewrite(
  view: EditorView,
  modelService: ModelService,
  req: RewriteRequest,
): AbortController {
  const ac = new AbortController();

  // 立即推 loading
  showInlineDiff(view, {
    from: req.from,
    to: req.to,
    oldText: req.selection,
    newText: '',
    status: 'loading',
  });

  const prompt = buildActionPrompt(req.actionId, req.selection);

  modelService
    .generate(
      prompt,
      undefined,          // systemPrompt
      'selection-menu',   // source — 本场景专用；配合 skipGenerationPlan 跳过生成计划包装
      undefined,          // obsidianContext
      undefined,          // userProfile
      { signal: ac.signal, skipGenerationPlan: true },
    )
    .then((newText) => {
      if (ac.signal.aborted) return;
      showInlineDiff(view, {
        from: req.from,
        to: req.to,
        oldText: req.selection,
        newText: newText.trim(),
        status: 'preview',
      });
    })
    .catch((err: Error) => {
      if (ac.signal.aborted) return;
      showInlineDiff(view, {
        from: req.from,
        to: req.to,
        oldText: req.selection,
        newText: '',
        status: 'error',
        message: err.message || '改写失败',
      });
    });

  return ac;
}

/**
 * 构造标准 InlineDiffCallbacks:
 * - onAccept: 用新文本替换选区,清除 diff 装饰
 * - onReject: 清除 diff 装饰(保留原文)
 * - onRetry:  中止上次请求并重新发起改写
 */
export function makeRewriteCallbacks(
  view: EditorView,
  modelService: ModelService,
  getRequest: () => RewriteRequest | null,
  getController: () => AbortController | null,
  setController: (ac: AbortController | null) => void,
): InlineDiffCallbacks {
  return {
    onAccept(state) {
      view.dispatch({
        changes: { from: state.from, to: state.to, insert: state.newText },
      });
      clearInlineDiff(view);
      setController(null);
    },
    onReject() {
      clearInlineDiff(view);
      setController(null);
    },
    onRetry() {
      const req = getRequest();
      if (!req) return;
      // 中止上次请求
      getController()?.abort();
      const ac = runRewrite(view, modelService, req);
      setController(ac);
    },
  };
}
