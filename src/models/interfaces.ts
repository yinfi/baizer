
export interface ModelConfig {
    apiKey: string;
    baseUrl?: string;
    modelName: string;
    systemPrompt?: string;
    contextWindow?: number;
}

export interface ChatMessage {
    role: 'user' | 'model' | 'system';
    content: string;
}

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: any;
}

export interface ToolCall {
    name: string;
    args: any;
}

export interface ToolResult {
    name: string;
    response: any;
}

export interface GenerationResult {
    text: string;
    functionCalls?: ToolCall[];
}

export interface IChatSession {
    sendMessage(text: string | ToolResult[]): Promise<GenerationResult>;
    getHistory(): Promise<ChatMessage[]>;
    clearHistory(): Promise<void>;
}

export interface IModelProvider {
    id: string;
    name: string;

    configure(config: ModelConfig): void;
    checkAvailability(): Promise<boolean>;

    generateContent(prompt: string): Promise<GenerationResult>;
    startChat(tools?: ToolDefinition[]): IChatSession;
}
