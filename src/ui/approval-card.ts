import { ChangePreview } from './diff/change-preview';
import { renderChangePreviewCard } from './components/change-preview-card';
import { setIcon } from 'obsidian';
import { t } from '../i18n/zh';
import { ApprovalState } from '../services/approval-execution';

// rename_note 工具同时承担「重命名」和「移动」两件事(底层都是 vault.rename)。
// 审批卡需按 oldPath/newPath 的父目录是否变化来区分,否则用户看到的「rename」文案
// 与实际发生的「移动到某目录」不符(截图问题 1)。
function parentDir(path: string): string {
  const norm = String(path ?? '').replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(0, idx) : '';
}

interface RenameInfo {
  isMove: boolean;
  oldPath: string;
  newPath: string;
}

function describeRename(request: ApprovalRequest): RenameInfo {
  const oldPath = String(request.args?.oldPath ?? request.target ?? '');
  const newPath = String(request.args?.newPath ?? '');
  // 父目录变了 = 移动(含「移动并改名」);父目录不变仅文件名变 = 纯重命名。
  return { isMove: parentDir(oldPath) !== parentDir(newPath), oldPath, newPath };
}

function isRenameRequest(request: ApprovalRequest): boolean {
  return request.preview?.kind === 'note-rename' || request.action?.toLowerCase().includes('rename');
}

// 只有「有新内容可在编辑器里预览」的操作才提供 🎯 聚焦预览按钮。
// 移动/重命名/删除/插件命令没有可预览的正文,点了只会弹「无预览」(截图问题 2)。
function previewSupportsEditorPreview(preview?: ChangePreview): boolean {
  if (!preview) return true; // 未知预览类型:保守保留按钮
  return preview.kind !== 'note-rename'
    && preview.kind !== 'note-delete'
    && preview.kind !== 'plugin-command';
}

export interface ApprovalRequest {
  /**
   * 审批请求身份。创建审批消息时生成一次并随会话快照持久化；
   * 执行登记表以它为键，保证同一请求最多执行一次。
   */
  id: string;
  /** 拥有该请求的会话(= UI tab id)。执行时校验，防止错误绑定到另一个会话。 */
  conversationId?: string;
  action: string;
  target: string;
  args: Record<string, any>;
  message: string;
  preview?: ChangePreview;
}

interface ApprovalCardHandlers {
  /** 批准本次操作；宿主负责把状态改为 running 并执行。 */
  onApprove: () => void | Promise<void>;
  /** 拒绝本次操作；不执行任何写入。 */
  onReject: () => void | Promise<void>;
  /** 失败后显式重试。 */
  onRetry?: () => void | Promise<void>;
  /** 结果未知时先核实（查登记表/审计记录），不直接重试。 */
  onRecheck?: () => void | Promise<void>;
  onFocusPreview?: () => void | Promise<void>;
  setIcon?: (el: HTMLElement, icon: string) => void;
  /** 渲染后把消息 id 写到卡片上，供宿主原位更新。 */
  messageId?: string;
}

/**
 * 渲染审批卡。
 *
 * `state` 是持久化的生命周期快照：pending / running / succeeded / failed /
 * rejected / unknown。卡片本身不持有请求状态，重挂载后由消息里的快照重新渲染，
 * 因此旧 DOM 释放不会丢请求。
 */
export function renderApprovalCard(
  container: HTMLElement,
  request: ApprovalRequest,
  handlers: ApprovalCardHandlers,
  state: ApprovalState = { status: 'pending' },
) {
  const risk = request.preview?.risk ?? inferRisk(request);
  const setIconFn = handlers.setIcon ?? setIcon;
  const status = state.status;
  const card = container.createDiv({ cls: `shell-approval-card is-${risk}-risk is-${status}` });
  if (handlers.messageId && typeof card.setAttribute === 'function') {
    card.setAttribute('data-approval-message-id', handlers.messageId);
  }

  const header = card.createDiv({ cls: 'shell-approval-header' });
  header.createDiv({ cls: 'shell-approval-icon', text: risk === 'high' ? '!' : 'i' });
  const copy = header.createDiv({ cls: 'shell-approval-copy' });
  copy.createDiv({ cls: 'shell-approval-title', text: getApprovalTitle(request) });
  copy.createDiv({ cls: 'shell-approval-message', text: request.message });
  copy.createDiv({ cls: 'shell-approval-risk', text: `${t(capitalize(risk))} ${t('risk')}` });

  const isRename = isRenameRequest(request);

  const facts = card.createDiv({ cls: 'shell-approval-facts' });
  if (isRename) {
    // 移动/重命名:一处「操作 + 从 → 到」即可说清,不再重复 Action/Target 两行 +
    // 内嵌预览子卡(对 rename 只是重复 summary 和同一路径)。仅去重,不动卡片结构。
    const info = describeRename(request);
    renderFact(facts, t('Operation'), info.isMove ? t('Move') : t('Rename'), 'shell-approval-action-value');
    renderFact(facts, t('From'), info.oldPath, 'shell-approval-target-value');
    renderFact(facts, t('To'), info.newPath, 'shell-approval-newpath-value');
  } else {
    renderFact(facts, t('Action'), request.action, 'shell-approval-action-value');
    renderFact(facts, t('Target'), request.target, 'shell-approval-target-value');
  }

  if (request.preview?.preconditions?.length) {
    const preconditions = card.createDiv({ cls: 'shell-approval-preconditions' });
    for (const condition of request.preview.preconditions) {
      preconditions.createDiv({ cls: 'shell-approval-precondition', text: condition });
    }
  }

  // 高风险操作在确认区域直接写清「动作 + 对象」，不依赖悬停/标题。
  if (risk === 'high' && status === 'pending') {
    card.createDiv({ cls: 'shell-approval-warning', text: describeHighRisk(request) });
  }

  if (request.preview && !isRename) {
    renderChangePreviewCard(card, request.preview);
  }

  if (status === 'pending' || status === 'running') {
    renderDecisionActions(card, request, handlers, risk, setIconFn, status === 'running');
    return card;
  }

  renderOutcome(card, state, handlers);
  return card;
}

function renderDecisionActions(
  card: HTMLElement,
  request: ApprovalRequest,
  handlers: ApprovalCardHandlers,
  risk: 'low' | 'medium' | 'high',
  setIconFn: (el: HTMLElement, icon: string) => void,
  running: boolean,
) {
  const actions = card.createDiv({ cls: 'shell-approval-actions' });
  const buttons: HTMLButtonElement[] = [];
  let clicked = false;
  const disableAllButtons = () => {
    for (const button of buttons) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
    }
  };

  if (running) {
    const status = actions.createDiv({ cls: 'shell-approval-processing', text: t('Processing…') });
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('tabindex', '-1');
  }

  if (!running && handlers.onFocusPreview && previewSupportsEditorPreview(request.preview)) {
    buttons.push(createIconButton(actions, 'shell-approval-focus-preview', 'locate-fixed', t('Show editor preview'), setIconFn, () => {
      if (clicked) return;
      void handlers.onFocusPreview?.();
    }));
  }

  buttons.push(createTextButton(actions, 'shell-approval-cancel', t('Reject'), running, () => {
    if (running || clicked) return;
    clicked = true;
    disableAllButtons();
    void handlers.onReject();
  }));

  const approveLabel = getApproveLabel(request);
  buttons.push(createTextButton(
    actions,
    `shell-approval-confirm${risk === 'high' ? ' is-danger' : ''}`,
    approveLabel,
    running,
    () => {
      if (running || clicked) return;
      clicked = true;
      disableAllButtons();
      void handlers.onApprove();
    },
  ));

  if (running) disableAllButtons();
}

function renderOutcome(
  card: HTMLElement,
  state: ApprovalState,
  handlers: ApprovalCardHandlers,
) {
  const outcome = state.outcome;
  const box = card.createDiv({ cls: `shell-approval-outcome is-${state.status}` });
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  box.setAttribute('tabindex', '-1');
  box.createDiv({ cls: 'shell-approval-outcome-title', text: outcomeTitle(state.status) });

  if (outcome?.detail) {
    box.createDiv({ cls: 'shell-approval-outcome-detail', text: outcome.detail });
  }
  if (outcome?.error && outcome.error !== outcome.detail) {
    box.createDiv({ cls: 'shell-approval-outcome-error', text: `${t('Reason')}: ${outcome.error}` });
  }

  const retryable = outcome?.retryable !== false;
  if (state.status === 'failed' && retryable && handlers.onRetry) {
    const actions = card.createDiv({ cls: 'shell-approval-actions' });
    let clicked = false;
    const button = createTextButton(actions, 'shell-approval-retry', t('Retry'), false, () => {
      if (clicked) return;
      clicked = true;
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
      void handlers.onRetry?.();
    });
    return;
  }

  if (state.status === 'unknown' && handlers.onRecheck) {
    const actions = card.createDiv({ cls: 'shell-approval-actions' });
    let clicked = false;
    const button = createTextButton(actions, 'shell-approval-recheck', t('Check result'), false, () => {
      if (clicked) return;
      clicked = true;
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
      void handlers.onRecheck?.();
    });
    return;
  }

  // 已拒绝 / 已成功 / 已执行但结果未知：不再提供会重复写入的入口。
}

function createTextButton(
  container: HTMLElement,
  className: string,
  label: string,
  disabled: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const button = container.createEl('button', {
    cls: `shell-approval-btn ${className}`,
    attr: { type: 'button', title: label, 'aria-label': label },
  });
  button.textContent = label;
  button.disabled = disabled;
  if (disabled) button.setAttribute('aria-disabled', 'true');
  button.addEventListener('click', onClick);
  return button;
}

function outcomeTitle(status: ApprovalState['status']) {
  switch (status) {
    case 'succeeded':
      return t('Approved and executed successfully');
    case 'failed':
      return t('Approved but execution failed');
    case 'rejected':
      return t('Rejected — no changes were made');
    case 'unknown':
      return t('Execution result is unknown');
    default:
      return '';
  }
}

function describeHighRisk(request: ApprovalRequest): string {
  const info = isRenameRequest(request) ? describeRename(request) : null;
  const target = info
    ? `${info.oldPath} → ${info.newPath}`
    : request.target;
  return `${t('High-risk action: this will')} ${actionVerb(request)} ${target}${t('. Approving executes it immediately and may not be undoable.')}`;
}

function actionVerb(request: ApprovalRequest): string {
  const action = request.action.toLowerCase();
  if (action.includes('delete') || action.includes('remove')) return t('delete');
  if (action.includes('create')) return t('create');
  if (isRenameRequest(request)) return describeRename(request).isMove ? t('move') : t('rename');
  if (action.includes('edit') || action.includes('modify') || action.includes('update') || action.includes('replace')) {
    return t('modify');
  }
  if (action.includes('plugin')) return t('run a plugin command');
  return t('execute');
}

function createIconButton(
  container: HTMLElement,
  className: string,
  icon: string,
  label: string,
  setIconFn: (el: HTMLElement, icon: string) => void,
  onClick: () => void,
): HTMLButtonElement {
  const button = container.createEl('button', {
    cls: `shell-approval-btn shell-approval-icon-btn ${className}`,
    attr: { type: 'button', title: label, 'aria-label': label },
  });
  setIconFn(button, icon);
  button.addEventListener('click', onClick);
  return button;
}

function renderFact(container: HTMLElement, label: string, value: string, valueClass: string) {
  const row = container.createDiv({ cls: 'shell-approval-fact' });
  row.createDiv({ cls: 'shell-approval-fact-label', text: label });
  row.createDiv({ cls: `shell-approval-fact-value ${valueClass}`, text: value });
}

function inferRisk(request: ApprovalRequest): 'low' | 'medium' | 'high' {
  return /delete|remove|overwrite|plugin/i.test(`${request.action} ${request.message}`)
    ? 'high'
    : 'medium';
}

function getApproveLabel(request: ApprovalRequest) {
  const action = request.action.toLowerCase();
  if (action.includes('delete') || action.includes('remove')) return t('Approve this delete');
  if (action.includes('create')) return t('Approve this create');
  if (isRenameRequest(request)) {
    return describeRename(request).isMove ? t('Approve this move') : t('Approve this rename');
  }
  if (action.includes('edit') || action.includes('modify') || action.includes('update') || action.includes('replace')) {
    return t('Approve this edit');
  }
  return t('Approve this action');
}

function getApprovalTitle(request: ApprovalRequest) {
  const action = request.action.toLowerCase();
  if (action.includes('delete') || action.includes('remove')) return t('Approval needed: delete content');
  if (action.includes('create')) return t('Approval needed: create content');
  if (isRenameRequest(request)) {
    return describeRename(request).isMove ? t('Approval needed: move file') : t('Approval needed: rename file');
  }
  if (action.includes('edit') || action.includes('modify') || action.includes('update') || action.includes('replace')) {
    return t('Approval needed: modify current note');
  }
  if (action.includes('plugin')) return t('Approval needed: run plugin command');
  return t('Approval needed: confirm operation');
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
