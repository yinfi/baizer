以下是基于我们之前的深度讨论，整理出的完整**产品需求文档 (PRD)** 与 **UI/UX 设计说明书**。

项目名称暂定为：**Obsidian Gemini Shell**。

---

# 第一部分：产品需求文档 (PRD)

## 1. 项目概述 (Overview)
**Obsidian Gemini Shell** 是一款基于 Google Gemini 模型的 Obsidian 插件。它不只是一个聊天机器人，而是将大模型作为“操作系统内核”，通过**虚拟命令行 (Virtual CLI)** 和 **MCP (Model Context Protocol)** 协议，实现对笔记库的深度理解、主动辅助以及对其他插件的自动化编排。

### 1.1 核心价值主张
1.  **沉浸式 (Immersive)**: 通过命令行交互，减少鼠标操作，让用户保持在键盘和思考流中。
2.  **主动性 (Proactive)**: 不仅仅回答问题，更在后台“守护”，主动发现关联、错误和遗漏的任务。
3.  **生态化 (Orchestration)**: 能够识别并调用现有的 Obsidian 插件（如 Dataview, Kanban），成为插件的“插件”。

## 2. 功能架构 (Functional Architecture)

### 2.1 模块一：Gemini Shell (虚拟终端)
这是用户主动交互的唯一入口。
*   **自然语言转指令**: 用户输入自然语言（“帮我把这个列表变成看板”），系统解析意图并执行。
*   **伪指令体系 (Pseudo-Commands)**:
    *   `list_plugins` (获取已安装插件清单).
    *   `execute_command` (调用 Obsidian 全局命令).
*   **Plugin Awareness**: 自动识别 Dataview, Kanban, Templater, Excalidraw 等插件，并学习其语法格式。

## 3. 技术指标 (Non-Functional Requirements)
1.  **响应速度**: 默认使用 **Gemini 1.5 Flash** 模型，确保 1-2 秒内响应。复杂推理自动切换至 **1.5 Pro**。
2.  **移动端兼容**: 核心逻辑必须兼容 Obsidian Mobile (iOS/Android)，严禁调用 Node.js `child_process`。
3.  **隐私安全**:
    *   提供 `.geminiignore` 功能，允许用户排除特定文件夹。
    *   所有的 Delete/Overwrite 操作必须经过用户 `Confirm`。

---



# 第二部分：开发路线图 (Roadmap)

## Phase 1: MVP (最小可行性产品)
*   [x] 完成插件基础框架搭建。
*   [x] 实现 `ShellModal` UI (仅前端，能打字回显)。
*   [x] 接入 Google Gemini API，实现基本的 Chat 功能。
*   [x] 实现 `/new` 和 `/edit` 两个基础伪指令。

## Phase 2: The Brain (核心能力)
*   [ ] 构建 MCP `ToolRegistry`。
*   [ ] 实现 `read_note` 和 `search_vault` 工具。
*   [ ] 实现 `Orchestrator`，让 Gemini 能够识别并调用 Obsidian 的 Command Palette。

## Phase 3: The Guardian (主动辅助)
*   [ ] 实现编辑器变更监听 (Debounce机制)。
*   [ ] 开发 Ghost Text (CodeMirror Extension)。
*   [ ] 开发 Gutter Dot 提示交互。

## Phase 4: Polish (打磨)
*   [ ] 移动端适配测试。
*   [ ] 完善流式输出 (Streaming) 的 UI 渲染。
*   [ ] 发布到 Obsidian Community Plugins 市场。