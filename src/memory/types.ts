// Memory System Type Definitions

export interface UserProfile {
    // 基本信息
    name?: string;
    profession?: string;
    expertise: string[];

    // 喜好与习惯
    preferences: {
        language: string;
        responseStyle: string;  // 'concise' | 'detailed'
        topics: string[];
    };

    // 工作流程
    workflows: {
        name: string;
        description: string;
        frequency: number;
    }[];

    // 上下文信息
    context: {
        currentProjects: string[];
        goals: string[];
        challenges: string[];
    };

    // 元数据
    metadata: {
        createdAt: number;
        updatedAt: number;
        totalInteractions: number;
        lastProfileUpdate: number;
    };
}
// Memory System Type Definitions

export interface UserProfile {
    // 基本信息
    name?: string;
    profession?: string;
    expertise: string[];

    // 喜好与习惯
    preferences: {
        language: string;
        responseStyle: string;  // 'concise' | 'detailed'
        topics: string[];
    };

    // 工作流程
    workflows: {
        name: string;
        description: string;
        frequency: number;
    }[];

    // 上下文信息
    context: {
        currentProjects: string[];
        goals: string[];
        challenges: string[];
    };

    // 元数据
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

// 聊天消息历史（用于持久化）
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
        topics: []
    },
    workflows: [],
    context: {
        currentProjects: [],
        goals: [],
        challenges: []
    },
    metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        totalInteractions: 0,
        lastProfileUpdate: Date.now()
    }
};
