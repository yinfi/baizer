import { EditorView } from '@codemirror/view';
import { ModelService } from '../../services/model-service';
import { buildActionPrompt, SelectionActionContext } from './action-registry';
import { SelectionContextBuilder } from './selection-context-builder';
import { showInlineDiff, clearInlineDiff, InlineDiffCallbacks } from './inline-diff';
import { t } from '../../i18n/zh';

export interface RewriteRequest {
  actionId: string;
  selection: string;
  from: number;
  to: number;
  contextBuilder?: SelectionContextBuilder;   // 有则先装配上下文
  actionContext?: SelectionActionContext;      // 该动作声明的上下文需求
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

  const basePrompt = buildActionPrompt(req.actionId, req.selection);

  // 先按动作声明装配上下文(笔记/知识库/记忆),再发起一次性改写。
  // build 内部对每个源做超时兜底、绝不 reject,故装配失败只是退化为裸 prompt。
  void (async () => {
    const prompt = req.contextBuilder && req.actionContext
      ? await req.contextBuilder.build(req.actionContext, req.selection, basePrompt)
      : basePrompt;
    if (ac.signal.aborted) return;

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
          message: err.message || t('Rewrite failed'),
        });
      });
  })();

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
