import { GenerativeModel, GoogleGenerativeAI } from '@google/generative-ai';
import { requestUrl } from 'obsidian';
import {
  GenerationOptions,
  GenerationResult,
  IModelProvider,
  ModelConfig,
  ModelOption,
} from './interfaces';
import { logger } from '../utils/logger';
import { ProviderCapabilities } from '../runtime/provider-capabilities';

export class GeminiProvider implements IModelProvider {
    id = 'gemini';
    name = 'Google Gemini';

    private genAI: GoogleGenerativeAI;
    private model: GenerativeModel;
    private config: ModelConfig;

    getCapabilities(): ProviderCapabilities {
        return {
            supportsThinking: true,
            supportsModelListing: true,
            supportsImageInput: true,
            supportsToolCalling: true,
            supportsCustomBaseUrl: false,
        };
    }

    configure(config: ModelConfig) {
        this.config = config;
        this.genAI = new GoogleGenerativeAI(config.apiKey);
        this.model = this.genAI.getGenerativeModel({
            model: config.modelName,
            systemInstruction: config.systemPrompt
        });
    }

    async checkAvailability(): Promise<boolean> {
        try {
            const result = await this.model.generateContent("Hello");
            return !!result.response.text();
        } catch (e) {
            logger.error('Gemini availability check failed', e, 'GeminiProvider');
            return false;
        }
    }

    async listModels(): Promise<ModelOption[]> {
        if (!this.config?.apiKey) {
            throw new Error('Gemini API Key not configured');
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(this.config.apiKey)}`;
        const response = await requestUrl({ url, method: 'GET' });

        if (response.status !== 200) {
            throw new Error(`Gemini models API error: ${response.status}`);
        }

        const data = JSON.parse(response.text || '{}');
        const models = Array.isArray(data?.models) ? data.models : [];

        const options: ModelOption[] = models
            .filter((model: any) => {
                const methods = Array.isArray(model?.supportedGenerationMethods)
                    ? model.supportedGenerationMethods
                    : [];
                const name = typeof model?.name === 'string' ? model.name : '';
                return name.startsWith('models/') && methods.includes('generateContent');
            })
            .map((model: any) => {
                const value = String(model.name).replace(/^models\//, '');
                const displayName = typeof model?.displayName === 'string' && model.displayName.trim().length > 0
                    ? model.displayName.trim()
                    : value;
                const label = displayName === value ? value : `${displayName} (${value})`;
                return { value, label };
            })
            .sort((a, b) => a.value.localeCompare(b.value));

        const deduped = new Map<string, ModelOption>();
        options.forEach(option => {
            if (!deduped.has(option.value)) {
                deduped.set(option.value, option);
            }
        });

        return Array.from(deduped.values());
    }

    async generateContent(prompt: string, systemPrompt?: string, options?: GenerationOptions): Promise<GenerationResult> {
        const generationConfig = {
            ...(typeof options?.temperature === 'number' ? { temperature: options.temperature } : {}),
            ...(typeof options?.maxTokens === 'number' ? { maxOutputTokens: options.maxTokens } : {}),
        };
        const hasGenerationConfig = Object.keys(generationConfig).length > 0;
        const model = systemPrompt || hasGenerationConfig
            ? this.genAI.getGenerativeModel({
                model: this.config.modelName,
                ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
                ...(hasGenerationConfig ? { generationConfig } : {}),
            })
            : this.model;
        const result = await withTimeout(
            model.generateContent(prompt),
            options?.timeoutMs,
            'Gemini generation timed out',
        );
        return {
            text: result.response.text()
        };
    }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, message: string): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) return promise;

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
