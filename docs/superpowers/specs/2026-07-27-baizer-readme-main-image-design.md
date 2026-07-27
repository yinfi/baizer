# Baizer README 主图更新设计说明

## 目标

为 Baizer 的中英文 README 替换现有外链主图，生成一张与最新产品叙事一致的横向手绘插画。图片需清晰表达「采集、处理、记忆、消费」的知识闭环，并能由 `README.md` 和 `README.zh-CN.md` 共用。

## 范围

本次只新增一个仓库内 PNG 资源，并修改两份 README 的首张图片引用。不会修改插件代码、构建配置、产品能力或其他文档内容。

## 视觉与内容设计

### 画幅与风格

- 输出尺寸为 `1536x1024`，横向构图。
- 暖白纸张背景，手绘技术插画风格；铅笔与墨线质感。
- 颜色以蓝灰为主，琥珀黄只用于记忆与知识回流的强调。
- 保持留白和清晰层级，避免密集文字、真实产品截图、卡通大脑、机械手臂和插件齿轮。

### 横向知识闭环

从左到右表现以下信息流：

1. 输入源：`Web`、`Video`、`Notes`。
2. `Workbench`：代表 Obsidian 内的对话入口。
3. `Baizer AI Agent`：居中，作为克制的智能编排中枢，不使用拟人脑部或机器人形象。
4. 四阶段闭环：`CAPTURE` → `PROCESS` → `REMEMBER` → `CONSUME`。
5. 回流结果：一页结构化笔记，通过回流箭头回到中枢，标注 `Knowledge compounds`。

以小型图标或短标签体现 `Guardian`、`Skills & Tools`、`Hindsight`、`Knowledge Wiki`。英文标签必须简短、清晰，不能承载 README 的段落性说明。

## 资源与集成边界

- 实施时创建仓库内 `assets/` 目录；交付后该目录在本任务中只新增最终主图。
- 新资源路径：`assets/baizer-knowledge-loop.png`。
- `README.md` 与 `README.zh-CN.md` 首图替换为相对路径 `![Baizer knowledge loop](assets/baizer-knowledge-loop.png)`。
- 两个 README 使用同一张无中文文本的图片，避免出现跨语言不一致。
- 原有 GitHub 附件 URL 不保留在两份 README 中。

## 生成与检查

- 使用 `codex-image2` 的 `gpt-image-2` 生成新图，而非对旧图作局部编辑；原因是信息架构和中心主角均已变化。
- 候选图生成到仓库外的系统临时目录，生成时不覆盖任何已有资源；只有最终选定版本复制到 `assets/baizer-knowledge-loop.png`。完成后删除本任务的候选文件，避免产生额外仓库差异。
- 检查输出文件存在、可解码、PNG 元数据尺寸精确为 `1536x1024`，并人工检查英文标签、信息流方向、手绘风格、文字溢出和可见伪影。
- 另外将候选图按 GitHub README 常见的约 `900` 像素显示宽度查看，确认六个必需标签仍可辨认：`CAPTURE`、`PROCESS`、`REMEMBER`、`CONSUME`、`Baizer AI Agent`、`Knowledge compounds`。
- 如主标签不可读、闭环缺失或画风偏离，针对单一问题调整提示词后重新生成一个新候选文件；最多生成 3 次。若 3 次后仍未通过，不复制图片、不修改 README，并报告未满足的验收项。
- 完成后检查两个 README 的 Markdown 图片链接均指向该本地资源，并确认工作区差异仅包含目标 PNG 与这两处引用。

## 失败处理

- API 认证或参数错误：不重试，不改动 README，并报告失败原因。
- 可重试网络错误：由 CLI 的有限重试处理；若仍失败，降低质量后重试一次。
- 图像质量不符合设计：在仓库外临时目录保留本轮候选，使用针对性提示词生成新版本；总计最多 3 次，仍不合格则停止且不修改 README。

## 验收标准

1. 两份 README 均显示本地 PNG，且不再引用旧外链主图。
2. 图像直观表达从输入到回流的四阶段知识闭环。
3. 图中仅出现英文短标签，且 `CAPTURE`、`PROCESS`、`REMEMBER`、`CONSUME`、`Baizer AI Agent`、`Knowledge compounds` 均可辨认。
4. 最终资源是可解码的 `1536x1024` PNG；按约 `900` 像素显示宽度查看时，六个必需标签仍可辨认。
5. 成图符合暖白、蓝灰、琥珀黄的手绘技术插画风格，未出现禁用元素。
6. 工作区最终只新增目标 PNG 并修改两处 README 图片引用；没有候选图片残留在仓库中。
7. 改动不影响 `npm run build`，并通过 Markdown 引用与图片元数据检查。
