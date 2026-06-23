# 移动端保存微信文章流程

本文说明 Baizer 在 iOS 和 Android 移动端保存微信公众号文章的推荐流程。当前插件不能直接把自己注册到微信分享面板，移动端自动化通过 Obsidian URL scheme 完成。

## 能力边界

Baizer 已注册以下协议入口：

```text
obsidian://baizer-clip?url=<encoded-http-url>
obsidian://baizer-clip?text=<encoded-share-text>
```

推荐移动端自动化使用 `text` 参数。它可以接收完整分享文本，Baizer 会从文本中提取第一个 `http/https` 链接，再调用 `save_webpage` 保存。

## 方式一：剪贴板命令兜底

适合不想配置系统自动化的用户。

1. 在微信中打开公众号文章。
2. 复制文章链接。
3. 打开 Obsidian 移动端。
4. 执行命令 `Baizer: Save URL from clipboard`。
5. Baizer 从剪贴板提取链接并保存文章。

成功后会提示：

```text
Saved: Clippings/<文章标题>.md
```

如果剪贴板中没有 `http/https` 链接，会提示：

```text
Failed to save URL: No http/https URL found.
```

## 方式二：iOS 快捷指令

目标效果：微信文章分享后，选择快捷指令，自动跳转 Obsidian 并保存文章。

配置步骤：

1. 打开 iOS 快捷指令。
2. 新建快捷指令，例如命名为 `保存到 Baizer`。
3. 打开“在共享表单中显示”。
4. 共享输入类型选择 `URL` 和 `文本`。
5. 添加动作“URL 编码”，输入选择“快捷指令输入”。
6. 添加动作“打开 URL”。
7. URL 填写：

```text
obsidian://baizer-clip?text=<URL 编码后的快捷指令输入>
```

不同 iOS 版本的快捷指令变量名称可能不同，关键是把分享输入先 URL encode，再拼到 `text=` 后面。

使用方式：

1. 微信打开公众号文章。
2. 分享到系统分享面板。
3. 选择 `保存到 Baizer`。
4. 系统打开 Obsidian。
5. Baizer 提示 `Clipping: ...`，完成后提示 `Saved: ...`。

## 方式三：Android 自动化

Android 可以用 Tasker、MacroDroid 或其他支持分享输入的自动化工具。

自动化动作：

1. 接收分享文本或分享 URL。
2. 对接收到的内容做 URL encode。
3. 打开以下 URL：

```text
obsidian://baizer-clip?text=<encoded-share-text>
```

使用方式：

1. 微信打开公众号文章。
2. 分享。
3. 选择配置好的 Android 自动化动作。
4. 自动跳转 Obsidian 并保存文章。

## 保存结果

微信公众号文章会走微信专用解析逻辑：

- 提取标题。
- 提取公众号作者名称。
- 优先读取 `#js_content` 正文。
- 将微信图片的 `data-src` 转成 `src`。
- 转换为 Markdown。
- 保存到设置中的 `WeChat Storage Path`，默认 `Clippings`。

生成笔记示例：

```markdown
---
created: 2026-06-22T00:00:00.000Z
source: https://mp.weixin.qq.com/s/abc123
author: 公众号名称
tags: clipping
---

# 文章标题

正文 Markdown...
```

## 常见问题

### 微信分享面板里没有 Baizer

这是当前能力边界。Obsidian 插件不能直接注册为微信原生分享目标，所以需要 iOS 快捷指令或 Android 自动化作为中间层。

### 自动化打开了 Obsidian 但没有保存

检查自动化最终打开的 URL 是否形如：

```text
obsidian://baizer-clip?text=<encoded-share-text>
```

如果分享文本没有包含 `http/https` 链接，Baizer 会拒绝保存。

### 协议方式和 Inbox.md 方式有什么区别

协议方式直接触发保存；`Inbox.md` 方式是通过文件修改监听扫描裸链接。两者最终都会调用同一个 `save_webpage` 工具，保存结果一致。
