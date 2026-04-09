import { logger } from '../utils/logger';

export interface McpTool {
    name: string;
    description?: string;
    inputSchema: any;
}

export class StdioMcpClient {
    private process: any;
    private requestId = 0;
    private pendingRequests = new Map<number, { resolve: Function, reject: Function }>();
    private buffer = '';
    private readonly requestTimeoutMs = 30000;
    private readonly maxBufferChars = 1_000_000; // 1MB-ish safety cap

    constructor(private command: string, private args: string[]) { }

    async connect() {
        try {
            // Dynamic require to avoid bundling issues if not in Node
            const cp = require('child_process');
            this.process = cp.spawn(this.command, this.args, {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            this.process.stdout.on('data', (data: Buffer) => {
                this.handleData(data);
            });

            this.process.stderr.on('data', (data: Buffer) => {
                logger.warn(`MCP Stderr [${this.command}]: ${data.toString()}`, 'McpClient');
            });

            this.process.on('error', (err: any) => {
                logger.error(`MCP Process Error [${this.command}]`, err, 'McpClient');
                this.rejectAllPending(err);
            });

            this.process.on('close', (code: number) => {
                logger.info(`MCP Process exited with code ${code}`, 'McpClient');
                this.rejectAllPending(new Error(`MCP process closed with code ${code}`));
            });

            // Initialize handshake
            const initResult = await this.sendRequest('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'obsidian-cli', version: '1.0.0' }
            });

            logger.info(`MCP Initialized: ${JSON.stringify(initResult)}`, 'McpClient');

            await this.sendNotification('notifications/initialized');

        } catch (e) {
            logger.error(`Failed to connect to MCP server: ${this.command}`, e, 'McpClient');
            // Ensure we don't leave an orphan process on failed handshake.
            try {
                this.process?.kill();
            } catch (_) { /* noop */ }
            throw e;
        }
    }

    async listTools(): Promise<McpTool[]> {
        const result = await this.sendRequest('tools/list', {});
        return result.tools || [];
    }

    async callTool(name: string, args: any): Promise<any> {
        const result = await this.sendRequest('tools/call', {
            name,
            arguments: args
        });
        return result.content;
    }

    private handleData(data: Buffer) {
        this.buffer += data.toString();

        if (this.buffer.length > this.maxBufferChars) {
            logger.warn(`MCP buffer exceeded ${this.maxBufferChars} chars, resetting`, 'McpClient');
            this.buffer = '';
        }

        const lines = this.buffer.split('\n');
        // Keep the last chunk if it's incomplete
        this.buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const message = JSON.parse(line);
                if (message.id !== undefined) {
                    const pending = this.pendingRequests.get(message.id);
                    if (pending) {
                        if (message.error) {
                            pending.reject(message.error);
                        } else {
                            pending.resolve(message.result);
                        }
                        this.pendingRequests.delete(message.id);
                    }
                } else {
                    // Notification or Request from server
                    // For now, ignore
                }
            } catch (e) {
                logger.error('Failed to parse MCP message', e, 'McpClient');
            }
        }
    }

    private sendRequest(method: string, params: any = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = this.requestId++;
            const timeoutId = setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`MCP request timed out: ${method}`));
                }
            }, this.requestTimeoutMs);

            this.pendingRequests.set(id, {
                resolve: (value: any) => {
                    clearTimeout(timeoutId);
                    resolve(value);
                },
                reject: (err: any) => {
                    clearTimeout(timeoutId);
                    reject(err);
                }
            });

            const message = {
                jsonrpc: '2.0',
                id,
                method,
                params
            };

            try {
                this.process.stdin.write(JSON.stringify(message) + '\n');
            } catch (e) {
                clearTimeout(timeoutId);
                this.pendingRequests.delete(id);
                reject(e);
            }
        });
    }

    private async sendNotification(method: string, params: any = {}) {
        const message = {
            jsonrpc: '2.0',
            method,
            params
        };
        this.process.stdin.write(JSON.stringify(message) + '\n');
    }

    disconnect() {
        if (this.process) {
            this.process.kill();
        }
    }

    private rejectAllPending(err: any) {
        for (const [id, pending] of this.pendingRequests) {
            try {
                pending.reject(err);
            } catch (_) { /* noop */ }
            this.pendingRequests.delete(id);
        }
    }
}
