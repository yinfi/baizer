import { ChangePreview } from '../diff/change-preview';
import { t } from '../../i18n/zh';

export interface ExternalPublishEditHandlers {
  /** 审批请求的 args —— 可编辑字节的唯一权威来源。 */
  args: Record<string, unknown>;
  /** 仅在审批状态为 pending 时为 true；running 与终态下渲染为只读。 */
  editable: boolean;
  /** 用户编辑即写回 request.args（带防抖）。 */
  onEdit?: (patch: { title?: string; body?: string }) => void;
}

export function renderChangePreviewCard(
  container: HTMLElement,
  preview: ChangePreview,
  publish?: ExternalPublishEditHandlers,
) {
  const card = container.createDiv({ cls: 'shell-change-preview-card' });
  card.createDiv({ cls: 'shell-change-preview-summary', text: preview.summary });
  card.createDiv({ cls: 'shell-change-preview-target', text: preview.target });

  if (preview.kind === 'external-publish' && publish) {
    renderExternalPublish(card, preview, publish);
    return card;
  }

  if (preview.oldContent !== undefined || preview.newContent !== undefined) {
    renderCompactDiff(card, preview.oldContent ?? '', preview.newContent ?? '');
  }

  return card;
}

/**
 * 对外发布的确认区：标题与正文**从 request.args 取、编辑写回 request.args**。
 *
 * 不读 `preview.newContent` / 不在 preview 上另存一份：preview 也被持久化，一旦它
 * 承载字节，重挂载后卡片就会显示旧正文而提交走 args 里的新正文——稳定复现
 * 「用户批准的 ≠ 他看到的」。对外发布没有「旧内容」，所以也不做 diff 渲染。
 */
function renderExternalPublish(
  card: HTMLElement,
  preview: ChangePreview,
  publish: ExternalPublishEditHandlers,
) {
  const meta = preview.externalPublish;
  const body = card.createDiv({ cls: 'shell-external-publish' });

  if (meta) {
    const facts = body.createDiv({ cls: 'shell-external-publish-meta' });
    facts.createDiv({ cls: 'shell-external-publish-repo', text: `${t('Repository')}: ${meta.repo}` });
    if (meta.labels.length) {
      facts.createDiv({ cls: 'shell-external-publish-labels', text: `${t('Labels')}: ${meta.labels.join(', ')}` });
    }
    if (meta.kind === 'issue_comment' && meta.issueNumber !== undefined) {
      facts.createDiv({ cls: 'shell-external-publish-issue', text: `${t('Issue')}: #${meta.issueNumber}` });
    }
  }

  const titleValue = typeof publish.args.title === 'string' ? publish.args.title : '';
  const bodyValue = typeof publish.args.body === 'string' ? publish.args.body : '';

  if (meta?.kind !== 'issue_comment') {
    renderEditableField(body, {
      cls: 'shell-external-publish-title',
      label: t('Title'),
      value: titleValue,
      multiline: false,
      editable: publish.editable,
      onChange: (value) => publish.onEdit?.({ title: value }),
    });
  }

  renderEditableField(body, {
    cls: 'shell-external-publish-body',
    label: t('Body'),
    value: bodyValue,
    multiline: true,
    editable: publish.editable,
    onChange: (value) => publish.onEdit?.({ body: value }),
  });

  // 三条警告缺一不可（BR4.3）：公开可见 / 以发布方账号发出且留下联系方式即公开它 /
  // 创建后无法由插件撤回。另解释为什么关掉执行确认后这里仍要确认。
  const warnings = body.createDiv({ cls: 'shell-external-publish-warnings' });
  for (const warning of [
    t('This will be published publicly. Anyone can read it, and it cannot be withdrawn.'),
    t('Issues are posted as the maintainer account, so the report does not show who filed it. To be reachable, put contact details in the body yourself — and note that leaving them publishes them.'),
    t('Why confirm when execution confirmation is off? That setting authorises changes to your own vault. This action leaves a public, irreversible record, so it always asks.'),
  ]) {
    warnings.createDiv({ cls: 'shell-external-publish-warning', text: warning });
  }
}

function renderEditableField(
  container: HTMLElement,
  options: {
    cls: string;
    label: string;
    value: string;
    multiline: boolean;
    editable: boolean;
    onChange: (value: string) => void;
  },
) {
  const field = container.createDiv({ cls: `shell-external-publish-field ${options.cls}` });
  field.createDiv({ cls: 'shell-external-publish-field-label', text: options.label });

  if (!options.editable) {
    // 只读态下不出现任何可编辑控件——避免用户在提交过程中改动正在传输的字节。
    field.createDiv({ cls: 'shell-external-publish-readonly', text: options.value });
    return;
  }

  const input = options.multiline
    ? field.createEl('textarea', { cls: 'shell-external-publish-input', attr: { 'aria-label': options.label, rows: '8' } })
    : field.createEl('input', { cls: 'shell-external-publish-input', attr: { type: 'text', 'aria-label': options.label } });
  (input as HTMLInputElement | HTMLTextAreaElement).value = options.value;
  input.addEventListener('input', () => {
    options.onChange((input as HTMLInputElement | HTMLTextAreaElement).value);
  });
}

type DiffRow = { type: 'added' | 'removed' | 'context'; text: string };

function renderCompactDiff(card: HTMLElement, oldContent: string, newContent: string) {
  const diff = buildCompactDiff(oldContent, newContent);
  const diffEl = card.createDiv({ cls: 'shell-change-preview-diff' });
  const header = diffEl.createDiv({ cls: 'shell-change-preview-diff-header' });
  header.createDiv({ cls: 'shell-change-preview-diff-title', text: 'Preview diff' });
  header.createDiv({
    cls: 'shell-change-preview-diff-count',
    text: `${diff.changedLines} changed ${diff.changedLines === 1 ? 'line' : 'lines'}`,
  });

  const lines = diffEl.createDiv({ cls: 'shell-change-preview-diff-lines' });
  for (const row of diff.rows) {
    lines.createDiv({
      cls: `shell-change-preview-diff-line shell-change-preview-diff-line-${row.type}`,
      text: `${row.type === 'added' ? '+ ' : row.type === 'removed' ? '- ' : '  '}${row.text}`,
    });
  }

  if (diff.truncated) {
    lines.createDiv({ cls: 'shell-change-preview-diff-line shell-change-preview-diff-line-more', text: '...' });
  }
}

function buildCompactDiff(oldContent: string, newContent: string) {
  const oldLines = oldContent.split(/\r?\n/);
  const newLines = newContent.split(/\r?\n/);
  const max = Math.max(oldLines.length, newLines.length);
  const rows: DiffRow[] = [];
  let changedLines = 0;

  for (let index = 0; index < max; index += 1) {
    const oldLine = oldLines[index];
    const newLine = newLines[index];
    if (oldLine === newLine) {
      continue;
    }

    if (oldLine !== undefined) {
      changedLines += 1;
      rows.push({ type: 'removed', text: oldLine });
    }
    if (newLine !== undefined) {
      changedLines += 1;
      rows.push({ type: 'added', text: newLine });
    }
  }

  if (!rows.length) {
    rows.push({ type: 'context', text: oldLines[0] || newLines[0] || '' });
  }

  return { rows, changedLines, truncated: false };
}
