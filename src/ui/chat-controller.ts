import { App } from 'obsidian';
import { ModelService } from '../services/model-service';
import { logger } from '../utils/logger';

export interface ChatMessage {
    id: string;
    role: 'user' | 'ai' | 'system';
    content: string;
    timestamp: number;
}

export interface ChatControllerOptions {
    app: App;
    api: ModelService;
    onMessageAdded?: (message: ChatMessage) => void;
    onStatusChanged?: (isResponding: boolean) => void;
}

export class ChatController {
    private app: App;
    private api: ModelService;
    private messages: ChatMessage[] = [];
    // private isResponding: boolean = false; // Unused
    private onMessageAdded?: (message: ChatMessage) => void;
    private onStatusChanged?: (isResponding: boolean) => void;

    constructor(options: ChatControllerOptions) {
        this.app = options.app;
        this.api = options.api;
        this.onMessageAdded = options.onMessageAdded;
        this.onStatusChanged = options.onStatusChanged;
    }

    public getMessages(): ChatMessage[] {
        return [...this.messages];
    }

    public clearHistory() {
        this.messages = [];
        this.api.clearSession();
        this.addMessage('system', 'Session cleared.');
    }

    public async processCommand(query: string, context: string = '', selection: string = '') {
        if (!query.trim()) return;

        // 1. Handle Commands
        if (query.startsWith('/')) {
            await this.handleSlashCommand(query);
            return;
        }

        // 2. Normal Chat
        this.addMessage('user', query);
        this.setResponding(true);

        try {
            const response = await this.api.chat(query, context, selection);
            this.addMessage('ai', response);
        } catch (error: any) {
            this.handleError(error);
        } finally {
            this.setResponding(false);
        }
    }

    private async handleSlashCommand(query: string) {
        const [cmd, ...args] = query.split(' ');
        const argStr = args.join(' ');

        this.addMessage('user', query);

        switch (cmd) {
            case '/clear':
                this.clearHistory();
                break;
            case '/profile':
                const profile = this.api.getUserProfile();
                if (profile) {
                    let text = '## User Profile\n\n';
                    if (profile.name) text += `**Name**: ${profile.name}\n`;
                    if (profile.profession) text += `**Profession**: ${profile.profession}\n`;
                    this.addMessage('system', text);
                } else {
                    this.addMessage('system', 'No profile data available.');
                }
                break;
            case '/tools':
                const tools = this.api.getAvailableTools();
                const toolsList = tools.map((t: any) => `- **${t.name}**: ${t.description}`).join('\n');
                this.addMessage('system', `## Available Tools\n\n${toolsList}`);
                break;
            case '/open':
                if (!argStr) {
                    this.addMessage('system', 'Usage: /open <filename>');
                    return;
                }
                await this.handleOpenFile(argStr);
                break;
            default:
                this.addMessage('system', `Unknown command: ${cmd}`);
        }
    }

    private async handleOpenFile(searchTerm: string) {
        const files = this.app.vault.getFiles();
        const matches = files.filter(f =>
            f.path.toLowerCase().includes(searchTerm.toLowerCase()) ||
            f.basename.toLowerCase().includes(searchTerm.toLowerCase())
        );

        if (matches.length === 0) {
            this.addMessage('system', `No files found matching "${searchTerm}"`);
        } else if (matches.length === 1) {
            await this.app.workspace.getLeaf(false).openFile(matches[0]);
            this.addMessage('system', `Opened [[${matches[0].path}]]`);
        } else {
            const list = matches.slice(0, 10).map(f => `- [[${f.path}]]`).join('\n');
            this.addMessage('system', `Found multiple files:\n${list}`);
        }
    }

    private addMessage(role: 'user' | 'ai' | 'system', content: string) {
        const msg: ChatMessage = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            role,
            content,
            timestamp: Date.now()
        };
        this.messages.push(msg);
        if (this.onMessageAdded) {
            this.onMessageAdded(msg);
        }
    }

    private setResponding(status: boolean) {
        // this.isResponding = status;
        if (this.onStatusChanged) {
            this.onStatusChanged(status);
        }
    }

    private handleError(error: any) {
        logger.error('Chat error', error, 'ChatController');
        let msg = 'Unknown error occurred.';
        if (error.message) msg = error.message;
        this.addMessage('system', `Error: ${msg}`);
    }
}
