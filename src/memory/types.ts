import { MemoryRecord } from './hindsight-types';

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

export type MemoryViewMode =
    | 'overview'
    | 'observations'
    | 'facts'
    | 'recent'
    | 'search'
    | 'raw';

export interface MemoryViewRequest {
    mode?: MemoryViewMode;
    query?: string;
    limit?: number;
    now?: number;
}

export interface MemoryStats {
    total: number;
    world: number;
    experience: number;
    observation: number;
    lastUpdatedAt: number | null;
}

export interface MemoryViewSections {
    observations: MemoryRecord[];
    facts: MemoryRecord[];
    recent: MemoryRecord[];
    searchResults: MemoryRecord[];
    raw: MemoryRecord[];
}

export interface MemoryView {
    privacyMode: boolean;
    legacyProfile: UserProfile;
    stats: MemoryStats;
    sections: MemoryViewSections;
}

export interface MemoryMutationResult {
    success: boolean;
    deletedCount: number;
    message: string;
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
