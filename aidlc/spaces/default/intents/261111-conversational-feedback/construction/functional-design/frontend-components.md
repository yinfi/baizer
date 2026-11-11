# 前端组件 —— 对话式反馈：与智能体澄清后提交 GitHub Issue

来源：`requirements.md` FR1 / FR4.1 / FR5.3 / FR5.6 / FR6.1 / FR6.2 / FR6.4 / NFR4 / NFR5；`functional-spec.md` 工作流 1/3/5/7；`entities.md` 的 `FeedbackDraft`。

本单元含 UI，故本文件适用。**新增的 UI 面只有五处**，其余全部复用既有组件：对话流、流式渲染、工具时间线、审批卡片、tab 栏、设置页框架都不重造。

## 组件层级

```
BaizerPlugin (main.ts)
├── ShellView                                     [既有] 仅新增一个头部按钮
│   └── shell-header-buttons
│       ├── shell-history-btn                     [既有]
│       ├── shell-feedback-btn                    [新增] FeedbackEntryButton
│       └── shell-settings-btn                    [既有]
├── Command "baizer:feedback"                     [新增] 命令面板入口
├── TabBar                                        [既有]
│   └── tab item                                  [扩展] 反馈 tab 的标题/图标 + 终态徽标
├── ApprovalCard                                  [既有，扩展]
│   └── ChangePreviewCard                         [既有，扩展]
│       └── external-publish 分支                  [新增] 可编辑的标题 + 正文预览
└── BaizerSettingTab                              [既有]
    └── section "feedback"                        [新增] FeedbackSettingsSection
        ├── 功能开关
        ├── 目标仓库只读展示
        ├── 凭据状态只读展示
        ├── 「测试连接」动作
        └── FeedbackDraftList                     [新增] 待提交草稿列表
```

## 1. FeedbackEntryButton（反馈入口按钮）

| 项 | 内容 |
|---|---|
| 位置 | `ShellView.createHeaderActions()` 内，与「历史」「设置」并列 |
| 构造 | 复用既有 `createHeaderActionButton(container, label, icon, cls, handler)`（`shell-view.ts:1571`） |
| icon | `message-square-plus`（与 `search` / `settings` 同为 lucide 名） |
| cls | `shell-feedback-btn` |
| label | `t('Send feedback')` —— 同时写入 `aria-label` 与 `title`（工厂方法已如此处理） |
| 键盘可达 | 由工厂方法产出的 `<button type="button">` 天然可达，无需额外处理 |
| 可见性 | 受 `settings.feedbackEnabled` 控制（BR8.2 默认开启）；关闭时按钮不渲染 |
| 行为 | `click` → `event.stopPropagation()` → `plugin.openFeedbackTab()` |

**Props / State**

```
interface FeedbackEntryButtonProps {
  enabled: boolean;          // settings.feedbackEnabled
  onActivate: () => void;    // 打开反馈 tab
}
```
无内部状态——按钮不持有任何草稿或会话状态。

## 2. 命令面板入口

| 项 | 内容 |
|---|---|
| id | `baizer:feedback`（`PLUGIN_ID` 常量拼接，不硬编码字符串） |
| name | `t('Send feedback')` |
| 行为 | 与按钮同一条路径：`plugin.openFeedbackTab()` |
| 目的 | 让用户在**笔记编辑中、Guardian 使用中**也能发起反馈，不必先打开 Workbench（FR1.2） |

`openFeedbackTab()` 的职责（供按钮与命令共用，避免两处各写一遍）：
1. 确保 Workbench 打开（既有 `activateView` 语义）
2. `tabManager.createTab()` 建一个新 tab
3. 把该 tab 标记为反馈会话（供 `turnOptions` 使用）
4. 激活该 tab 并聚焦输入框

## 3. 反馈 tab 的标识

| 项 | 内容 |
|---|---|
| 标题 | `t('Feedback')`（而非默认的 `Chat N`） |
| 图标 | 与入口按钮同源的 `message-square-plus`，让用户一眼分辨它不是普通对话（FR1.3） |
| 终态徽标 | 会话记录含 `feedbackOutcome` 时，标签上显示已提交标记（`check` 图标 + issue 编号） |
| 数据来源 | `ConversationSnapshot.feedbackOutcome`（可选字段，见 `functional-spec.md` 状态机 2） |

**Props / State**

```
interface FeedbackTabMarkerProps {
  outcome?: { issueNumber: number; issueUrl: string; submittedAt: number };
  active: boolean;
}
```
标记是**纯投影**：它读会话快照，不持有状态，也不参与草稿生命周期。

## 4. ChangePreviewCard 的 `external-publish` 分支（可编辑的提交预览）

这是本次唯一改动既有共享组件的部分，因此约束最严。

### 契约扩展

`ChangePreviewKind` 新增 `'external-publish'`；`ChangePreview` 新增一个可选字段承载对外发布的元信息：

```
interface ExternalPublishMeta {
  repo: string;                        // "yinfi/baizer"
  kind: 'new_issue' | 'issue_comment';
  title?: string;                      // kind = new_issue 时
  issueNumber?: number;                // kind = issue_comment 时
  labels: string[];
}
```

正文沿用既有的 `newContent` 字段（渲染后的正文全文）。**不新增第二套预览渲染器**：`renderChangePreviewCard` 内按 `preview.kind` 分派，`external-publish` 走新分支，其余 kind 走原有 diff 分支，一行不动。

### 渲染与交互

| 区域 | 内容 | 可编辑 |
|---|---|---|
| 摘要行 | `t('New issue in {repo}')` 或 `t('Comment on #{n}')` | — |
| 标题 | `new_issue` 时渲染为单行输入控件；`issue_comment` 时不渲染 | ✅ |
| 正文 | 多行文本控件，展示 `newContent` 全文，**不做 diff 渲染**（对外发布没有「旧内容」） | ✅ |
| 类型 / 标签 | 只读展示 | — |
| 三条警告 | 公开可见 / 以发布方账号发出且留下联系方式即公开它 / 创建后无法由插件撤回；另加一句解释「即使你已关闭执行确认，本操作仍需确认」 | — |

**编辑值的归属**：编辑在 `input` 事件上（带防抖）写回 `request.args.title` / `request.args.body`。`request.args` 随消息快照持久化，因此重挂载、切 tab、重启后编辑不丢；执行时 `executeApprovedAction(action, request.args, ...)` 天然以编辑后的值为准（BR4.2）。

**为什么不做「本地 DOM 状态 + 批准时读取」**：那样一旦重挂载就会丢编辑，用户可能批准一份他并没有看过的内容——对一个不可撤销的公开写操作，这是不可接受的偏差。

### Props / State

```
interface ExternalPublishPreviewProps {
  meta: ExternalPublishMeta;
  body: string;
  editable: boolean;                                   // pending 时 true，running/终态时 false
  onEdit: (patch: { title?: string; body?: string }) => void;  // 写回 request.args
  warnings: string[];                                  // 三条警告 + confirmExecutions 说明
}
```

**状态约束**：仅在审批状态为 `pending` 时可编辑；`running` 与所有终态下渲染为只读（避免用户在提交过程中改动正在传输的字节）。

### 与既有审批机制的关系

| 既有机制 | 是否复用 | 说明 |
|---|---|---|
| `approval_required` 响应检测（`pi-approval-policy.ts`） | ✅ 复用 | 工具返回该响应即触发，无条件（BR4.1） |
| `ApprovalRequest` / `ApprovalState` | ✅ 复用 | 不新增审批实体 |
| `ApprovalExecutionRegistry` 的 `requestId` 去重 | ✅ 复用 | 幂等第一层（BR4.4） |
| `renderApprovalCard` 的整体结构（标题、risk、动作按钮、终态） | ✅ 复用 | 只加预览分支 |
| `needsApproval()` | ❌ **不改** | 确认由工具内部判定，见 BR4.1 与决策表 5 |

## 5. FeedbackDraftList（待提交草稿列表）

| 项 | 内容 |
|---|---|
| 位置 | 设置页 `feedback` 分区内 |
| 目的 | 满足 FR5.6「用户可查看、重试、删除暂存项」，并让被孤立的草稿（所属 tab 已关闭）仍可被发现 |
| 行内容 | 类型标签 / 标题（或「#编号 的评论」）/ 状态 / 最后错误分类 / 更新时间 |
| 行动作 | 「重试」/「删除」/「打开所属会话」 |
| 上限展示 | 顶部显示 `{n} / 20`，达上限时给出清理提示（BR5.4） |
| 空态 | 不渲染该列表（避免设置页出现一块空区域） |

**Props / State**

```
interface FeedbackDraftListProps {
  drafts: FeedbackDraftSummary[];   // 仅展示字段，不含 body 全文
  cap: number;                      // 20
  onRetry: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenConversation: (id: string) => void;
}
```

**为什么用「摘要」而不是完整草稿**：列表不需要正文全文，把长文本带进设置页 DOM 既慢又无意义；完整内容在所属会话与审批卡片里看。

## 6. FeedbackSettingsSection（设置页 `feedback` 分区）

与现有 11 个分区同构（`src/settings.ts:315-325` 的声明式分区表），`keywords` 含中英文两套。

| 项 | 控件 | 约束 |
|---|---|---|
| `feedbackEnabled` | toggle | 默认开启（BR8.2，可否决） |
| 目标仓库 | 只读文本 `https://github.com/yinfi/baizer` | 无配置项（FR3.3） |
| 凭据状态 | 只读文本：「已内置」/「未配置」 | **无输入框、不回显 token**（BR8.1 / FR6.3） |
| 测试连接 | 动作按钮 | 结果按类报错且不回显 token（BR8.3） |
| 待提交草稿 | `FeedbackDraftList` | 见上 |

**「测试连接」的交互流**

```
1. 点击 → 按钮进入 loading，禁用重复点击
2. 经鉴权 GET /repos/yinfi/baizer
3. 2xx → 「连接正常：凭据有效、仓库可达、Issues 已开启」
4. 非 2xx → 按决策表 1 的分类给出具体失败项与原因（401 / 403 / 404 / 网络）
5. 任何情况下都不在 UI 上输出 token 或其任何片段
```

## 7. 交互流（端到端）

```
入口            澄清                确认                    结果
────────────────────────────────────────────────────────────────────
头部按钮  ┐
命令面板  ┼→ 反馈 tab → 多轮对话 → 审批卡片（可编辑）→ 批准 → 回显编号与链接
          │              ↓              ↓ 拒绝                    ↓
          │        检索候选并选择    回到 draft（保留）      会话置终态徽标
          │              ↓                                      ↓
          └──────── 安全漏洞改道          失败 → 暂存 → 设置页草稿列表（重试/删除）
```

**状态在 UI 上的投影（单一事实来源 = `FeedbackDraft.status`）**

| `status` | tab 上的表现 | 草稿列表中的表现 |
|---|---|---|
| `draft` | 正常对话，无特殊标识 | 不出现（尚无载荷） |
| `awaiting_confirmation` | 审批卡片为 `pending`，可编辑 | 「待确认」 |
| `submitting` | 审批卡片为 `running`，按钮禁用 | 「提交中」 |
| `submitted` | 卡片终态「已提交」+ 链接；tab 显示终态徽标 | 不出现（已裁剪） |
| `failed` | 卡片终态「失败」+ 分类原因 + 重试按钮 | 「待重试」+ 最后错误分类 |

## 8. 表单校验规则

| 字段 | 规则 | 违反时 |
|---|---|---|
| 标题 | 非空、单行（换行折叠为空格，BR3.3） | 批准按钮禁用 + 提示「标题不能为空」 |
| 正文 | 非空 | 批准按钮禁用 + 提示「正文不能为空」 |
| 正文长度 | **不设上限**（FR6.6 要求不因长度截断；API 走 JSON 正文，不受 URL 长度约束） | — |

校验在客户端做，是**体验优化**而非安全边界：服务端（GitHub）的 `422` 仍按决策表 1 分类回显（BR5.1）。

## 9. 可访问性（NFR5）

- 入口按钮：`aria-label` + `title`，键盘可达（复用 `createHeaderActionButton`）
- 审批卡片：既有结构已具备 `role="status"` / `aria-live` / `tabindex="-1"`（`approval-card.ts:236-239`），新增的可编辑控件必须带显式 `aria-label`（标题输入 / 正文输入）
- 卡片状态不只靠颜色表达：`pending` / `running` / 终态各有文本标签，沿用既有做法
- 草稿列表：每行动作为真实 `<button>`，带 `aria-label` 含草稿标题，避免只靠图标

## 10. 国际化（NFR4）

全部新增用户可见文案走 `t()` 并补 `zh` / `en` 两份，不硬编码中文字符串。需要新增的键（按 `src/i18n/zh.ts` 的既有风格，key 为英文原文）：

```
'Send feedback' / 'Feedback' / 'New issue in {repo}' / 'Comment on #{n}'
'This will be public' / 'Posted as the maintainer account' / 'Cannot be withdrawn'
'Why confirm when execution confirmation is off?' / 'Test connection' / 'Credentials' / 'Built in' / 'Not configured'
'Pending drafts' / 'Retry' / 'Delete' / 'Open conversation'
```

**注意**：三条警告的文案属于安全相关文案，`zh` / `en` 两份必须表达同一组事实（公开可见 / 以发布方账号发出且留下联系方式即公开它 / 不可撤回），不得为了简洁省略任何一条（BR4.3）。
