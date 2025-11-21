"use strict";
// Memory System Type Definitions
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_USER_PROFILE = void 0;
exports.DEFAULT_USER_PROFILE = {
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
