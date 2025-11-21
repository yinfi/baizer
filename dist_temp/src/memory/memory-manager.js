"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryManager = void 0;
const types_1 = require("./types");
class MemoryManager {
    app;
    model;
    chatSession = null;
    userProfile;
    sessionSummaries = [];
    chatHistory = [];
    currentSessionMessages = 0;
    lastProfileUpdateTime = 0;
    MEMORY_DIR = '.obsidian/gemini-memory';
    PROFILE_FILE = 'user-profile.json';
    SUMMARY_FILE = 'session-summaries.json';
    HISTORY_FILE = 'chat-history.json';
    PROFILE_UPDATE_INTERVAL = 20;
    PROFILE_UPDATE_MIN_TIME = 10 * 60 * 1000;
    constructor(app, model) {
        this.app = app;
        this.model = model;
        this.userProfile = { ...types_1.DEFAULT_USER_PROFILE };
        this.loadProfile();
        this.loadSummaries();
        this.loadChatHistory();
    }
    // ==================== Session Management ====================
    getOrCreateSession() {
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
    buildContext() {
        const profileContext = this.formatProfileForContext();
        const summaryContext = this.formatSummariesForContext();
        return `[User Profile]\n${profileContext}\n\n[Recent Context]\n${summaryContext}`;
    }
    formatProfileForContext() {
        const p = this.userProfile;
        const parts = [];
        if (p.name)
            parts.push(`Name: ${p.name}`);
        if (p.profession)
            parts.push(`Profession: ${p.profession}`);
        if (p.expertise.length > 0)
            parts.push(`Expertise: ${p.expertise.join(', ')}`);
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
    formatSummariesForContext() {
        if (this.sessionSummaries.length === 0) {
            return 'No previous sessions.';
        }
        // 最近 3 次会话
        const recent = this.sessionSummaries.slice(-3);
        return recent.map((s, i) => `Session ${i + 1}: ${s.summary}`).join('\n');
    }
    // ==================== Message Recording ====================
    async recordMessage(role, content) {
        this.currentSessionMessages++;
        this.userProfile.metadata.totalInteractions++;
        // Record to history
        this.chatHistory.push({
            role,
            content,
            timestamp: Date.now()
        });
        await this.saveChatHistory();
        // 自动画像更新 - 需同时满足两个条件：
        // 1. 至少 20 轮对话
        // 2. 距离上次更新至少 10 分钟
        if (role === 'user') {
            const timeSinceLastUpdate = Date.now() - this.lastProfileUpdateTime;
            const shouldUpdateByTurns = this.currentSessionMessages % this.PROFILE_UPDATE_INTERVAL === 0;
            const shouldUpdateByTime = timeSinceLastUpdate >= this.PROFILE_UPDATE_MIN_TIME;
            if (shouldUpdateByTurns && shouldUpdateByTime) {
                try {
                    await this.updateProfileFromConversation(content);
                    this.lastProfileUpdateTime = Date.now();
                }
                catch (e) {
                    console.error('Auto profile update failed:', e);
                    // 失败不影响正常对话
                }
            }
        }
    }
    // ==================== Profile Management ====================
    // 手动触发画像提取（从最近的对话中学习）
    async learnFromRecentMessages(recentMessages) {
        try {
            const combinedMessage = recentMessages.join('\n');
            await this.updateProfileFromConversation(combinedMessage);
        }
        catch (e) {
            console.error('Manual profile extraction failed:', e);
            throw e;
        }
    }
    async updateProfileFromConversation(userMessage) {
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
        }
        catch (e) {
            console.error('Profile extraction failed:', e);
            throw e;
        }
    }
    mergeProfile(extracted) {
        if (!extracted || Object.keys(extracted).length === 0)
            return;
        // 合并基本信息
        if (extracted.profession) {
            this.userProfile.profession = extracted.profession;
        }
        // 合并专业领域（去重）
        if (extracted.expertise && Array.isArray(extracted.expertise)) {
            const newExpertise = extracted.expertise.filter((e) => !this.userProfile.expertise.includes(e));
            this.userProfile.expertise.push(...newExpertise);
        }
        // 合并当前项目
        if (extracted.currentProjects && Array.isArray(extracted.currentProjects)) {
            const newProjects = extracted.currentProjects.filter((p) => !this.userProfile.context.currentProjects.includes(p));
            this.userProfile.context.currentProjects.push(...newProjects);
        }
        // 合并目标
        if (extracted.goals && Array.isArray(extracted.goals)) {
            const newGoals = extracted.goals.filter((g) => !this.userProfile.context.goals.includes(g));
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
    getProfile() {
        return { ...this.userProfile };
    }
    async updateProfile(updates) {
        this.userProfile = { ...this.userProfile, ...updates };
        this.userProfile.metadata.updatedAt = Date.now();
        await this.saveProfile();
    }
    // ==================== Session Summary ====================
    async endSession() {
        if (this.currentSessionMessages === 0)
            return;
        try {
            const summary = await this.generateSessionSummary();
            this.sessionSummaries.push(summary);
            // 只保留最近 10 次
            if (this.sessionSummaries.length > 10) {
                this.sessionSummaries = this.sessionSummaries.slice(-10);
            }
            await this.saveSummaries();
        }
        catch (e) {
            console.error('Failed to generate session summary:', e);
        }
    }
    async generateSessionSummary() {
        const summaryPrompt = `总结这次对话的关键内容（50字以内，一句话）`;
        try {
            const result = await this.model.generateContent(summaryPrompt);
            const summary = result.response.text().trim();
            return {
                timestamp: Date.now(),
                messageCount: this.currentSessionMessages,
                summary: summary
            };
        }
        catch (e) {
            return {
                timestamp: Date.now(),
                messageCount: this.currentSessionMessages,
                summary: `对话包含 ${this.currentSessionMessages} 条消息`
            };
        }
    }
    // ==================== Persistence ====================
    async ensureMemoryDir() {
        const adapter = this.app.vault.adapter;
        const dirExists = await adapter.exists(this.MEMORY_DIR);
        if (!dirExists) {
            await adapter.mkdir(this.MEMORY_DIR);
        }
    }
    async loadProfile() {
        try {
            const path = `${this.MEMORY_DIR}/${this.PROFILE_FILE}`;
            const exists = await this.app.vault.adapter.exists(path);
            if (exists) {
                const content = await this.app.vault.adapter.read(path);
                this.userProfile = JSON.parse(content);
            }
        }
        catch (e) {
            console.error('Failed to load profile:', e);
            this.userProfile = { ...types_1.DEFAULT_USER_PROFILE };
        }
    }
    async saveProfile() {
        try {
            await this.ensureMemoryDir();
            const path = `${this.MEMORY_DIR}/${this.PROFILE_FILE}`;
            await this.app.vault.adapter.write(path, JSON.stringify(this.userProfile, null, 2));
        }
        catch (e) {
            console.error('Failed to save profile:', e);
        }
    }
    async loadSummaries() {
        try {
            const path = `${this.MEMORY_DIR}/${this.SUMMARY_FILE}`;
            const exists = await this.app.vault.adapter.exists(path);
            if (exists) {
                const content = await this.app.vault.adapter.read(path);
                this.sessionSummaries = JSON.parse(content);
            }
        }
        catch (e) {
            console.error('Failed to load summaries:', e);
            this.sessionSummaries = [];
        }
    }
    async saveSummaries() {
        try {
            await this.ensureMemoryDir();
            const path = `${this.MEMORY_DIR}/${this.SUMMARY_FILE}`;
            await this.app.vault.adapter.write(path, JSON.stringify(this.sessionSummaries, null, 2));
        }
        catch (e) {
            console.error('Failed to save summaries:', e);
        }
    }
    async loadChatHistory() {
        try {
            const path = `${this.MEMORY_DIR}/${this.HISTORY_FILE}`;
            const exists = await this.app.vault.adapter.exists(path);
            if (exists) {
                const content = await this.app.vault.adapter.read(path);
                this.chatHistory = JSON.parse(content);
            }
        }
        catch (e) {
            console.error('Failed to load chat history:', e);
            this.chatHistory = [];
        }
    }
    async saveChatHistory() {
        try {
            await this.ensureMemoryDir();
            const path = `${this.MEMORY_DIR}/${this.HISTORY_FILE}`;
            await this.app.vault.adapter.write(path, JSON.stringify(this.chatHistory, null, 2));
        }
        catch (e) {
            console.error('Failed to save chat history:', e);
        }
    }
    async clearChatHistory() {
        this.chatHistory = [];
        await this.saveChatHistory();
    }
}
exports.MemoryManager = MemoryManager;
