---
name: web-clipper
description: 保存网页或视频到 vault。支持 YouTube、Bilibili、微信公众号和普通网页。
triggers:
  commands: ["/save"]
  keywords: ["剪藏", "clip", "网页", "webpage", "http://", "https://", "youtube", "bilibili", "微信公众号"]
tools: ["save_webpage"]
---

# Web Clipper

保存网页或视频到 vault 的完整流程。

## 支持的内容类型

- **YouTube 视频**：提取转录文本，AI 生成摘要
- **Bilibili 视频**：提取字幕，AI 生成摘要
- **微信公众号文章**：特殊 DOM 处理，提取正文
- **普通网页**：Readability 提取正文，转为 Markdown

## 工作流程

1. 检测 URL 类型（视频 / 网页）
2. 视频路径：提取转录 → AI 摘要 → 生成笔记
3. 网页路径：HTTP 请求 → HTML 解析 → Readability 提取 → Markdown 转换
4. 生成 YAML frontmatter（created, source, author, tags）
5. 保存到配置的存储目录

## 输出格式

```markdown
---
created: 2026-04-17T12:00:00.000Z
source: https://example.com/article
author: Author Name
tags: clipping
---

# Article Title

[正文内容]
```
