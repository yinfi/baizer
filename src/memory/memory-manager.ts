import { App } from 'obsidian';
import { GenerativeModel, ChatSession } from '@google/generative-ai';
import { UserProfile, SessionSummary, ChatMessage, DEFAULT_USER_PROFILE } from './types';

export class MemoryManager {
    private chatSession: ChatSession | null = null;
    private userProfile: UserProfile;
    private sessionSummaries: SessionSummary[] = [];
    public chatHistory: ChatMessage[] = [];
    private currentSessionMessages: number = 0;
    private lastProfileUpdateTime: number = 0;

    private readonly MEMORY_DIR = '.obsidian/gemini-memory';
    private readonly PROFILE_FILE = 'user-profile.json';
    private readonly SUMMARY_FILE = 'session-summaries.json';
    private readonly HISTORY_FILE = 'chat-history.json';
    private readonly PROFILE_UPDATE_INTERVAL = 5; // Update every 5 messages
    private readonly PROFILE_UPDATE_MIN_TIME = 60 * 1000; // Minimum 1 minute between updates

    constructor(
        private app: App,
        private model: GenerativeModel
    ) {
        this.userProfile = { ...DEFAULT_USER_PROFILE };
        this.loadProfile();
        this.loadSummaries();
        this.loadChatHistory();
    }

    // ==================== Session Management ====================

    getOrCreateSession(): ChatSession {
        if (!this.chatSession) {
            this.chatSession = this.model.startChat();
            this.currentSessionMessages = 0;
        }
        return this.chatSession;
    }

    async clearSession() {
        if (this.chatSession && this.currentSessionMessages > 0) {
            await this.endSession();
        }
        this.chatSession = null;
        this.currentSessionMessages = 0;
    }

    // ==================== Context Building ====================

    buildContext(): string {
        const profileContext = this.formatProfileForContext();
        const summaryContext = this.formatSummariesForContext();

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

        // 最近 3 次会话
        const recent = this.sessionSummaries.slice(-3);
        return recent.map((s, i) =>
            `Session ${i + 1}: ${s.summary}`
        ).join('\n');
    }

    // ==================== Message Recording ====================

    async recordMessage(role: 'user' | 'model', content: string) {
        this.currentSessionMessages++;
        this.userProfile.metadata.totalInteractions++;

        // Record to history
        this.chatHistory.push({
            role,
            content,
            timestamp: Date.now()
        });
        await this.saveChatHistory();

        // 自动画像更新
        if (role === 'user') {
            const timeSinceLastUpdate = Date.now() - this.lastProfileUpdateTime;
            const shouldUpdateByTurns = this.currentSessionMessages % this.PROFILE_UPDATE_INTERVAL === 0;
            const shouldUpdateByTime = timeSinceLastUpdate >= this.PROFILE_UPDATE_MIN_TIME;

            // More aggressive update for new users
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

    // ==================== Profile Management ====================

    // 手动触发画像提取（从最近的对话中学习）
    async learnFromRecentMessages(recentMessages: string[]) {
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
            const extractionPrompt = `分析以下用户消息，提取可能的用户信息。只返回 JSON 格式，不要其他内容：

用户消息: "${userMessage}"

提取以下信息（如果消息中包含）：
{
  "profession": "职业（如果提到）",
  "expertise": ["专业领域数组"],
  "currentProjects": ["当前项目"],
  "goals": ["目标"],
  "preferences": {
    "responseStyle": "concise/detailed（如果用户表达了偏好）"
  }
}

如果没有提取到任何信息，返回 {}`;

            const result = await this.model.generateContent(extractionPrompt);
            const responseText = result.response.text().trim();

            // 提取 JSON
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const extracted = JSON.parse(jsonMatch[0]);
                this.mergeProfile(extracted);
                await this.saveProfile();
                return extracted; // 返回提取的信息
            }
            return null;
        } catch (e) {
            console.error('Profile extraction failed:', e);
            throw e;
        }
    }

    private mergeProfile(extracted: any) {
        if (!extracted || Object.keys(extracted).length === 0) return;

        // 合并基本信息
        if (extracted.profession) {
            this.userProfile.profession = extracted.profession;
        }

        // 合并专业领域（去重）
        if (extracted.expertise && Array.isArray(extracted.expertise)) {
            const newExpertise = extracted.expertise.filter(
                (e: string) => !this.userProfile.expertise.includes(e)
            );
            this.userProfile.expertise.push(...newExpertise);
        }

        // 合并当前项目
        if (extracted.currentProjects && Array.isArray(extracted.currentProjects)) {
            const newProjects = extracted.currentProjects.filter(
                (p: string) => !this.userProfile.context.currentProjects.includes(p)
            );
            this.userProfile.context.currentProjects.push(...newProjects);
        }

        // 合并目标
        if (extracted.goals && Array.isArray(extracted.goals)) {
            const newGoals = extracted.goals.filter(
                (g: string) => !this.userProfile.context.goals.includes(g)
            );
            this.userProfile.context.goals.push(...newGoals);
        }

        // 更新偏好
        if (extracted.preferences) {
            if (extracted.preferences.responseStyle) {
                this.userProfile.preferences.responseStyle = extracted.preferences.responseStyle;
            }
        }

        // 更新元数据
        this.userProfile.metadata.updatedAt = Date.now();
        this.userProfile.metadata.lastProfileUpdate = Date.now();
    }

    getProfile(): UserProfile {
        return { ...this.userProfile };
    }

    async updateProfile(updates: Partial<UserProfile>) {
        this.userProfile = { ...this.userProfile, ...updates };
        this.userProfile.metadata.updatedAt = Date.now();
        await this.saveProfile();
    }

    // ==================== Session Summary ====================

    private async endSession() {
        if (this.currentSessionMessages === 0) return;

        try {
            const summary = await this.generateSessionSummary();
            this.sessionSummaries.push(summary);

            // 只保留最近 10 次
            if (this.sessionSummaries.length > 10) {
                this.sessionSummaries = this.sessionSummaries.slice(-10);
            }

            await this.saveSummaries();
        } catch (e) {
            console.error('Failed to generate session summary:', e);
        }
    }

    private async generateSessionSummary(): Promise<SessionSummary> {
        const summaryPrompt = `总结这次对话的关键内容（50字以内，一句话）`;

        try {
            const result = await this.model.generateContent(summaryPrompt);
            const summary = result.response.text().trim();

            return {
                timestamp: Date.now(),
                messageCount: this.currentSessionMessages,
                summary: summary
            };
        } catch (e) {
            return {
                timestamp: Date.now(),
                messageCount: this.currentSessionMessages,
                summary: `对话包含 ${this.currentSessionMessages} 条消息`
            };
        }
    }

    // ==================== Persistence ====================

    async save() {
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
        this.chatHistory = [];
        await this.saveChatHistory();
    }
}
