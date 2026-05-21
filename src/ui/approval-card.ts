import { ChangePreview } from './diff/change-preview';
import { renderChangePreviewCard } from './components/change-preview-card';
import { setIcon } from 'obsidian';

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
  copy.createDiv({ cls: 'shell-approval-risk', text: `${capitalize(risk)} risk` });

  const facts = card.createDiv({ cls: 'shell-approval-facts' });
  renderFact(facts, 'Action', request.action, 'shell-approval-action-value');
  renderFact(facts, 'Target', request.target, 'shell-approval-target-value');

  if (request.preview?.preconditions?.length) {
    const preconditions = card.createDiv({ cls: 'shell-approval-preconditions' });
    for (const condition of request.preview.preconditions) {
      preconditions.createDiv({ cls: 'shell-approval-precondition', text: condition });
    }
  }

  if (request.preview) {
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

  if (handlers.onFocusPreview) {
    buttons.push(createIconButton(actions, 'shell-approval-focus-preview', 'locate-fixed', 'Show editor preview', setIconFn, () => {
      if (pending) return;
      void handlers.onFocusPreview?.();
    }));
  }
  const cancelButton = createIconButton(actions, 'shell-approval-cancel', 'x', 'Cancel', setIconFn, () => {
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
  if (action.includes('delete') || action.includes('remove')) return 'Approve delete';
  if (action.includes('create')) return 'Approve create';
  if (action.includes('edit') || action.includes('modify') || action.includes('update') || action.includes('replace')) {
    return 'Approve edit';
  }
  return 'Approve action';
}

function getApprovalTitle(request: ApprovalRequest) {
  const action = request.action.toLowerCase();
  if (action.includes('delete') || action.includes('remove')) return '\u9700\u8981\u5ba1\u6279\uff1a\u5220\u9664\u5185\u5bb9';
  if (action.includes('create')) return '\u9700\u8981\u5ba1\u6279\uff1a\u521b\u5efa\u5185\u5bb9';
  if (action.includes('edit') || action.includes('modify') || action.includes('update') || action.includes('replace')) {
    return '\u9700\u8981\u5ba1\u6279\uff1a\u4fee\u6539\u5f53\u524d\u7b14\u8bb0';
  }
  if (action.includes('plugin')) return '\u9700\u8981\u5ba1\u6279\uff1a\u6267\u884c\u63d2\u4ef6\u64cd\u4f5c';
  return '\u9700\u8981\u5ba1\u6279\uff1a\u786e\u8ba4\u64cd\u4f5c';
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
