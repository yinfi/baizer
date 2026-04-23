export interface ApprovalRequest {
  action: string;
  target: string;
  args: Record<string, any>;
  message: string;
}

interface ApprovalCardHandlers {
  onApprove: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}

export function renderApprovalCard(
  container: any,
  request: ApprovalRequest,
  handlers: ApprovalCardHandlers,
) {
  const card = container.createDiv({ cls: 'shell-approval-card' });
  card.createDiv({ cls: 'shell-approval-title', text: 'Approval Required' });
  card.createDiv({ cls: 'shell-approval-message', text: request.message });

  const actions = card.createDiv({ cls: 'shell-approval-actions' });
  const approveButton = actions.createEl('button', {
    cls: 'shell-approval-btn shell-approval-confirm',
    text: 'Approve',
  });
  const cancelButton = actions.createEl('button', {
    cls: 'shell-approval-btn shell-approval-cancel',
    text: 'Cancel',
  });

  approveButton.addEventListener('click', () => {
    void handlers.onApprove();
  });
  cancelButton.addEventListener('click', () => {
    void handlers.onCancel();
  });

  return card;
}
