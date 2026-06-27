import { App, Modal, Notice, setIcon } from 'obsidian';

/** 单个待附加文件的读取结果。data 为文件名（展示用），content 为读出的文本。 */
export interface AttachmentResult {
    name: string;
    content: string;
    size: number;
}

/**
 * 可附加为上下文的纯文本类扩展名白名单。
 * 二进制文件（图片/pdf/压缩包等）读成文本只会得到乱码，故在入口拦截。
 */
const TEXT_EXTENSIONS = new Set([
    'md', 'markdown', 'txt', 'text', 'log', 'csv', 'tsv',
    'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'env', 'conf', 'cfg',
    'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java',
    'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'php', 'swift', 'kt', 'scala',
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat',
    'html', 'htm', 'xml', 'css', 'scss', 'sass', 'less', 'vue', 'svelte',
    'sql', 'graphql', 'gql', 'r', 'lua', 'pl', 'dart',
]);

/** 单文件大小上限（字节）。超限文件内容会被 context budget 截断，这里只挡住极端大文件，避免读取卡顿。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

function getExtension(name: string): string {
    const idx = name.lastIndexOf('.');
    return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

function isTextFile(name: string): boolean {
    const ext = getExtension(name);
    // 无扩展名的文件（如 Dockerfile、Makefile）也按文本处理。
    return ext === '' || TEXT_EXTENSIONS.has(ext);
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 文件附件选择弹窗。
 * 支持点击选择 / 拖放多个本地文本文件，读出内容后通过 onSubmit 一次性回传。
 * 仅处理文本类文件；二进制与超大文件在加入列表时即被拦截并提示。
 */
export class AttachmentModal extends Modal {
    private readonly onSubmit: (results: AttachmentResult[]) => void;
    private readonly pending = new Map<string, AttachmentResult>();
    private listEl: HTMLElement | null = null;
    private confirmButton: HTMLButtonElement | null = null;
    private fileInput: HTMLInputElement | null = null;

    constructor(app: App, onSubmit: (results: AttachmentResult[]) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl, modalEl } = this;
        modalEl.addClass('baizer-attachment-modal');
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Add file attachment' });
        contentEl.createEl('p', {
            cls: 'baizer-attachment-hint',
            text: 'Attach local text files as context. Binary files (images, PDFs) are not supported.',
        });

        // 拖放 + 点击选择区
        const dropZone = contentEl.createDiv({ cls: 'baizer-attachment-dropzone' });
        const dropIcon = dropZone.createSpan({ cls: 'baizer-attachment-dropzone-icon' });
        setIcon(dropIcon, 'file-plus');
        dropZone.createSpan({
            cls: 'baizer-attachment-dropzone-text',
            text: 'Click to choose files, or drop them here',
        });

        // 隐藏的原生 file input —— 浏览器 API，移动端兼容，不碰 Node fs。
        this.fileInput = contentEl.createEl('input', {
            attr: { type: 'file', multiple: 'true', accept: '.md,.txt,.json,.csv,.js,.ts,.py,text/*' },
        }) as HTMLInputElement;
        this.fileInput.style.display = 'none';

        dropZone.addEventListener('click', () => this.fileInput?.click());
        this.fileInput.addEventListener('change', () => {
            const files = this.fileInput?.files;
            if (files) void this.ingestFiles(Array.from(files));
            // 复位 input，确保再次选同名文件也能触发 change。
            if (this.fileInput) this.fileInput.value = '';
        });

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.addClass('is-dragover');
        });
        dropZone.addEventListener('dragleave', () => dropZone.removeClass('is-dragover'));
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.removeClass('is-dragover');
            const files = e.dataTransfer?.files;
            if (files) void this.ingestFiles(Array.from(files));
        });

        // 已选文件列表
        this.listEl = contentEl.createDiv({ cls: 'baizer-attachment-list' });
        this.renderList();

        // 底部操作按钮
        const actions = contentEl.createDiv({ cls: 'baizer-attachment-actions' });
        const cancelBtn = actions.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        this.confirmButton = actions.createEl('button', {
            text: 'Attach',
            cls: 'mod-cta',
        }) as HTMLButtonElement;
        this.confirmButton.addEventListener('click', () => this.submit());
        this.updateConfirmState();
    }

    /** 读取并校验一批文件，逐个加入待附加列表。 */
    private async ingestFiles(files: File[]) {
        for (const file of files) {
            if (this.pending.has(file.name)) {
                new Notice(`"${file.name}" is already added.`);
                continue;
            }
            if (!isTextFile(file.name)) {
                new Notice(`"${file.name}" is not a supported text file.`);
                continue;
            }
            if (file.size > MAX_FILE_BYTES) {
                new Notice(`"${file.name}" is too large (max ${formatBytes(MAX_FILE_BYTES)}).`);
                continue;
            }
            try {
                const content = await this.readAsText(file);
                this.pending.set(file.name, { name: file.name, content, size: file.size });
            } catch (err) {
                new Notice(`Failed to read "${file.name}".`);
            }
        }
        this.renderList();
        this.updateConfirmState();
    }

    private readAsText(file: File): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
            reader.onerror = () => reject(reader.error ?? new Error('read error'));
            reader.readAsText(file);
        });
    }

    private renderList() {
        if (!this.listEl) return;
        this.listEl.empty();

        if (this.pending.size === 0) {
            this.listEl.createDiv({
                cls: 'baizer-attachment-empty',
                text: 'No files selected yet.',
            });
            return;
        }

        for (const result of this.pending.values()) {
            const row = this.listEl.createDiv({ cls: 'baizer-attachment-row' });
            const icon = row.createSpan({ cls: 'baizer-attachment-row-icon' });
            setIcon(icon, 'file-text');
            const meta = row.createDiv({ cls: 'baizer-attachment-row-meta' });
            meta.createSpan({ cls: 'baizer-attachment-row-name', text: result.name });
            meta.createSpan({ cls: 'baizer-attachment-row-size', text: formatBytes(result.size) });

            const removeBtn = row.createEl('button', {
                cls: 'baizer-attachment-row-remove clickable-icon',
                attr: { 'aria-label': 'Remove file', title: 'Remove file' },
            });
            setIcon(removeBtn, 'x');
            removeBtn.addEventListener('click', () => {
                this.pending.delete(result.name);
                this.renderList();
                this.updateConfirmState();
            });
        }
    }

    private updateConfirmState() {
        if (!this.confirmButton) return;
        const count = this.pending.size;
        this.confirmButton.disabled = count === 0;
        this.confirmButton.setText(count > 0 ? `Attach ${count} file${count > 1 ? 's' : ''}` : 'Attach');
    }

    private submit() {
        const results = Array.from(this.pending.values());
        if (results.length === 0) {
            new Notice('Please choose at least one file.');
            return;
        }
        this.close();
        this.onSubmit(results);
    }

    onClose() {
        this.contentEl.empty();
        this.pending.clear();
    }
}
