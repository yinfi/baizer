import { readFileSync } from 'fs';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function readJson<T>(path: string): T {
  return JSON.parse(read(path)) as T;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number(part));
  const right = b.split('.').map((part) => Number(part));
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

test('custom view leaves are preserved across plugin reloads', () => {
  const main = read('main.ts');
  assert(!main.includes('detachLeavesOfType(VIEW_TYPE_SHELL)'), 'Baizer shell leaves must not be detached during load/unload.');
  assert(!main.includes('leaves[0].detach()'), 'activateView must reveal an existing shell leaf instead of detaching it.');
});

test('declared Obsidian minimum supports used workspace APIs', () => {
  const manifest = readJson<{ version: string; minAppVersion: string }>('manifest.json');
  const versions = readJson<Record<string, string>>('versions.json');
  assert(compareVersions(manifest.minAppVersion, '1.7.2') >= 0, 'manifest minAppVersion must be at least 1.7.2 for Workspace.revealLeaf().');
  assert(versions[manifest.version] === manifest.minAppVersion, 'versions.json must match manifest minAppVersion for the current release.');
});

test('settings headings use Obsidian Setting.setHeading', () => {
  const settings = read('src/settings.ts');
  const directHeading = /\.createEl\(\s*['"]h[2-4]['"]/;
  assert(!directHeading.test(settings), 'settings headings must use new Setting(...).setName(...).setHeading().');
});

test('UI visibility and sizing do not assign style properties directly', () => {
  const files = [
    'src/ui/components/attachment-modal.ts',
    'src/ui/components/command-dropdown.ts',
    'src/ui/components/history-menu.ts',
    'src/ui/selection-ai/floating-panel.ts',
    'src/ui/selection-menu.ts',
    'src/ui/shell-view.ts',
  ];
  const directStyleAssignment = /\.style\.[A-Za-z_$][\w$]*\s*=/;
  for (const file of files) {
    assert(!directStyleAssignment.test(read(file)), `${file} must use classes or setCssStyles/setCssProps instead of direct style assignment.`);
  }
});

test('Markdown rendering keeps a registered Component lifecycle', () => {
  const selectionMenu = read('src/ui/selection-menu.ts');
  assert(!selectionMenu.includes('new Component())'), 'MarkdownRenderer.render must not receive an inline new Component().');
});

test('platform and dependencies follow Obsidian release guidelines', () => {
  const videoUtils = read('src/utils/video_utils.ts');
  assert(!videoUtils.includes('navigator.userAgent'), 'video_utils must avoid navigator OS/user-agent detection.');

  const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>('package.json');
  const dependencies = pkg.dependencies ?? {};
  assert(Boolean(dependencies['@codemirror/state']), '@codemirror/state must be declared in dependencies.');
  assert(Boolean(dependencies['@codemirror/view']), '@codemirror/view must be declared in dependencies.');
  assert(Boolean(dependencies['@earendil-works/pi-ai']), '@earendil-works/pi-ai must be declared in dependencies.');
  assert(!pkg.devDependencies?.['builtin-modules'], 'builtin-modules should be replaced with node:module builtinModules.');
});
