import { ChangePreview } from './diff/change-preview';
import { renderChangePreviewCard } from './components/change-preview-card';
import { setIcon } from 'obsidian';
import { t } from '../i18n/zh';

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
  action: string;
  target: string;
  args: Record<string, any>;
  message: string;
  preview?: ChangePreview;
}

interface ApprovalCardHandlers {
  onApprove: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  onFocusPreview?: () => void | Promise<void>;
  setIcon?: (el: HTMLElement, icon: string) => void;
}

export function renderApprovalCard(
  container: any,
  request: ApprovalRequest,
  handlers: ApprovalCardHandlers,
) {
  const risk = request.preview?.risk ?? inferRisk(request);
  const setIconFn = handlers.setIcon ?? setIcon;
  const card = container.createDiv({ cls: `shell-approval-card is-${risk}-risk` });
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

  if (request.preview && !isRename) {
    renderChangePreviewCard(card, request.preview);
  }

  const actions = card.createDiv({ cls: 'shell-approval-actions' });
  let pending = false;
  const buttons: HTMLElement[] = [];
  const setPending = () => {
    pending = true;
    addClass(card, 'is-pending');
    for (const button of buttons) {
      (button as HTMLButtonElement).disabled = true;
      button.setAttribute('aria-disabled', 'true');
    }
  };

  if (handlers.onFocusPreview && previewSupportsEditorPreview(request.preview)) {
    buttons.push(createIconButton(actions, 'shell-approval-focus-preview', 'locate-fixed', t('Show editor preview'), setIconFn, () => {
      if (pending) return;
      void handlers.onFocusPreview?.();
    }));
  }
  const cancelButton = createIconButton(actions, 'shell-approval-cancel', 'x', t('Cancel'), setIconFn, () => {
    if (pending) return;
    setPending();
    void handlers.onCancel();
  });
  const approveButton = createIconButton(
    actions,
    `shell-approval-confirm${risk === 'high' ? ' is-danger' : ''}`,
    'check',
    getApproveLabel(request),
    setIconFn,
    () => {
      if (pending) return;
      setPending();
      void handlers.onApprove();
    },
  );
  buttons.push(cancelButton, approveButton);


  return card;
}

function addClass(el: any, className: string) {
  if (typeof el.addClass === 'function') {
    el.addClass(className);
    return;
  }
  if (el.classList?.add) {
    el.classList.add(className);
    return;
  }
  el.className = `${el.className || ''} ${className}`.trim();
}

function createIconButton(
  container: any,
  className: string,
  icon: string,
  label: string,
  setIconFn: (el: HTMLElement, icon: string) => void,
  onClick: () => void,
) {
  const button = container.createEl('button', {
    cls: `shell-approval-btn shell-approval-icon-btn ${className}`,
    attr: { type: 'button', title: label, 'aria-label': label },
  }) as HTMLElement;
  setIconFn(button, icon);
  button.addEventListener('click', onClick);
  return button;
}

function renderFact(container: any, label: string, value: string, valueClass: string) {
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
  if (action.includes('delete') || action.includes('remove')) return t('Approve delete');
  if (action.includes('create')) return t('Approve create');
  if (isRenameRequest(request)) {
    return describeRename(request).isMove ? t('Approve move') : t('Approve rename');
  }
  if (action.includes('edit') || action.includes('modify') || action.includes('update') || action.includes('replace')) {
    return t('Approve edit');
  }
  return t('Approve action');
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
