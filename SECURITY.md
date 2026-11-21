# Security Policy

_English · [简体中文](#安全策略)_

## Supported Versions

Baizer is under active development. Security fixes are applied to the latest
released version only.

| Version | Supported |
| ------- | --------- |
| latest  | ✅        |
| older   | ❌        |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

If you discover a security issue, report it privately:

- Use GitHub's [private vulnerability reporting](https://github.com/yinfi/baizer/security/advisories/new), or
- Email the maintainer at **yinfie@qq.com** with the subject line `[Baizer Security]`.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (proof of concept if possible).
- The plugin version and Obsidian version affected.

You can expect an initial response within **7 days**. We will keep you informed
about the progress toward a fix and may ask for additional details.

## Scope & Data Handling

Baizer runs entirely inside your Obsidian client. It is important to understand
its trust boundaries:

- **API keys** you configure are stored in the plugin's local `data.json` inside
  your vault's `.obsidian` folder. They are sent to the AI provider endpoints you
  configure (e.g. OpenAI, DeepSeek, Alibaba DashScope) — never to any
  Baizer-operated server. Baizer has **no telemetry and no data collection**.
- **Vault content** is sent to your configured AI provider as part of prompts,
  together with recalled memory, prior turns, ambient context, and tool output.
  Review your provider's data-usage policy before enabling features on sensitive
  notes.
- **Other outbound requests:** search queries go to DuckDuckGo; clipping fetches
  the URL you supply; video links resolve through YouTube or Bilibili; with
  plugin control enabled, plugin metadata is read from GitHub.
- **AI-initiated file writes** are governed by the permission and confirmation
  settings. AI-initiated `.obsidian` writes are always blocked. When enabling
  broad write scope or disabling confirmations, you accept the risk of
  AI-initiated vault mutations.

When reporting, please treat any credentials or private vault content as
sensitive and avoid pasting real API keys or personal notes into reports.

---

# 安全策略

_[English](#security-policy) · 简体中文_

## 受支持的版本

Baizer 处于活跃开发阶段,安全修复仅应用于最新发布版本。

| 版本   | 是否支持 |
| ------ | -------- |
| 最新版 | ✅       |
| 旧版本 | ❌       |

## 如何报告漏洞

**请勿为安全漏洞创建公开的 GitHub issue。**

如果你发现安全问题,请通过私密渠道报告:

- 使用 GitHub 的[私密漏洞报告](https://github.com/yinfi/baizer/security/advisories/new),或
- 发送邮件至 **yinfie@qq.com**,主题为 `[Baizer Security]`。

请在报告中包含:

- 漏洞描述及其影响。
- 复现步骤(如可能,提供概念验证)。
- 受影响的插件版本与 Obsidian 版本。

你将在 **7 天内**收到初步回复。我们会向你同步修复进展,并可能请你补充细节。

## 范围与数据处理

Baizer 完全运行在你的 Obsidian 客户端内。请理解其信任边界:

- **API 密钥**保存在你库内 `.obsidian` 目录下插件的本地 `data.json` 中。它发送给你所
  配置的 AI 服务端点(如 OpenAI、DeepSeek、阿里云 DashScope),
  **绝不会**发往任何由 Baizer 运营的服务器。Baizer **无遥测、无数据收集**。
- **库内容**会作为提示词的一部分发送给你配置的 AI 服务商,其中还包括召回的
  记忆、历史回合、环境上下文与工具返回内容。在敏感笔记上启用功能前,请先了解
  你的服务商的数据使用政策。
- **其他出站请求:** 搜索词会发往 DuckDuckGo;网页抓取会访问你提供的 URL;
  视频链接会经 YouTube 或 Bilibili 解析;启用插件控制时,插件元数据会从
  GitHub 读取。
- **AI 发起的文件写入**受权限与确认设置约束。AI 发起的 `.obsidian` 写入始终被
  阻止。当你启用宽泛写入范围或关闭确认时,即表示你接受 AI 发起库变更的风险。

报告时,请将任何凭据或私密库内容视为敏感信息,避免在报告中粘贴真实的 API
密钥或个人笔记。
