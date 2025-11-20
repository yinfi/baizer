// import { PluginManifest, Command } from "obsidian";

declare module "obsidian" {
    interface App {
        plugins: {
            manifests: Record<string, PluginManifest>;
            enabledPlugins: Set<string>;
            getPlugin(id: string): any;
        };
        commands: {
            listCommands(): Command[];
            executeCommandById(id: string): boolean;
        };
    }
}

export interface GeminiSettings {
    // --- 🤖 Core Connection ---
    apiKey: string;
    primaryModel: string;
    thinkingModel: string;
    contextWindow: number;

    // --- 🛡️ Guardian Behavior ---
    enableGuardian: boolean;
    guardianSensitivity: number;
    guardianUIStyle: 'ghost' | 'gutter' | 'hybrid';
    ignoredFolders: string;
    privacyMode: boolean;

    // --- ⚡ Permissions ---
    allowFileCreation: boolean;
    allowFileModification: boolean;
    allowPluginControl: boolean;
    confirmExecutions: boolean;

    // --- 🖥️ Terminal Appearance ---
    terminalTheme: 'hacker-green' | 'cyberpunk' | 'obsidian-native';
    terminalFont: string;
    terminalFontSize: number;
    terminalOpacity: number;

    // --- 🧠 System Prompt ---
    customizePrompt: boolean;
    systemPrompt: string;
}

export const DEFAULT_SETTINGS: GeminiSettings = {
    // Core
    apiKey: '',
    primaryModel: 'gemini-2.5-flash',  // 2.5 Flash
    thinkingModel: 'gemini-2.5-pro',   // 2.5 Pro
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