export interface UserProfile {
    name?: string;
    profession?: string;
    expertise: string[];
    preferences: {
        language: string;
        responseStyle: string;
        topics: string[];
    };
    workflows: {
        name: string;
        description: string;
        frequency: number;
    }[];
    context: {
        currentProjects: string[];
        goals: string[];
        challenges: string[];
    };
    metadata: {
        createdAt: number;
        updatedAt: number;
        totalInteractions: number;
        lastProfileUpdate: number;
    };
}

export interface SessionSummary {
    timestamp: number;
    messageCount: number;
    summary: string;
}

export interface ChatMessage {
    role: 'user' | 'model';
    content: string;
    timestamp: number;
}

export interface MemoryContext {
    userProfile: string;
    recentSessions: string;
}

export const DEFAULT_USER_PROFILE: UserProfile = {
    name: '',
    profession: '',
    expertise: [],
    preferences: {
        language: 'zh-CN',
        responseStyle: 'balanced',
        topics: [],
    },
    workflows: [],
    context: {
        currentProjects: [],
        goals: [],
        challenges: [],
    },
    metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        totalInteractions: 0,
        lastProfileUpdate: Date.now(),
    },
};
