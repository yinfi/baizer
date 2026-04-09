import { Modal, App, ButtonComponent } from 'obsidian';

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
        contentEl.addClass('ocli-diff-modal');

        contentEl.createEl('h2', { text: 'Review Changes' });

        const diffContainer = contentEl.createDiv({ cls: 'diff-container' });
        this.renderDiff(diffContainer);

        const buttonContainer = contentEl.createDiv({ cls: 'diff-actions' });
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'flex-end';
        buttonContainer.style.gap = '10px';
        buttonContainer.style.marginTop = '20px';

        new ButtonComponent(buttonContainer)
            .setButtonText('Cancel')
            .onClick(() => this.close());

        new ButtonComponent(buttonContainer)
            .setButtonText('Apply Changes')
            .setCta()
            .onClick(() => {
                this.onApply();
                this.close();
            });
    }

    renderDiff(container: HTMLElement) {
        container.style.maxHeight = '60vh';
        container.style.overflowY = 'auto';
        container.style.fontFamily = 'monospace';
        container.style.whiteSpace = 'pre-wrap';
        container.style.backgroundColor = 'var(--background-primary)';
        container.style.padding = '10px';
        container.style.borderRadius = '4px';
        container.style.border = '1px solid var(--background-modifier-border)';

        const oldLines = this.original.split('\n');
        const newLines = this.modified.split('\n');

        // Very naive diff for now: just show side-by-side or stacked?
        // Let's do a simple unified diff visualization

        let i = 0;
        let j = 0;

        while (i < oldLines.length || j < newLines.length) {
            const oldLine = oldLines[i];
            const newLine = newLines[j];

            if (oldLine === newLine) {
                this.createLine(container, '  ' + (oldLine || ''), 'diff-unchanged');
                i++;
                j++;
            } else {
                // This is a very dumb diff, it doesn't try to resync.
                // For a real diff, we need the 'diff' package or a proper LCS algorithm.
                // Since we can't easily add dependencies, let's try a slightly smarter heuristic:
                // If lines don't match, check if the next few lines match.

                let matchFound = false;
                // Look ahead in newLines
                for (let k = 1; k < 5; k++) {
                    if (j + k < newLines.length && oldLine === newLines[j + k]) {
                        // Found a match later in newLines -> Insertion
                        for (let m = 0; m < k; m++) {
                            this.createLine(container, '+ ' + newLines[j + m], 'diff-added');
                        }
                        j += k;
                        matchFound = true;
                        break;
                    }
                }

                if (!matchFound) {
                    // Look ahead in oldLines
                    for (let k = 1; k < 5; k++) {
                        if (i + k < oldLines.length && oldLines[i + k] === newLine) {
                            // Found a match later in oldLines -> Deletion
                            for (let m = 0; m < k; m++) {
                                this.createLine(container, '- ' + oldLines[i + m], 'diff-removed');
                            }
                            i += k;
                            matchFound = true;
                            break;
                        }
                    }
                }

                if (!matchFound) {
                    // Modification (Delete + Add)
                    if (i < oldLines.length) {
                        this.createLine(container, '- ' + oldLines[i], 'diff-removed');
                        i++;
                    }
                    if (j < newLines.length) {
                        this.createLine(container, '+ ' + newLines[j], 'diff-added');
                        j++;
                    }
                }
            }
        }
    }

    createLine(container: HTMLElement, text: string, type: 'diff-unchanged' | 'diff-added' | 'diff-removed') {
        const div = container.createDiv({ cls: `diff-line ${type}` });
        div.setText(text);
        if (type === 'diff-added') {
            div.style.backgroundColor = 'rgba(0, 255, 0, 0.1)';
            div.style.color = 'var(--text-success)';
        } else if (type === 'diff-removed') {
            div.style.backgroundColor = 'rgba(255, 0, 0, 0.1)';
            div.style.color = 'var(--text-error)';
            div.style.textDecoration = 'line-through';
        } else {
            div.style.color = 'var(--text-muted)';
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
