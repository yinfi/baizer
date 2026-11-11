// test/feedback-approval.test.ts — 对外发布预览的「展示 == 提交」不变量
//
// 这是本功能对「不可撤销的公开写入」的核心不变量：用户批准的必须正是他看到的。
// 可编辑字节的唯一权威是 request.args——卡片从它渲染、编辑写回它、执行提交它。
// preview 不承载任何可编辑字节（它也被持久化，一旦持有字节就会在重挂载后显示旧正文）。

import { renderChangePreviewCard } from '../src/ui/components/change-preview-card';
import { previewSupportsEditorPreview } from '../src/ui/approval-card';
import { cloneChangePreview, type ChangePreview } from '../src/ui/diff/change-preview';
import { setLocaleForTesting } from '../src/i18n/zh';
import { FakeElement } from './ui-fakes';

// 文案断言不能依赖跑测试那台机器的系统语言（t() 的 'auto' 会跟随 navigator.language）。
setLocaleForTesting(false);

function expect(condition: boolean, label: string) {
  if (!condition) throw new Error(label);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (e: any) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exit(1);
  }
}

function publishPreview(overrides: Partial<ChangePreview> = {}): ChangePreview {
  return {
    kind: 'external-publish',
    target: 'https://github.com/yinfi/baizer/issues',
    summary: 'New issue in yinfi/baizer',
    risk: 'high',
    supportsPartialApply: false,
    undoable: false,
    externalPublish: { repo: 'yinfi/baizer', kind: 'new_issue', labels: ['bug'] },
    ...overrides,
  };
}

function render(container: FakeElement, preview: ChangePreview, args: Record<string, unknown>, editable: boolean) {
  renderChangePreviewCard(container as any, preview, {
    args,
    editable,
    onEdit: (patch) => {
      if (typeof patch.title === 'string') args.title = patch.title;
      if (typeof patch.body === 'string') args.body = patch.body;
    },
  });
}

function typeInto(field: FakeElement, value: string) {
  field.value = value;
  for (const handler of field.listeners.input ?? []) handler();
}

function fieldInput(container: FakeElement, fieldClass: string): FakeElement | null {
  const field = container.querySelector(`.${fieldClass}`);
  return field ? field.querySelector('.shell-external-publish-input') : null;
}

async function runTests() {
  console.log('=== Feedback Approval Preview Tests ===');

  await test('an external-publish preview never offers the editor-preview button', () => {
    expectEqual(previewSupportsEditorPreview(publishPreview()), false, 'external-publish');
    // 其余 kind 的返回值不变。
    expectEqual(previewSupportsEditorPreview(undefined), true, 'unknown preview type keeps the button');
    expectEqual(previewSupportsEditorPreview({ ...publishPreview(), kind: 'note-replace' }), true, 'note-replace');
    expectEqual(previewSupportsEditorPreview({ ...publishPreview(), kind: 'note-append' }), true, 'note-append');
    expectEqual(previewSupportsEditorPreview({ ...publishPreview(), kind: 'note-create' }), true, 'note-create');
    expectEqual(previewSupportsEditorPreview({ ...publishPreview(), kind: 'editor-selection-replace' }), true, 'selection');
    expectEqual(previewSupportsEditorPreview({ ...publishPreview(), kind: 'note-rename' }), false, 'note-rename');
    expectEqual(previewSupportsEditorPreview({ ...publishPreview(), kind: 'note-delete' }), false, 'note-delete');
    expectEqual(previewSupportsEditorPreview({ ...publishPreview(), kind: 'plugin-command' }), false, 'plugin-command');
  });

  await test('editing the card writes back to request.args and survives a re-mount', () => {
    const args: Record<string, unknown> = { title: 'Crash on open', body: '### What happened\n\nIt crashes.' };
    const preview = publishPreview();

    const first = new FakeElement();
    render(first, preview, args, true);

    const titleInput = fieldInput(first, 'shell-external-publish-title');
    const bodyInput = fieldInput(first, 'shell-external-publish-body');
    expect(!!titleInput && !!bodyInput, 'the title and body must be editable in the pending state');
    expectEqual(titleInput?.value, 'Crash on open', 'the title renders from request.args');

    typeInto(titleInput!, 'Crash when opening the workbench');
    typeInto(bodyInput!, '### What happened\n\nIt crashes on the first open.');

    // 重挂载：用同一份 args 重新渲染（模拟切 tab / 重启后从消息快照恢复）。
    const second = new FakeElement();
    render(second, preview, args, true);
    const remountedTitle = fieldInput(second, 'shell-external-publish-title');
    const remountedBody = fieldInput(second, 'shell-external-publish-body');

    expectEqual(remountedTitle?.value, args.title, 'the re-mounted card shows what will be submitted');
    expectEqual(remountedBody?.value, args.body, 'the re-mounted body matches what will be submitted');
    expectEqual(args.body, '### What happened\n\nIt crashes on the first open.', 'the edit reached request.args');
  });

  await test('the preview object carries no editable bytes of its own', () => {
    const preview = publishPreview();
    expectEqual(preview.newContent, undefined, 'the body must not live on the preview');
    expectEqual(preview.externalPublish && 'title' in preview.externalPublish, false,
      'the meta must not carry a title');
    // cloneChangePreview 也必须原样透传（否则恢复路径会丢元信息）。
    const clone = cloneChangePreview(preview);
    expectEqual(clone?.externalPublish, preview.externalPublish, 'the meta survives cloning');
  });

  await test('the card is read-only while running and after a terminal state', () => {
    const args: Record<string, unknown> = { title: 'T', body: 'B' };
    const container = new FakeElement();
    render(container, publishPreview(), args, false);
    expectEqual(container.querySelector('.shell-external-publish-input'), null,
      'no editable control may exist outside the pending state');
    const bodyField = container.querySelector('.shell-external-publish-body');
    expectEqual(bodyField?.querySelector('.shell-external-publish-readonly')?.textContent, 'B',
      'the body is still shown, just read-only');
  });

  await test('the card states all three publication warnings', () => {
    const container = new FakeElement();
    render(container, publishPreview(), { title: 'T', body: 'B' }, true);
    const warnings = container.querySelectorAll('.shell-external-publish-warning');
    expectEqual(warnings.length, 3, 'all three warnings must be present');
    const text = warnings.map(warning => warning.textContent).join('\n');
    expect(text.includes('publicly'), 'the public-visibility warning');
    expect(text.includes('maintainer account'), 'the posted-as-maintainer warning');
    expect(text.includes('irreversible'), 'the cannot-be-withdrawn warning');
  });
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
