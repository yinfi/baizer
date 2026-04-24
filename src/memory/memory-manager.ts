import { App } from 'obsidian';
import { IModelProvider, IChatSession, ToolDefinition } from '../models/interfaces';
import { UserProfile, SessionSummary, ChatMessage, DEFAULT_USER_PROFILE } from './types';
import { MEMORY_DIR } from '../mcp/types';
import { budgetTextBlock } from '../services/context-budget';

export class MemoryManager {
    private chatSession: IChatSession | null = null;
    private userProfile: UserProfile;
    private sessionSummaries: SessionSummary[] = [];
    public chatHistory: ChatMessage[] = [];
    private currentSessionTranscript: ChatMessage[] = [];
    private currentSessionMessages: number = 0;
    private lastProfileUpdateTime: number = 0;
    private initPromise: Promise<void>;

    private readonly MAX_MEMORY_CHAT_HISTORY = 100;

    private readonly MEMORY_DIR = MEMORY_DIR;
    private readonly PROFILE_FILE = 'user-profile.json';
    private readonly SUMMARY_FILE = 'session-summaries.json';
    private readonly HISTORY_FILE = 'chat-history.json';
    private readonly PROFILE_UPDATE_INTERVAL = 5;
    private readonly PROFILE_UPDATE_MIN_TIME = 60 * 1000;

    constructor(
        private app: App,
        private model: IModelProvider
    ) {
        this.userProfile = { ...DEFAULT_USER_PROFILE };
        this.initPromise = this.initialize();
    }

    private async initialize() {
        await this.loadProfile();
        await this.loadSummaries();
        await this.loadChatHistory();
    }

    async ready(): Promise<void> {
        await this.initPromise;
    }

    getOrCreateSession(tools?: ToolDefinition[]): IChatSession {
        if (!this.chatSession) {
            this.chatSession = this.model.startChat(tools);
            this.currentSessionMessages = 0;
            this.currentSessionTranscript = [];
        }
        return this.chatSession;
    }

    async clearSession() {
        await this.ready();
        if (this.currentSessionMessages > 0) {
            await this.endSession();
        }
        this.chatSession = null;
        this.currentSessionMessages = 0;
        this.currentSessionTranscript = [];
    }

    buildContext(): string {
        const profileContext = budgetTextBlock(this.formatProfileForContext(), 2000);
        const summaryContext = budgetTextBlock(this.formatSummariesForContext(), 2000);

        return `[User Profile]\n${profileContext}\n\n[Recent Context]\n${summaryContext}`;
    }

    private formatProfileForContext(): string {
        const p = this.userProfile;
        const parts: string[] = [];

        if (p.name) parts.push(`Name: ${p.name}`);
        if (p.profession) parts.push(`Profession: ${p.profession}`);
        if (p.expertise.length > 0) parts.push(`Expertise: ${p.expertise.join(', ')}`);

        if (p.preferences.responseStyle) {
            parts.push(`Preferred Style: ${p.preferences.responseStyle}`);
        }

        if (p.context.currentProjects.length > 0) {
            parts.push(`Current Projects: ${p.context.currentProjects.join(', ')}`);
        }

        if (p.context.goals.length > 0) {
            parts.push(`Goals: ${p.context.goals.join(', ')}`);
        }

        return parts.length > 0 ? parts.join('\n') : 'No profile information yet.';
    }

    private formatSummariesForContext(): string {
        if (this.sessionSummaries.length === 0) {
            return 'No previous sessions.';
        }

        const recent = this.sessionSummaries.slice(-3);
        return recent.map((s, i) =>
            `Session ${i + 1}: ${s.summary}`
        ).join('\n');
    }

    async recordMessage(role: 'user' | 'model', content: string) {
        await this.ready();
        this.currentSessionMessages++;
        this.userProfile.metadata.totalInteractions++;

        const message: ChatMessage = {
            role,
            content,
            timestamp: Date.now()
        };

        this.chatHistory.push(message);
        this.currentSessionTranscript.push(message);

        this.cleanupOldChatHistory();

        await this.saveChatHistory();

        if (role === 'user') {
            const timeSinceLastUpdate = Date.now() - this.lastProfileUpdateTime;
            const shouldUpdateByTurns = this.currentSessionMessages % this.PROFILE_UPDATE_INTERVAL === 0;
            const shouldUpdateByTime = timeSinceLastUpdate >= this.PROFILE_UPDATE_MIN_TIME;
            const isNewUser = this.userProfile.metadata.totalInteractions < 20;

            if (isNewUser && this.currentSessionMessages % 2 === 0) {
                try {
                    await this.updateProfileFromConversation(content);
                    this.lastProfileUpdateTime = Date.now();
                } catch (e) {
                    console.error('Auto profile update (new user) failed:', e);
                }
            } else if (shouldUpdateByTurns || (shouldUpdateByTime && this.currentSessionMessages > 0)) {
                try {
                    await this.updateProfileFromConversation(content);
                    this.lastProfileUpdateTime = Date.now();
                } catch (e) {
                    console.error('Auto profile update failed:', e);
                }
            }
        }
    }

    private cleanupOldChatHistory() {
        if (this.chatHistory.length > this.MAX_MEMORY_CHAT_HISTORY) {
            const excessCount = this.chatHistory.length - this.MAX_MEMORY_CHAT_HISTORY;
            this.chatHistory = this.chatHistory.slice(-this.MAX_MEMORY_CHAT_HISTORY);

            console.log(`[MemoryManager] Cleaned up ${excessCount} old messages from memory. Keeping ${this.MAX_MEMORY_CHAT_HISTORY} most recent messages.`);
        }
    }

    async learnFromRecentMessages(recentMessages: string[]) {
        await this.ready();
        try {
            const combinedMessage = recentMessages.join('\n');
            await this.updateProfileFromConversation(combinedMessage);
        } catch (e) {
            console.error('Manual profile extraction failed:', e);
            throw e;
        }
    }

    private async updateProfileFromConversation(userMessage: string) {
        try {
            const extractionPrompt = `Analyze the following user message and extract profile information as JSON only.

User message: "${userMessage}"

Return:
{
  "profession": "profession if present",
  "expertise": ["areas of expertise"],
  "currentProjects": ["current projects"],
  "goals": ["goals"],
  "preferences": {
    "responseStyle": "concise or detailed if stated"
  }
}

If nothing is present, return {}`;

            const result = await this.model.generateContent(extractionPrompt);
            const responseText = result.text.trim();

            const braceStart = responseText.indexOf('{');
            if (braceStart !== -1) {
                let depth = 0;
                let inStr = false;
                let esc = false;
                let end = -1;

                for (let i = braceStart; i < responseText.length; i++) {
                    const c = responseText[i];
                    if (esc) {
                        esc = false;
                        continue;
                    }
                    if (c === '\\' && inStr) {
                        esc = true;
                        continue;
                    }
                    if (c === '"') {
                        inStr = !inStr;
                        continue;
                    }
                    if (inStr) continue;
                    if (c === '{') depth++;
                    else if (c === '}') {
                        depth--;
                        if (depth === 0) {
                            end = i;
                            break;
                        }
                    }
                }

                if (end !== -1) {
                    const extracted = JSON.parse(responseText.substring(braceStart, end + 1));
                    this.mergeProfile(extracted);
                    await this.saveProfile();
                    return extracted;
                }
            }
            return null;
        } catch (e) {
            console.error('Profile extraction failed:', e);
            throw e;
        }
    }

    private mergeProfile(extracted: any) {
        if (!extracted || Object.keys(extracted).length === 0) return;

        if (extracted.profession) {
            this.userProfile.profession = extracted.profession;
        }

        if (extracted.expertise && Array.isArray(extracted.expertise)) {
            const newExpertise = extracted.expertise.filter(
                (e: string) => !this.userProfile.expertise.includes(e)
            );
            this.userProfile.expertise.push(...newExpertise);
        }

        if (extracted.currentProjects && Array.isArray(extracted.currentProjects)) {
            const newProjects = extracted.currentProjects.filter(
                (p: string) => !this.userProfile.context.currentProjects.includes(p)
            );
            this.userProfile.context.currentProjects.push(...newProjects);
        }

        if (extracted.goals && Array.isArray(extracted.goals)) {
            const newGoals = extracted.goals.filter(
                (g: string) => !this.userProfile.context.goals.includes(g)
            );
            this.userProfile.context.goals.push(...newGoals);
        }

        if (extracted.preferences?.responseStyle) {
            this.userProfile.preferences.responseStyle = extracted.preferences.responseStyle;
        }

        this.userProfile.metadata.updatedAt = Date.now();
        this.userProfile.metadata.lastProfileUpdate = Date.now();
    }

    getProfile(): UserProfile {
        return { ...this.userProfile };
    }

    async updateProfile(updates: Partial<UserProfile>) {
        await this.ready();
        this.userProfile = { ...this.userProfile, ...updates };
        this.userProfile.metadata.updatedAt = Date.now();
        await this.saveProfile();
    }

    private async endSession() {
        if (this.currentSessionMessages === 0) return;

        try {
            const summary = await this.generateSessionSummary();
            this.sessionSummaries.push(summary);

            if (this.sessionSummaries.length > 10) {
                this.sessionSummaries = this.sessionSummaries.slice(-10);
            }

            await this.saveSummaries();
        } catch (e) {
            console.error('Failed to generate session summary:', e);
        }
    }

    private async generateSessionSummary(): Promise<SessionSummary> {
        const transcript = this.currentSessionTranscript
            .map(message => `${message.role}: ${message.content}`)
            .join('\n')
            .slice(0, 4000);

        const summaryPrompt = `Please summarize the key points from the following conversation in one sentence under 50 words.

Conversation:
${transcript}`;

        try {
            const result = await this.model.generateContent(summaryPrompt);
            const summary = result.text.trim();

            return {
                timestamp: Date.now(),
                messageCount: this.currentSessionMessages,
                summary
            };
        } catch (_) {
            return {
                timestamp: Date.now(),
                messageCount: this.currentSessionMessages,
                summary: `Conversation contained ${this.currentSessionMessages} messages.`
            };
        }
    }

    async save() {
        await this.ready();
        await this.saveProfile();
        await this.saveSummaries();
        await this.saveChatHistory();
    }

    private async ensureMemoryDir() {
        const adapter = this.app.vault.adapter;
        const dirExists = await adapter.exists(this.MEMORY_DIR);
        if (!dirExists) {
            await adapter.mkdir(this.MEMORY_DIR);
        }
    }

    private async loadProfile() {
        try {
            const path = `${this.MEMORY_DIR}/${this.PROFILE_FILE}`;
            const exists = await this.app.vault.adapter.exists(path);

            if (exists) {
                const content = await this.app.vault.adapter.read(path);
                this.userProfile = JSON.parse(content);
            }
        } catch (e) {
            console.error('Failed to load profile:', e);
            this.userProfile = { ...DEFAULT_USER_PROFILE };
        }
    }

    private async saveProfile() {
        try {
            await this.ensureMemoryDir();
            const path = `${this.MEMORY_DIR}/${this.PROFILE_FILE}`;
            await this.app.vault.adapter.write(
                path,
                JSON.stringify(this.userProfile, null, 2)
            );
        } catch (e) {
            console.error('Failed to save profile:', e);
        }
    }

    private async loadSummaries() {
        try {
            const path = `${this.MEMORY_DIR}/${this.SUMMARY_FILE}`;
            const exists = await this.app.vault.adapter.exists(path);

            if (exists) {
                const content = await this.app.vault.adapter.read(path);
                this.sessionSummaries = JSON.parse(content);
            }
        } catch (e) {
            console.error('Failed to load summaries:', e);
            this.sessionSummaries = [];
        }
    }

    private async saveSummaries() {
        try {
            await this.ensureMemoryDir();
            const path = `${this.MEMORY_DIR}/${this.SUMMARY_FILE}`;
            await this.app.vault.adapter.write(
                path,
                JSON.stringify(this.sessionSummaries, null, 2)
            );
        } catch (e) {
            console.error('Failed to save summaries:', e);
        }
    }

    private async loadChatHistory() {
        try {
            const path = `${this.MEMORY_DIR}/${this.HISTORY_FILE}`;
            const exists = await this.app.vault.adapter.exists(path);

            if (exists) {
                const content = await this.app.vault.adapter.read(path);
                this.chatHistory = JSON.parse(content);
            }
        } catch (e) {
            console.error('Failed to load chat history:', e);
            this.chatHistory = [];
        }
    }

    private async saveChatHistory() {
        try {
            await this.ensureMemoryDir();
            const path = `${this.MEMORY_DIR}/${this.HISTORY_FILE}`;
            await this.app.vault.adapter.write(
                path,
                JSON.stringify(this.chatHistory, null, 2)
            );
        } catch (e) {
            console.error('Failed to save chat history:', e);
        }
    }

    async clearChatHistory() {
        await this.ready();
        this.chatHistory = [];
        await this.saveChatHistory();
    }
}
