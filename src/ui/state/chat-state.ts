import { ChatMessage, ToolRunState } from '../types';

export class ChatState {
    private messages: ChatMessage[] = [];
    private tools = new Map<string, ToolRunState>();
    private streaming = false;
    private dirty = false;

    constructor(private readonly tabId: string) { }

    getTabId(): string {
        return this.tabId;
    }

    addMessage(message: ChatMessage): void {
        this.messages.push(this.cloneMessage(message));
        this.markDirty();
    }

    updateMessage(id: string, patch: Partial<ChatMessage>): void {
        const index = this.messages.findIndex(message => message.id === id);
        if (index < 0) return;

        this.messages[index] = this.cloneMessage({
            ...this.messages[index],
            ...patch,
        });
        this.markDirty();
    }

    removeMessage(id: string): void {
        const next = this.messages.filter(message => message.id !== id);
        if (next.length === this.messages.length) return;

        this.messages = next;
        this.markDirty();
    }

    clearMessages(): void {
        if (this.messages.length === 0) return;

        this.messages = [];
        this.markDirty();
    }

    getMessages(): ChatMessage[] {
        return this.messages.map(message => this.cloneMessage(message));
    }

    setStreaming(value: boolean): void {
        if (this.streaming === value) return;

        this.streaming = value;
        this.markDirty();
    }

    isStreaming(): boolean {
        return this.streaming;
    }

    upsertTool(run: ToolRunState): void {
        this.tools.set(run.id, this.cloneTool(run));
        this.markDirty();
    }

    getTools(): ToolRunState[] {
        return Array.from(this.tools.values()).map(tool => this.cloneTool(tool));
    }

    markClean(): void {
        this.dirty = false;
    }

    isDirty(): boolean {
        return this.dirty;
    }

    private markDirty(): void {
        this.dirty = true;
    }

    private cloneMessage(message: ChatMessage): ChatMessage {
        return {
            ...message,
            approval: message.approval
                ? {
                    ...message.approval,
                    args: { ...message.approval.args },
                }
                : undefined,
            metadata: message.metadata ? { ...message.metadata } : undefined,
        };
    }

    private cloneTool(tool: ToolRunState): ToolRunState {
        return {
            ...tool,
            input: { ...tool.input },
        };
    }
}
