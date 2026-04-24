---
name: web-search
description: 搜索互联网获取最新信息、新闻或文档。当用户询问 vault 中没有的实时信息时使用。
triggers:
  keywords: ["搜索", "搜一下", "search", "google", "最新", "新闻"]
tools: ["web_search"]
---

# Web Search

使用 DuckDuckGo 搜索互联网。

## 使用方式

提供搜索关键词，可选时间范围过滤。

## 参数

- `query`（必填）：搜索关键词
- `time_range`（可选）：时间范围 — d(天), w(周), m(月), y(年)

## 输出格式

返回最多 5 条搜索结果，每条包含 title、link、snippet。
回答时使用 Markdown 链接格式：`[Title](URL)`。
