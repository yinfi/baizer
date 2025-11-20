# 第二部分：UI/UX 设计说明书

## 1. 设计哲学 (Design Philosophy)
*   **Hacker Aesthetic (极客美学)**: 黑底绿字，等宽字体，致敬 CLI。
*   **Overlay Interface (覆盖层界面)**: 用完即走，不常驻侧边栏，不占用屏幕空间。
*   **Keyboard First (键盘优先)**: 所有操作均可通过键盘完成。

## 2. 界面详述 (UI Components)

### 2.1 The Omni-Terminal (主终端模态框)
**触发**: `Cmd/Ctrl + J`

**视觉样式**:
*   **容器**: 居中弹窗，圆角 12px，背景色 `#1e1e1e` (深色磨砂)，边框 `1px solid #333`。
*   **字体**: `JetBrains Mono` 或 `Fira Code`，字号 14px。

**交互流程**:
1.  **Input State**:
    *   显示提示符 `>_` (绿色呼吸灯效果)。
    *   输入指令时，关键字高亮（如 `/do` 亮紫色，参数亮白色）。
2.  **Processing State**:
    *   输入框下方出现滚动日志区。
    *   显示流式步骤：`[SYSTEM] Scanning plugins...` -> `[TOOL] Executing Dataview...`。
3.  **Result State**:
    *   Gemini 的回复以 Markdown 格式渲染在日志区。
    *   底部出现操作栏（Action Bar）：
        *   `[Enter] Apply Changes` (绿色)
        *   `[Esc] Discard` (灰色)
        *   `[Cmd+C] Copy`

### 2.2 Guardian Indicators (守护者提示)
**场景**: 编辑器界面 (Editor View)

**视觉样式 - Gutter Dot (槽位点)**:
*   位置：行号左侧或右侧。
*   形态：一个 6px 的实心圆点，颜色为 `#7c4dff` (紫色)。
*   交互：
    *   **Hover**: 弹出一个深色 Tooltip，显示 AI 的简短建议（如：“检测到与 [[Project Alpha]] 的关联”）。
    *   **Click**: 自动采纳建议（如插入链接）。

**视觉样式 - Ghost Text (幽灵文本)**:
*   位置：光标当前位置之后。
*   形态：文字颜色为灰色，透明度 0.5，呈现 AI 预测的下文。
*   交互：
    *   **Tab**: 文本变为实体（采纳）。
    *   **Typing**: 用户继续打字，幽灵文本立即消失。

### 2.3 Settings Panel (控制中心)
**布局**: 采用 Obsidian 标准设置页面的 Tab 布局。

*   **Tab 1: Connection**
    *   [Input] Gemini API Key (隐藏显示)。
    *   [Dropdown] Model Selection (Flash / Pro)。
*   **Tab 2: Personality**
    *   [Textarea] System Prompt: 允许用户自定义 Shell 的人设（例如：“你是一个严厉的编辑”）。
*   **Tab 3: Permissions**
    *   [Toggle] Allow Plugin Execution (允许 AI 操作其他插件)。
    *   [Toggle] Allow File Creation (允许 AI 创建文件)。
    *   [List] Ignored Folders (排除目录)。


非常感谢指出。配置页面（Settings Tab）是用户掌控 AI 行为边界的核心，尤其是对于这样一个拥有“执行能力”的插件，清晰、分层的配置设计至关重要。

以下是 **Obsidian Gemini Shell** 插件配置页面的详细设计说明书。

---

# 插件配置页面设计说明书 (Settings Page UI/UX)

## 1. 总体布局 (Layout Structure)

遵循 Obsidian 原生插件设置规范，采用 **垂直滚动流** 布局。为了避免设置项过多造成认知负荷，我们将配置项划分为五个清晰的区域（Section），并使用标题和分割线隔开。

**区域划分**:
1.  **🤖 Core Connection (核心连接)** - API 与模型
2.  **🛡️ Guardian Behavior (守护者行为)** - 后台被动感知
3.  **⚡ Permissions & Capabilities (权限与能力)** - 工具调用范围
4.  **🖥️ Terminal Appearance (终端外观)** - 界面自定义
5.  **🧠 System Prompt (系统人设)** - 高级自定义

---

## 2. 详细配置项描述

### 2.1 🤖 Core Connection (核心连接)

这是插件运行的基础。

| 设置项名称 | 组件类型 | 描述/交互 | 默认值 |
| :--- | :--- | :--- | :--- |
| **API Key** | Password Input | 输入 Google Gemini API Key。<br>右侧附带按钮 `[Check]` 用于测试连通性。<br>下方附带链接文本：*"Get your key at Google AI Studio"*。 | Empty |
| **Primary Model** | Dropdown | 选择用于日常交互（如 Shell 对话）的模型。<br>选项：`Gemini 1.5 Flash` (推荐), `Gemini 1.5 Pro`。 | Flash |
| **Thinking Model** | Dropdown | 选择用于复杂推理（如文档分析、代码生成）的模型。<br>选项：`Same as Primary`, `Gemini 1.5 Pro`。 | Pro |
| **Context Window** | Slider | 限制发送给 AI 的上下文长度（以节省 Token 或提升速度）。<br>范围：`10k` - `100k` - `1M`。 | 32k |

> **交互细节**: 点击 `[Check]` 按钮后，如果连接成功，按钮变绿并显示 "Connected ✓"；如果失败，显示红色错误信息 toast。

### 2.2 🛡️ Guardian Behavior (守护者行为)

控制 AI 在编辑器中的“存在感”。

| 设置项名称 | 组件类型 | 描述/交互 | 默认值 |
| :--- | :--- | :--- | :--- |
| **Enable Guardian** | Toggle | 总开关。关闭后，插件仅在唤起 Terminal 时工作，后台不监听。 | On |
| **Trigger Sensitivity** | Slider | 决定 AI 介入的频率。<br>• **Low**: 仅手动唤起。<br>• **Medium**: 仅提示强关联或错误。<br>• **High**: 类似 Copilot 的激进补全。 | Medium |
| **UI Style** | Dropdown | 选择提示展现方式。<br>• **Ghost Text**: 光标后灰色文字（适合补全）。<br>• **Gutter Icon**: 行号旁图标（适合无干扰建议）。<br>• **Hybrid**: 两者结合。 | Hybrid |
| **Ignored Folders** | Textarea (Multi-line) | 每一行输入一个路径。AI 将完全忽略这些路径下的文件（不读取、不分析、不建议）。<br>例：`Private/Diary`<br>`Work/Secrets` | Empty |
| **Privacy Mode** | Toggle | 开启后，发送给 AI 的数据将进行脱敏处理（尝试替换人名/邮箱），但会降低准确度。 | Off |

### 2.3 ⚡ Permissions & Capabilities (权限与能力)

这是 **"OS Kernel"** 的安全阀，决定了 AI 能对你的库做什么。

| 设置项名称 | 组件类型 | 描述/交互 | 默认值 |
| :--- | :--- | :--- | :--- |
| **Allow File Creation** | Toggle | 允许 AI 创建新笔记 (`create_note` 工具)。 | On |
| **Allow File Modification**| Toggle | 允许 AI 修改**当前文件以外**的笔记（如追加到 Daily Note）。关闭后，AI 只能修改当前光标所在文件。 | Off |
| **Allow Plugin Control** | Toggle | 允许 AI 扫描并调用其他插件的命令 (`execute_command`)。<br>*警告信息：开启此项可能导致 AI 执行不可逆的操作。* | Off |
| **Confirm Executions** | Toggle | **Human-in-the-loop**。开启后，所有“写入/执行”类操作必须在 Terminal 中由用户点击 `[Confirm]` 才会真正执行。 | On |

### 2.4 🖥️ Terminal Appearance (终端外观)

定制 `Cmd + J` 弹出的那个黑客窗口。

| 设置项名称 | 组件类型 | 描述/交互 | 默认值 |
| :--- | :--- | :--- | :--- |
| **Theme Style** | Dropdown | • **Hacker Green**: 黑底绿字。<br>• **Cyberpunk**: 蓝紫色霓虹。<br>• **Obsidian Native**: 跟随当前主题配色。 | Hacker Green |
| **Font Family** | Text Input | 自定义终端字体。建议使用等宽字体。 | JetBrains Mono |
| **Font Size** | Slider | 调整终端文字大小 (12px - 20px)。 | 14px |
| **Opacity** | Slider | 背景透明度 (0.5 - 1.0)。 | 0.95 |

### 2.5 🧠 System Prompt (高级设置)

允许 Power User 修改 AI 的底层指令。

| 设置项名称 | 组件类型 | 描述/交互 | 默认值 |
| :--- | :--- | :--- | :--- |
| **Customize Prompt** | Toggle | 开启后，显示下方的文本编辑框。 | Off |
| **System Instruction** | Large Textarea | 这是一个巨大的文本域，预填了默认的 Prompt。<br>用户可以在这里定义："Use academic tone", "Always reply in Chinese", "Act like a Python expert". | (Default Prompt) |
| **Restore Default** | Button | 将 Prompt 恢复为初始设置。 | - |

---

## 3. 视觉原型 (Visual Mockup - ASCII)

```text
+---------------------------------------------------------------+
|                 Settings: Obsidian Gemini Shell               |
+---------------------------------------------------------------+
|                                                               |
|  ## 🤖 Core Connection                                        |
|  -----------------------------------------------------------  |
|  API Key                                                      |
|  [ ************************************** ] [ Check ]         |
|  Get your key here                                            |
|                                                               |
|  Primary Model                                                |
|  [ Gemini 1.5 Flash v ]                                       |
|                                                               |
|  ## 🛡️ Guardian Behavior                                      |
|  -----------------------------------------------------------  |
|  Enable Guardian                                      (O) On  |
|  Allow the AI to analyze text while you type.                 |
|                                                               |
|  Trigger Sensitivity                                          |
|  Low [-----------|-----------] High                           |
|                                                               |
|  Ignored Folders                                              |
|  +------------------------------------------------+           |
|  | Private/                                       |           |
|  | Templates/                                     |           |
|  +------------------------------------------------+           |
|                                                               |
|  ## ⚡ Capabilities                                           |
|  -----------------------------------------------------------  |
|  Allow Plugin Control                                 ( ) Off |
|  Allow AI to execute commands from other plugins.             |
|                                                               |
|  Require Confirmation                                 (O) On  |
|  Always ask before writing files or running commands.         |
|                                                               |
+---------------------------------------------------------------+
```

## 4. 关键交互逻辑说明

1.  **安全性优先**: `Allow Plugin Control` 默认必须为 **Off**。当用户尝试开启时，应该弹出一个原生的 `Notice` 警告：“开启此功能意味着 AI 可以代表你执行任何插件命令，请确保你信任 AI 的输出。”
2.  **模型联动**: 当 `API Key` 未填写或验证失败时，其他所有功能区域应处于 **Disabled (灰色不可用)** 状态，防止用户在未配置好连接的情况下调整参数。
3.  **即时生效**: 外观类的修改（如字体、透明度）不需要重启 Obsidian，应即时应用到 `ShellModal` 实例中。

这个配置页面设计旨在平衡**易用性**（小白只需填 Key）和**可控性**（极客可以微调权限和 Prompt），符合 Obsidian 社区用户的习惯。

## 3. 交互声音与反馈 (Haptics & Feedback)
*   **Error**: 输入未知指令或 API 报错时，终端框体轻微左右震动（Shake 动画）。
*   **Success**: 任务完成时，终端左侧出现绿色竖条一闪而过。

## 4. 颜色规范 (Color Palette)
| 用途 | 颜色代码 | 描述 |
| :--- | :--- | :--- |
| Background | `#1e1e1e` (95% Opacity) | 终端背景 |
| Primary Text | `#e0e0e0` | 主要文本 |
| Accent (Prompt) | `#4caf50` | 提示符与成功状态 (Green) |
| Command Highlight| `#ab47bc` | 指令高亮 (Purple) |
| Warning | `#ff9800` | 警告与需确认操作 (Amber) |
| Ghost Text | `#ffffff` (40% Opacity) | 幽灵文本 |

---