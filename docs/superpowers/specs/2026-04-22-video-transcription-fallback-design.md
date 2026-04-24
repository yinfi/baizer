# 视频转写兜底设计

## 背景

当前插件保存视频的能力已经分成三档：

1. 有平台字幕时，抓取字幕并生成摘要。
2. 平台不给字幕但页面有标题/描述时，只能生成 metadata 摘要。
3. 如果 metadata 也不足，就退化成仅保存视频链接。

这条链路对 YouTube 和部分 Bilibili 视频有效，但不能满足“**不管是否有字幕，都要直接总结视频内容**”这个目标。对 Bilibili 链接 `BV1CQQRBoEax` 和 `BV1rbdJB8E5H` 的实测表明：

- 页面能拿到 `cid` / `bvid`
- 平台字幕节点存在
- 但字幕接口返回空列表，或 `need_login_subtitle = true`

这说明平台字幕是重要的快路径，但不能覆盖所有真实视频。

## 目标

为 `save_webpage` 增加一条“**音频转写兜底**”链路，使视频保存遵循以下优先级：

1. 优先使用平台原生字幕
2. 无平台字幕时，下载音频并调用 OpenAI-compatible 转写接口
3. 转写成功后基于转写文本生成摘要
4. 若转写也失败，再退回 metadata 摘要

最终保存的笔记必须同时包含：

- 视频原始链接
- `Play with Media Extended` 打开链接
- 摘要正文
- 来自转写或 metadata 的摘录

## 非目标

本轮不做以下事项：

- 不接入 Gemini 文件上传型多模态摘要
- 不引入本地 `ffmpeg` / `whisper` 命令行依赖
- 不做浏览器 Cookie 注入去拿站点登录态字幕
- 不扩展到任意网页视频站点，只处理当前已有的 YouTube / Bilibili 保存路径

## 设计选择

### 选择的方案

采用“**平台字幕优先 + OpenAI-compatible 音频转写兜底**”。

原因：

- 它和当前 provider 架构最贴近
- `OpenAIProvider` 已经有认证、`baseUrl`、`model` 这套配置模式
- 可以在不改变主聊天链路的前提下，新增独立的转写 HTTP 调用

### 不选的方案

- 只强化平台字幕：不能解决平台根本不给字幕的 Bilibili 视频
- Gemini 原生多模态：接入链路更长，且当前模型接口只接受纯文本 prompt
- 本地命令行转写：破坏移动端兼容目标，也会引入环境依赖

## 架构

### 1. `video_utils.ts` 继续负责“平台能力优先”

`src/utils/video_utils.ts` 继续负责：

- 获取视频标题、作者、canonical URL
- 尝试获取平台字幕
- 返回 `VideoTranscript`

但需要新增一个更细的状态表达：

- `text`：最终拿到的字幕/转写文本
- `description`：页面简介
- `transcriptSource`：`platform-subtitle` / `audio-transcription` / `metadata`
- `needsTranscription`：当平台字幕为空时标记为 `true`

这样 `web-clipper` 才知道该不该继续走兜底转写。

### 2. 新建 `video-transcription.ts`

新增 `src/services/video-transcription.ts`，专门负责：

- 根据视频 URL 获取可下载的音频来源
- 把音频上传到 OpenAI-compatible `/audio/transcriptions`
- 返回纯文本转写结果

该模块不感知 vault，不直接写笔记，只做“拿文本”。

### 3. 转写后端配置策略

用户已选择“**复用当前 provider**”，因此本轮不新增独立转写设置。

约束如下：

- 仅当当前 active provider 为 `openai-compatible` 时尝试走转写兜底
- 且只有当该 provider 实际支持 `/audio/transcriptions` 时，转写才会成功
- 如果当前 provider 不支持该接口，必须返回明确失败原因，并回退到 metadata 摘要，而不是静默只留链接

## 关键实现点

### A. 如何获取音频

#### YouTube

优先顺序：

1. 若平台字幕存在，直接用字幕，不走音频
2. 若平台字幕不存在，尝试从页面内嵌数据中提取可访问音频流 URL
3. 下载音频字节并上传给转写接口

如果 YouTube 页面没有稳定暴露音频流 URL，则本轮需要明确失败并回退 metadata，而不是伪装成“已总结”。

#### Bilibili

优先顺序：

1. 若 `subtitle.subtitles` 有内容，直接取字幕
2. 若 `need_login_subtitle = true` 或字幕数组为空，则尝试从 `__playinfo__` 中提取音频流 URL
3. 下载音频字节并上传给转写接口

这条路对你给的 `BV1CQQRBoEax` / `BV1rbdJB8E5H` 才是真正可解。

### B. 转写接口调用

新增一个最小内部 helper，例如：

```ts
transcribeAudio(params: {
  audioBytes: Uint8Array;
  mimeType: string;
  filename: string;
  provider: ProviderConfig;
}): Promise<string>
```

调用方式：

- 使用 `fetch`
- 构造 `FormData`
- 调用 `${baseUrl}/audio/transcriptions`
- 复用当前 provider 的 `apiKey`

响应只需要支持最常见的 OpenAI-compatible 返回：

```json
{ "text": "..." }
```

### C. `save_webpage` 的新优先级

`src/skills/builtin/web-clipper/executor.ts` 中视频保存的优先级调整为：

1. `platform subtitle`
2. `audio transcription`
3. `metadata summary`
4. `link only`

其中：

- 只要拿到了任意正文文本，就必须保存 `## Summary`
- `## Transcript Excerpt` 可以来自平台字幕或音频转写
- 如果只有 metadata，则用 `## Video Description`

## 文件边界

| 文件 | 动作 | 责任 |
|------|------|------|
| `src/utils/video_utils.ts` | Modify | 暴露字幕缺失状态、描述信息、平台优先逻辑 |
| `src/services/video-transcription.ts` | Create | 音频下载与 OpenAI-compatible 转写 |
| `src/skills/builtin/web-clipper/executor.ts` | Modify | 接入转写兜底并统一保存模板 |
| `src/mcp/types.ts` | Optional Modify | 如需最小扩展，增加转写相关开关或能力标记 |
| `test/web-clipper.test.ts` | Modify | 增加无字幕走转写兜底回归 |
| `test/video-transcription.test.ts` | Create | 音频下载与转写接口适配回归 |
| `test/video-utils.test.ts` | Create | 平台字幕缺失状态与描述提取回归 |

## 失败策略

### 用户可见行为

如果转写失败，用户最后拿到的仍然应该是：

- 视频链接
- Media Extended 链接
- metadata 摘要

而不是只剩一个 bare link。

### 开发侧日志

必须区分以下失败原因：

- 平台字幕缺失
- 音频流 URL 提取失败
- 音频下载失败
- `/audio/transcriptions` 不支持
- 转写接口返回非 200

## 风险

### 1. 当前 provider 可能不支持转写接口

这是用户主动接受的约束。实现上要把它作为“可诊断失败”，不能伪装成成功。

### 2. 平台音频流链接可能有时效性或防盗链

因此要把音频下载逻辑封装进单独服务，并给出清晰日志。

### 3. 音频文件可能过大

本轮先不做复杂分片，必要时限制文件大小或时长，并在失败时明确说明。

## 结论

如果目标是“即使没有平台字幕，也要总结视频内容”，那么只强化平台字幕不够。  
在当前架构和约束下，最合理的前进方式就是：

**平台字幕优先 + OpenAI-compatible 音频转写兜底**
