# 斜杠命令系统瘦身与渲染修复 — 设计文档

日期：2026-06-30
状态：待实现
涉及模块：`src/ui/chat-controller.ts`、`src/ui/renderers/message-renderer.ts`、`src/ui/types.ts`、`src/ui/shell-view.ts`

## 1. 背景与问题

Baizer 的 sideshell 输入框里打 `/` 唤醒一套斜杠命令系统。用户反馈两个痛点：

1. **命令作用不大** —— 大部分命令做的事 AI 用工具调用全能完成。
2. **输出格式很差** —— 命令结果排版混乱，markdown 符号原样显示。

经代码分析，这两个症状指向不同的根因，需分别处理。

### 1.1 命令"作用不大"的本质

产品定位是"自然语言交互工作区"。当 AI 已能听懂人话并调用工具时，斜杠命令存在的唯一正当理由是**做 AI 做不到或做不好的事**。按此标准切分现有命令：

- **AI 原理上做不到**：`/clear`（清空 AI 自己看到的上下文窗口 + UI 历史）。不可替代。
- **需要精确参数引用**：`/file-back <message-id>`（用 message-id 引用历史回答，说人话别扭）。保留。
- **冗余便利层**：`/new` `/open` —— AI 用 `create_note`/`open_file` 全能做，命令仅提供零 token、确定性、可发现性。保留作为 power user 快捷入口。
- **历史兼容残留**：`/profile`（= `/memory overview` 别名）、`/forget`（= `/memory forget` 别名，代码已标注 `compatibilityNote`）。
- **半死命令**：`/save` —— `handleSave` 还在、legacy help 仍提及，但**从未注册进 `/` 下拉列表**（`shell-view.ts:95` 的 `localCommandSuggestions` 不含它）。`save_webpage` 工具完全覆盖。
- **重复入口**：`/wiki:compile/index/lint` —— 仅 `executeCommandById` 转发，与 Obsidian 命令面板重复，但在 sideshell 内直调比切面板方便，保留。
- **内省类**：`/tools` `/help` `/memory` —— AI 能描述但不如直接命令准确。保留。

### 1.2 输出"格式很差"的本质 —— 架构层渲染歧视

根因不在文案，在渲染管线。`message-renderer.ts:86-100` 按角色分流：

```
ai     → renderAiContent()  完整 markdown 渲染 + 代码块后处理
user   → setText()          纯文本
system → setText(`[System] ${content}`)  纯文本，markdown 不渲染
```

所有斜杠命令输出都走 `addMessage('system', markdownString)`，而 system 走 `setText` 当纯文本。于是 `/tools` 输出的 `## Available Tools`、`- **name**: desc` 把 `##`、`**` 原样显示。命令输出从未接进 markdown 渲染管线，这才是"格式差"的本质。

叠加问题：`chat-controller.ts` 内存在大量 GBK mojibake 字符串字面量（如 `鐢ㄦ硶`=用法、`鍒涘缓澶辫触`=创建失败、`鈥?`=破折号），源文件编码历史损坏。

## 2. 方案

三刀，对应三个根因。

### 2.1 第一刀 · 瘦身

砍除 4 个命令，各从三处删除（下拉建议表、switch 分支、handler 函数）：

| 命令 | 类别 | 处理 |
|------|------|------|
| `/profile` | 兼容别名 | 删 switch case + 其在 `handleMemory` 的 `/profile` 入参路径 |
| `/forget` | 兼容别名 | 删 switch case + `handleForget` 函数 |
| `/save` | 半死命令 | 删 `handleSave` 函数 + legacy help 提及 |
| `/edit` | 与 selection-menu 重复 | 删 switch case + `handleEdit` 函数 + 下拉建议项 |

保留命令集：`/clear`、`/file-back`、`/new`、`/open`、`/tools`、`/help`、`/memory`、`/wiki:compile`、`/wiki:index`、`/wiki:lint`。

注意：`localCommandSuggestions`（`shell-view.ts:95`）当前不含 `/save`/`/profile`/`/forget`，只需删 `/edit` 项。

### 2.2 第二刀 · 修渲染（核心）

让命令输出走 markdown 渲染，但不污染状态类 system 消息（Error/Cancelled/Updated 保持现有纯文本 + 特殊样式）。

**数据层**（`types.ts`）：`ChatMessage.metadata` 增加 `richText?: boolean`。

**注入层**（`chat-controller.ts`）：`addMessage` 增加可选 `metadata` 透传参数。命令输出调用处（`/tools` `/help` `/memory` 及保留 handler 的成功输出）传 `{ richText: true }`。状态消息（Error/Cancelled/Usage 提示）不传，保持纯文本。

**渲染层**（`message-renderer.ts`）：system 分支优先级：
1. `metadata.richText` 为真 → 走 `renderAiContent`（markdown + 代码块后处理），**不挂点赞/点踩工具栏**（那是 AI 回答专属，语义不符）。
2. 否则走现有 `parseSystemStatus` / `isCancelledSystemMessage` / `setText` 纯文本路径。

### 2.3 第三刀 · 修乱码

扫描 `chat-controller.ts` 全文，修复所有 GBK mojibake 字符串字面量为正确中文。范围限本文件（用户确认"整文扫乱码"）。

## 3. 单元边界

- `addMessage` 的职责扩展为"携带可选渲染元数据"，签名向后兼容（新参数可选）。
- `message-renderer.ts` 的 system 分支新增一条富文本判定，不改动 ai/user/approval/workspaceEdit 既有路径。
- 瘦身是纯删除，不引入新抽象。

## 4. 测试

- 现有测试：`test/chat-controller.test.ts`、`test/message-renderer.test.ts`、`test/command-suggestions.test.ts`、`test/command-dropdown.test.ts` 需全绿。
- 新增/调整断言：
  - 删除命令后，`/` 下拉不再出现 `/edit`；`handleSlashCommand('/edit ...')` 落入 `Unknown command`。
  - `richText: true` 的 system 消息走 markdown 渲染（断言渲染出 `<h2>`/`<strong>` 而非字面 `##`/`**`），且不渲染点赞/点踩按钮。
  - `richText` 缺省的 system 消息仍走纯文本 `[System]` 路径。
- 构建：`npm run build` 通过。

## 5. 非目标（YAGNI）

- 不重构整个命令分发架构（switch 保持）。
- 不全项目扫 mojibake（仅 chat-controller.ts）。
- 不动 `@`/`$` 触发逻辑。
- 不给命令输出加交互工具栏。
