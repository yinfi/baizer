# Changelog

_English · [简体中文](#更新日志)_

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- **Google Gemini support removed** to shrink the bundle. `ProviderConfig.type`
  is now `openai-compatible` or `anthropic`; the Gemini protocol, its built-in
  provider entry, and the Google SDKs it pulled in are gone. Video transcription
  now uses the OpenAI-compatible `/audio/transcriptions` (Whisper) path only.
- **Breaking:** a saved provider of the removed type is dropped when settings
  load. Its API key and model are not migrated, and if it was the active
  provider, the active provider is repaired to the first remaining one (normally
  `openai`, unconfigured). The drop is in memory only — the entry leaves
  `data.json` on the next settings save, so downgrading does not lose it.
- `dist/main.js` shrinks from 4,137,811 B (3.95 MiB) to 3,162,611 B (3.02 MiB):
  -975,200 B (-952.34 KiB, -23.57%). 916,486 B of that is the two removed Google
  SDKs (`@google/genai` 876,277 B and `@google/generative-ai` 40,209 B).

## [1.0.1]

- `authorUrl` now points at the author's profile instead of the plugin's own
  repository, as the community directory expects.

## [1.0.0]

Initial public release.

- **Baizer Workbench**: chat workspace with streaming output and a foldable
  tool/thinking timeline.
- **Guardian Mode**: inline AI completions via Ghost Text, with fast and deep
  completion paths.
- **Skills & Tools**: atomic vault/web tools orchestrated by progressively
  disclosed Skills.
- **Knowledge Wiki**: ontology-driven compilation of notes into a searchable,
  self-updating knowledge base.
- **Hindsight Memory**: local semantic memory (facts / experiences /
  observations) with recall, consolidation, and feedback lessons.
- Multi-provider support (Gemini and OpenAI-compatible endpoints) through a
  single pi-ai agent runtime.
- Desktop and mobile (iOS / Android) support.

---

# 更新日志

_[English](#changelog) · 简体中文_

本文件记录本项目所有值得注意的变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),并遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

- **移除 Google Gemini 支持**以缩减包体积。`ProviderConfig.type` 现在只有
  `openai-compatible` 与 `anthropic`;Gemini 协议、其内置 provider 条目以及它
  引入的 Google SDK 一并删除。视频转写改为只走 OpenAI 兼容的
  `/audio/transcriptions`(Whisper)路径。
- **破坏性变更:** 已保存的、类型为已移除协议的 provider 会在设置加载时被丢弃。
  其 API 密钥与模型不会被迁移;若它正是当前激活的 provider,激活项会被修复为
  剩余的第一个 provider(通常是尚未配置的 `openai`)。丢弃只发生在内存中 ——
  该条目要到下次保存设置时才会从 `data.json` 消失,因此降级回旧版本不会丢失它。
- `dist/main.js` 从 4,137,811 B(3.95 MiB)缩减到 3,162,611 B(3.02 MiB):
  减少 975,200 B(-952.34 KiB,-23.57%)。其中 916,486 B 来自被移除的两个
  Google SDK(`@google/genai` 876,277 B、`@google/generative-ai` 40,209 B)。

## [1.0.1]

- `authorUrl` 改为指向作者主页,而不是插件自己的仓库 —— 社区目录要求如此。

## [1.0.0]

首个公开发布版本。

- **Baizer 工作台**:带流式输出与可折叠工具/思考时间线的聊天工作区。
- **Guardian 模式**:通过 Ghost Text 提供行内 AI 补全,支持快速与深度两条补全路径。
- **技能与工具**:由渐进式披露的技能编排的原子化库/网页工具。
- **知识 Wiki**:本体驱动地将笔记编译成可搜索、自更新的知识库。
- **Hindsight 记忆**:本地语义记忆(事实/经验/观察),支持召回、整合与反馈教训。
- 通过单一 pi-ai agent 运行时支持多服务商(Gemini 与 OpenAI 兼容端点)。
- 支持桌面端与移动端(iOS / Android)。
