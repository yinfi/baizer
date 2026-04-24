---
name: knowledge
description: 从个人知识库检索相关知识，或将高质量回答归档到知识库。当用户的问题可能与已积累的知识相关时使用。
triggers:
  commands: ["/wiki:query"]
  keywords: ["知识库", "知识", "knowledge", "wiki"]
tools: ["query_knowledge", "file_back_knowledge"]
---

# Knowledge Wiki

个人知识库的检索和归档。

## 工作流程

1. 使用 `query_knowledge` 检索相关知识
2. 如果知识库中没有相关内容，正常回答即可，不要强行引用
3. 知识库检索不足时，可以用 `search_vault` 搜索整个 vault 补充

## 引用规则

如果回答引用了知识库中的文章，必须在回答末尾添加引用来源：

```
---
📚 引用来源：
- [[文章路径|文章标题]]
```

## 回填规则

当回答综合了多个知识来源、产出有价值的新洞察或对比分析时，
使用 `file_back_knowledge` 工具将回答归档到知识库。

- 不要对简单的事实查询做回填，只回填有综合价值的内容
- 用户点赞（👍）时无论判断如何都执行回填
- 用户点踩（👎）时不回填
