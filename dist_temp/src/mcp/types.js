"use strict";
// import { PluginManifest, Command } from "obsidian";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SETTINGS = void 0;
exports.DEFAULT_SETTINGS = {
    // Core
    apiKey: '',
    primaryModel: 'gemini-2.5-flash',
    thinkingModel: 'gemini-2.5-pro',
    contextWindow: 100000,
    // Guardian
    enableGuardian: false,
    guardianSensitivity: 50,
    guardianUIStyle: 'hybrid',
    ignoredFolders: '',
    privacyMode: false,
    // Permissions
    allowFileCreation: true,
    allowFileModification: false,
    allowPluginControl: false,
    confirmExecutions: true,
    // Terminal
    terminalTheme: 'hacker-green',
    terminalFont: 'JetBrains Mono',
    terminalFontSize: 14,
    terminalOpacity: 0.95,
    // Prompt
    customizePrompt: false,
    systemPrompt: 'You are a command-line interface inside Obsidian. Be concise. Output valid Markdown.'
};
