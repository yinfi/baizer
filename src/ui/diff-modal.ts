import { Modal, App, ButtonComponent } from 'obsidian';
import { t } from '../i18n/zh';

type DiffRow = {
    type: 'added' | 'removed' | 'unchanged';
    text: string;
};

export class DiffModal extends Modal {
    constructor(
        app: App,
        private original: string,
        private modified: string,
        private onApply: () => void
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('baizer-diff-modal');

        const header = contentEl.createDiv({ cls: 'baizer-diff-modal-header' });
        const copy = header.createDiv({ cls: 'baizer-diff-modal-copy' });
        copy.createEl('h2', { text: t('Review Changes') });
        copy.createDiv({ cls: 'baizer-diff-modal-subtitle', text: t('Compare current content with the proposed replacement before applying.') });

        const summary = contentEl.createDiv({ cls: 'baizer-diff-summary' });
        this.renderStat(summary, t('Current'), this.countLines(this.original));
        this.renderStat(summary, t('Proposed'), this.countLines(this.modified));
        this.renderStat(summary, t('Changed'), this.countChangedLines());

        const diffContainer = contentEl.createDiv({ cls: 'diff-container baizer-diff-unified' });
        this.renderUnifiedDiff(diffContainer);

        const paneContainer = contentEl.createDiv({ cls: 'baizer-diff-panes' });
        this.renderPane(paneContainer, t('Current'), this.original, 'baizer-diff-pane-old');
        this.renderPane(paneContainer, t('Proposed'), this.modified, 'baizer-diff-pane-new');

        const buttonContainer = contentEl.createDiv({ cls: 'diff-actions' });

        new ButtonComponent(buttonContainer)
            .setButtonText(t('Cancel'))
            .onClick(() => this.close());

        new ButtonComponent(buttonContainer)
            .setButtonText(t('Apply Changes'))
            .setCta()
            .onClick(() => {
                this.onApply();
                this.close();
            });
    }

    private renderStat(container: HTMLElement, label: string, value: number) {
        const stat = container.createDiv({ cls: 'baizer-diff-stat' });
        stat.createSpan({ cls: 'baizer-diff-stat-label', text: label });
        stat.createSpan({ cls: 'baizer-diff-stat-value', text: String(value) });
    }

    private renderPane(container: HTMLElement, label: string, content: string, toneClass: string) {
        const pane = container.createDiv({ cls: `baizer-diff-pane ${toneClass}` });
        pane.createDiv({ cls: 'baizer-diff-pane-title', text: label });
        if (content.length === 0) {
            pane.createDiv({ cls: 'baizer-diff-empty', text: t('No content.') });
            return;
        }
        const pre = pane.createEl('pre', { cls: 'baizer-diff-pane-code' });
        pre.setText(content);
    }

    private renderUnifiedDiff(container: HTMLElement) {
        const rows = buildLineDiff(this.original, this.modified);
        if (rows.length === 0) {
            container.createDiv({ cls: 'baizer-diff-empty', text: t('No line-level changes.') });
            return;
        }

        for (const row of rows) {
            const prefix = row.type === 'added' ? '+ ' : row.type === 'removed' ? '- ' : '  ';
            const cls = row.type === 'added'
                ? 'diff-added'
                : row.type === 'removed'
                    ? 'diff-removed'
                    : 'diff-unchanged';
            this.createLine(container, `${prefix}${row.text}`, cls);
        }
    }

    private countChangedLines(): number {
        return buildLineDiff(this.original, this.modified)
            .filter(row => row.type !== 'unchanged')
            .length;
    }

    private countLines(content: string): number {
        if (!content) return 0;
        return content.split(/\r?\n/).length;
    }

    createLine(container: HTMLElement, text: string, type: 'diff-unchanged' | 'diff-added' | 'diff-removed') {
        const div = container.createDiv({ cls: `diff-line ${type}` });
        div.setText(text);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export function buildLineDiff(original: string, modified: string): DiffRow[] {
    const oldLines = splitLines(original);
    const newLines = splitLines(modified);
    if (oldLines.length === 0 && newLines.length === 0) return [];

    const table = buildLcsTable(oldLines, newLines);
    const rows: DiffRow[] = [];
    let i = 0;
    let j = 0;

    while (i < oldLines.length || j < newLines.length) {
        if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
            rows.push({ type: 'unchanged', text: oldLines[i] });
            i++;
            j++;
            continue;
        }

        if (j < newLines.length && (i === oldLines.length || table[i][j + 1] >= table[i + 1][j])) {
            rows.push({ type: 'added', text: newLines[j] });
            j++;
            continue;
        }

        if (i < oldLines.length) {
            rows.push({ type: 'removed', text: oldLines[i] });
            i++;
        }
    }

    return compactContext(rows);
}

function splitLines(content: string): string[] {
    if (content.length === 0) return [];
    return content.split(/\r?\n/);
}

function buildLcsTable(oldLines: string[], newLines: string[]): number[][] {
    const table = Array.from({ length: oldLines.length + 1 }, () => Array(newLines.length + 1).fill(0));

    for (let i = oldLines.length - 1; i >= 0; i--) {
        for (let j = newLines.length - 1; j >= 0; j--) {
            table[i][j] = oldLines[i] === newLines[j]
                ? table[i + 1][j + 1] + 1
                : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }

    return table;
}

function compactContext(rows: DiffRow[]): DiffRow[] {
    const changedIndexes = rows
        .map((row, index) => row.type !== 'unchanged' ? index : -1)
        .filter(index => index >= 0);
    if (changedIndexes.length === 0) return [];

    const keep = new Set<number>();
    for (const index of changedIndexes) {
        const start = Math.max(0, index - 2);
        const end = Math.min(rows.length - 1, index + 2);
        for (let i = start; i <= end; i++) {
            keep.add(i);
        }
    }

    const compacted: DiffRow[] = [];
    let lastKept = -1;
    for (let i = 0; i < rows.length; i++) {
        if (!keep.has(i)) continue;
        if (lastKept >= 0 && i - lastKept > 1) {
            compacted.push({ type: 'unchanged', text: '...' });
        }
        compacted.push(rows[i]);
        lastKept = i;
    }

    return compacted;
}
