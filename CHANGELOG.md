# Changelog

_English · [简体中文](#更新日志)_

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- **Video transcription is configurable, chunked, timestamped and honest.**
  The ASR endpoint (base URL, API key, model, language) is set in Settings ->
  Capture instead of being hardcoded to `whisper-1` on the active provider's
  base URL, and transcription no longer requires an `openai-compatible`
  provider: a vault configured only with Anthropic can transcribe as soon as an
  endpoint is set. Existing OpenAI-compatible users need no migration — with the
  new fields empty the plugin still uses the active provider's base URL and key
  with `whisper-1`. When no endpoint can be resolved at all, the note keeps the
  same model-summarised metadata fallback it had before, and the user is told why
  transcription was skipped.
- Audio is decoded to 16 kHz mono PCM and submitted as silence-snapped chunks of
  at most 45 s, instead of one unbounded request carrying the whole track. If the
  audio cannot be decoded, the plugin falls back to the previous single request
  and reports that it did.
- An endpoint that rejects `response_format=verbose_json` (some OpenAI-dialect
  implementations answer 400 to a parameter they do not know) is retried once
  without that parameter, and the degradation is reported. A request shape that
  worked before this change cannot break on upgrade.
- Transcription returns segment-level results with timestamps, and the saved
  note carries them as `[mm:ss] text` lines under a `Timestamped Transcript`
  heading; the note's excerpt is still subject to the pre-existing
  1000-character cap.
- Transcription failures are surfaced with their reason, in a notice and in the
  note, instead of being swallowed by an empty catch block.
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

- **视频转写现在可配置、会切片、带时间戳，并且失败可见。**
  ASR 端点（Base URL、API Key、模型、语言）改为在「设置 -> 采集」里配置，
  不再写死 `whisper-1` 并强制复用当前 provider 的地址；转写也不再要求
  provider 类型是 `openai-compatible` —— 只配了 Anthropic 的用户只要填上端点就能转写。
  既有的 OpenAI 兼容用户零迁移：新字段留空时，行为与改动前一致（沿用 provider 的
  地址与 key，模型 `whisper-1`）。完全解析不出端点时，笔记仍然走改动前那条
  「模型读元数据」的回退路径，并明确告诉用户为什么跳过了转写。
- 音频先解码成 16 kHz 单声道 PCM，再按「不超过 45 s、以静音段中点为切点」分片提交，
  不再把整条音轨塞进一个不设上限的请求。解码不可用时回退为改动前的整轨请求，
  并把这次回退明确告诉用户。
- 端点若拒绝 `response_format=verbose_json`（有的 OpenAI 方言实现会对不认识的
  参数回 400），会去掉该参数重试一次，并把这次降级告诉用户。改动前能用的请求
  形状不会因为升级而失败。
- 转写返回带时间戳的段级结果，笔记里以 `[mm:ss] 文本` 逐行写入
  `Timestamped Transcript` 小节；笔记里的摘录仍受改动前就存在的 1000 字符上限约束。
- 转写失败会连同原因一起暴露（通知 + 笔记正文），不再被空 catch 吞掉。
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
