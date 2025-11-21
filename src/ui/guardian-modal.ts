import { App, Modal, Setting, Notice } from 'obsidian';

export class GuardianModal extends Modal {
    result: string;
    onSubmit: (result: string) => void;

    constructor(app: App, onSubmit: (result: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;

        contentEl.createEl('h2', { text: 'Guardian Manual Trigger' });

        new Setting(contentEl)
            .setName('Instruction')
            .setDesc('What should I do with the current context?')
            .addText(text => text
                .setPlaceholder('e.g. Translate to English, Summarize, Fix grammar...')
                .setValue('')
                .onChange(value => {
                    this.result = value;
                })
                .inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
                    if (e.key === 'Enter') {
                        this.submit();
                    }
                }));

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Submit')
                .setCta()
                .onClick(() => {
                    this.submit();
                }));
    }

    submit() {
        if (!this.result) {
            new Notice('Please enter an instruction.');
            return;
        }
        this.close();
        this.onSubmit(this.result);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
