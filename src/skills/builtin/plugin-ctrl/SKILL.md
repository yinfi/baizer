---
name: plugin-ctrl
description: 发现和使用 Obsidian 插件。需要插件能力时先通过此 skill 查找合适插件。
triggers:
  keywords: ["插件", "plugin", "plugins"]
tools: ["list_plugins", "get_plugin_commands", "get_plugin_settings", "execute_plugin_command"]
---

# Plugin Control — 插件编排器

查询和控制 Obsidian 插件。自动为已安装插件生成使用 Skill。

## 工作流程

当用户的需求可能由某个插件完成时：

1. 查看 <available_skills> 清单，是否已有匹配的 `plugin-*` skill
2. 如果有 → 用 `read_skill` 读取该插件 skill（如 `read_skill("plugin-obsidian-tasks")`），按其指令操作
3. 如果没有 → 使用 `list_plugins` 查看已安装插件
4. 找到候选插件后，用 `get_plugin_commands` 了解其能力
5. 根据命令和设置信息，直接操作完成任务

## 可用工具

- `list_plugins` — 列出所有已安装插件及其启用状态和 skill 状态
- `get_plugin_commands` — 获取指定插件的可用命令
- `get_plugin_settings` — 获取指定插件的设置
- `execute_plugin_command` — 执行指定插件命令

## 原则

- 优先使用已有 skill 的插件（instructions 更完整）
- 没有 skill 的插件，退回到命令级操作
- 只有在没有合适插件时，才用纯 vault 操作创建普通 Markdown
