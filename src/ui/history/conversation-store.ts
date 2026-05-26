import { App } from 'obsidian';
import { ConversationSnapshot } from '../types';
import { cloneChangePreview } from '../diff/change-preview';
import { PLUGIN_DATA_DIR } from '../../mcp/types';

export const CONVERSATION_STORE_DIR = PLUGIN_DATA_DIR;
export const CONVERSATION_STORE_PATH = `${CONVERSATION_STORE_DIR}/conversations.json`;

interface ConversationFile {
    version: 1;
    conversations: ConversationSnapshot[];
}

interface ConversationStoreOptions {
    maxConversations?: number;
    path?: string;
}

interface VaultAdapter {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    mkdir(path: string): Promise<void>;
}

export class ConversationStore {
    private readonly maxConversations: number;
    private readonly path: string;
    private readonly dir: string;

    constructor(private readonly app: App, options: ConversationStoreOptions = {}) {
        this.maxConversations = options.maxConversations ?? 100;
        this.path = options.path ?? CONVERSATION_STORE_PATH;
        this.dir = this.path.split('/').slice(0, -1).join('/');
    }

    async list(): Promise<ConversationSnapshot[]> {
        const file = await this.readFile();
        return this.sortAndClone(file.conversations);
    }

    async save(snapshot: ConversationSnapshot): Promise<void> {
        const file = await this.readFile();
        const next = file.conversations.filter(conversation => conversation.id !== snapshot.id);
        next.push(this.cloneSnapshot(snapshot));

        await this.writeFile({
            version: 1,
            conversations: this.sortAndClone(next).slice(0, this.maxConversations),
        });
    }

    async delete(id: string): Promise<void> {
        const file = await this.readFile();
        const next = file.conversations.filter(conversation => conversation.id !== id);

        await this.writeFile({
            version: 1,
            conversations: this.sortAndClone(next).slice(0, this.maxConversations),
        });
    }

    private async readFile(): Promise<ConversationFile> {
        const adapter = this.getAdapter();

        try {
            if (!await adapter.exists(this.path)) {
                return this.emptyFile();
            }

            const raw = await adapter.read(this.path);
            const parsed = JSON.parse(raw);
            if (!this.isConversationFile(parsed)) {
                return this.emptyFile();
            }

            return {
                version: 1,
                conversations: parsed.conversations.map(conversation => this.cloneSnapshot(conversation)),
            };
        } catch {
            return this.emptyFile();
        }
    }

    private async writeFile(file: ConversationFile): Promise<void> {
        await this.ensureDirectory(this.dir);
        await this.getAdapter().write(this.path, JSON.stringify(file, null, 2));
    }

    private async ensureDirectory(path: string): Promise<void> {
        if (!path) return;

        const adapter = this.getAdapter();
        const parts = path.split('/').filter(Boolean);
        let current = '';

        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!await adapter.exists(current)) {
                await adapter.mkdir(current);
            }
        }
    }

    private getAdapter(): VaultAdapter {
        return this.app.vault.adapter as unknown as VaultAdapter;
    }

    private emptyFile(): ConversationFile {
        return { version: 1, conversations: [] };
    }

    private isConversationFile(value: any): value is ConversationFile {
        return value
            && value.version === 1
            && Array.isArray(value.conversations)
            && value.conversations.every((conversation: any) => (
                typeof conversation?.id === 'string'
                && typeof conversation.title === 'string'
                && typeof conversation.createdAt === 'number'
                && typeof conversation.updatedAt === 'number'
                && typeof conversation.providerId === 'string'
                && typeof conversation.modelId === 'string'
                && Array.isArray(conversation.messages)
            ));
    }

    private sortAndClone(conversations: ConversationSnapshot[]): ConversationSnapshot[] {
        return [...conversations]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(conversation => this.cloneSnapshot(conversation));
    }

    private cloneSnapshot(snapshot: ConversationSnapshot): ConversationSnapshot {
        return {
            ...snapshot,
            messages: snapshot.messages.map(message => ({
                ...message,
                approval: message.approval
                    ? {
                        ...message.approval,
                        args: { ...message.approval.args },
                        preview: cloneChangePreview(message.approval.preview),
                    }
                    : undefined,
                metadata: message.metadata
                    ? {
                        ...message.metadata,
                        workspaceEdit: message.metadata.workspaceEdit
                            ? { ...message.metadata.workspaceEdit }
                            : undefined,
                    }
                    : undefined,
            })),
        };
    }
}
