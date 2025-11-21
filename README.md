# Obsidian CLI

**Obsidian CLI** is a powerful AI-driven plugin for Obsidian that integrates a terminal-like interface and an intelligent "Guardian" co-writer directly into your workflow. Powered by Google's Gemini AI, it transforms how you interact with your notes, offering context-aware assistance, automated editing, and a persistent memory of your preferences and projects.

## Features

### 🖥️ Gemini Shell
A dedicated terminal interface within Obsidian for natural language interaction with your vault.
- **Chat with Context**: Ask questions about your notes, brainstorm ideas, or request summaries.
- **Tool Integration**: The AI can perform actions like reading, writing, and listing files (powered by MCP-like tools).
- **Plugin Orchestration**: The AI can automatically list, control, and execute commands from *other* Obsidian plugins (e.g., "Create a Kanban board", "Toggle Day Planner"), making it a true command center for your vault.
- **Persistent Memory**: The AI remembers your profession, expertise, current projects, and preferences across sessions.

### 🛡️ Guardian Mode (Co-writer)
An intelligent assistant that lives in your editor gutter.
- **Auto-Suggestions**: As you type, the Guardian analyzes your context and suggests completions or improvements via Ghost Text.
- **Cursor Selection**: Select any text to instantly invoke the Guardian for specific instructions.
- **Status Indicators**: Visual feedback in the gutter shows when the AI is thinking, has a suggestion, or encounters an error.

### 🖱️ Manual Selection Mode
Select any text and interact with the AI instantly.
- **Floating Menu**: Select text to see a "Comment / AI" button.
- **Context-Aware Actions**: Ask the AI to rewrite, summarize, or answer questions based on the selection.
- **Result View**: AI responses are displayed directly in a scrollable tooltip with Markdown rendering.
- **Ghost Text Edits**: If you ask for an edit, the AI's suggestion appears as Ghost Text over your selection for easy review.

### 🧠 Persistent Memory & Persona
- **User Profiling**: The plugin automatically builds a profile of you based on your conversations (e.g., your profession, goals, writing style).
- **Smart Updates**: Your profile is updated periodically and saved locally, ensuring the AI gets to know you better over time.
- **Privacy-First**: All memory data is stored locally in your vault under `.obsidian/gemini-memory`.

## Installation

1.  Download the latest release from the [Releases](https://github.com/yinfie/obsidian-cli/releases) page.
2.  Extract the files (`main.js`, `manifest.json`, `styles.css`) into your vault's plugin folder: `.obsidian/plugins/obsidian-cli/`.
3.  Reload Obsidian and enable the plugin in Settings.

## Configuration

1.  Open **Settings** > **Obsidian CLI**.
2.  **API Key**: Enter your Google Gemini API Key.
3.  **Model**: Select your preferred Gemini model (e.g., `gemini-2.0-flash-exp`).
4.  **Guardian Mode**: Enable/disable the co-writer features and customize the trigger sensitivity.

## Usage

- **Open Shell**: Press `Cmd/Ctrl + J` to open the Gemini Shell view.
- **Guardian Trigger**: Press `Cmd/Ctrl + Shift + G` to open the manual instruction modal.
- **Selection Menu**: Select text in the editor to see the floating AI menu.

## Author

**yinfie**

## License

MIT
