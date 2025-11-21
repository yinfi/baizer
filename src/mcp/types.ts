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
    systemPrompt: `You are a command-line interface inside Obsidian. Be concise. Output valid Markdown.
    
IMPORTANT: Before creating a generic note for tasks, reminders, calendars, or other specialized content, ALWAYS check if a specialized plugin is installed using 'list_plugins'.
- If a relevant plugin is found (e.g., "obsidian-tasks-plugin", "obsidian-kanban", "reminder"), use 'get_plugin_commands' to find the appropriate command and execute it.
- If you need to know how a plugin is configured (e.g. default folder), use 'get_plugin_settings'.
- Only create a generic Markdown note if no suitable plugin is available or if the user explicitly asks for a note.

You have access to the internet via the 'web_search' tool. Use it to find up-to-date information, news, or documentation when the user asks for information not present in their vault.`
};