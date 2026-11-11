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
3. 把该 tab 的 `kind` 置为 `'feedback'`（BR1.6）——它随会话快照持久化，是重启后仍被认作
   反馈会话的唯一依据；`turnOptions.isolatedContext` 与工具可见范围（决策表 6）都从它派生
4. 激活该 tab 并聚焦输入框

## 3. 反馈 tab 的标识

| 项 | 内容 |
|---|---|
| 标题 | `t('Feedback')`（而非默认的 `Chat N`） |
| 图标 | 与入口按钮同源的 `message-square-plus`，让用户一眼分辨它不是普通对话（FR1.3） |
| 反馈标记 | `TabData.kind = 'feedback'`（BR1.6）。这是「是否反馈会话」的**唯一事实来源**——工具的可见范围（决策表 6）与 `isolatedContext` 都从它派生。写入点 `ConversationController.saveActiveTab`，恢复点 `createTabData(snapshot)`；不用内存集合，否则重启后恢复的 tab 不再是反馈会话 |
| 终态徽标 | 由**草稿存储派生**：该 tab 有 `status = submitted` 的草稿时显示已提交标记（`check` 图标 + issue 编号） |
| 徽标的承载点 | `TabBarItem` 上一个**派生的**可选字段 `feedbackOutcome?: { issueNumber: number }`，由 shell 在构建 tab bar items 时从草稿存储读一次填入。`TabBarItem` 不是持久化结构，因此不构成第二处真相 |
| 明确不做 | **不**在 `ConversationSnapshot` 上加 `feedbackOutcome` 字段。`ConversationSnapshot`（`src/ui/types.ts:66-77`）与 `TabData`（`src/ui/tabs/types.ts`）是闭合接口，`saveActiveTab`（`conversation-controller.ts:32-43`）与 `createTabData`（`tabs/tab.ts:22-33`）逐字段枚举——新增字段既不写盘也不恢复，徽标重启必丢；而且它与 `FeedbackDraft.submittedIssueNumber/Url` 重复 |

**Props / State**

```
interface FeedbackTabMarkerProps {
  kind: 'chat' | 'feedback';
  outcome?: { issueNumber: number };   // 派生自草稿存储，不持久化在快照上
  active: boolean;
}
```
标记是**纯投影**：它读会话的 `kind` 与草稿存储，不持有状态，也不参与草稿生命周期。

## 4. ChangePreviewCard 的 `external-publish` 分支（可编辑的提交预览）

这是本次唯一改动既有共享组件的部分，因此约束最严。

### 唯一权威：`request.args`

**卡片渲染标题与正文的来源，与执行提交的来源，必须是同一个对象——`request.args`。**
这不是实现细节，而是本功能对「不可撤销的公开写入」的核心不变量（BR4.2）：
用户批准的必须正是他看到的。

```
渲染：  title ← request.args.title     body ← request.args.body
编辑：  onEdit(patch) → 写回 request.args.title / request.args.body
执行：  executeApprovedAction(action, request.args, ...)
```

`request.args` 随消息快照持久化（`ApprovalRequest` 挂在消息上，`chat-controller.ts:206` 的
`adoptMessages` 只浅拷贝消息对象、`approval` 引用不变；`runApproval` 读同一对象，见
`chat-controller.ts:816`）。因此**重挂载 / 切 tab / 重启后，卡片重新渲染出来的字节与将要
提交的字节逐字节相同**。

> **早期版本在这里犯过错**：卡片按 `ChangePreview.newContent` + `ExternalPublishMeta.title`
> 渲染，而编辑只写回 `request.args`。`preview` 既不随编辑更新、本身也被持久化，于是重挂载后
> 卡片重新从 `preview` 渲染出**编辑前的旧正文**，而提交走 `request.args` 里的**新正文**——
> 稳定复现「用户批准的 ≠ 他看到的」。这正是本设计要排除的东西，产物自身违反过它。
> 现在的口径：**`preview` 不再承载任何可编辑字节**。

### 契约扩展

`ChangePreviewKind` 新增 `'external-publish'`；`ChangePreview` 新增一个可选字段，**只承载
不可编辑的元信息**：

```
interface ExternalPublishMeta {
  repo: string;                        // "yinfi/baizer"
  kind: 'new_issue' | 'issue_comment';
  issueNumber?: number;                // kind = issue_comment 时
  labels: string[];
}
```

**`ExternalPublishMeta` 里没有 `title`，正文也不放 `preview.newContent`。** 可编辑的字节一律
只存在于 `request.args`。`preview` 里保留的是 `target` / `summary` / `risk` 等既有字段，
它们不参与提交。

**不新增第二套预览渲染器**：`renderChangePreviewCard` 内按 `preview.kind` 分派，
`external-publish` 走新分支，其余 kind 走原有 diff 分支，一行不动。

### 渲染与交互

| 区域 | 内容来源 | 可编辑 |
|---|---|---|
| 摘要行 | `preview.summary`：`t('New issue in {repo}')` 或 `t('Comment on #{n}')` | — |
| 标题 | `request.args.title`，单行输入控件；`issue_comment` 时不渲染 | ✅ |
| 正文 | `request.args.body`，多行文本控件，展示全文，**不做 diff 渲染**（对外发布没有「旧内容」） | ✅ |
| 类型 / 标签 | `preview.externalPublish.labels`，只读 | — |
| 三条警告 | 公开可见 / 以发布方账号发出且留下联系方式即公开它 / 创建后无法由插件撤回；另加一句解释「即使你已关闭执行确认，本操作仍需确认」 | — |

**编辑的写回时机**：`input` 事件（带防抖）即写回 `request.args`。不做「本地 DOM 状态 + 批准时
读取」——那样一旦重挂载就丢编辑，用户可能批准一份他并没有看过的内容。

### 与既有审批卡的分支隔离（Minor 修复）

新增 kind 会改变共享组件里两处既有分支的行为，必须显式处理：

| 既有分支 | 位置 | 决定 |
|---|---|---|
| `previewSupportsEditorPreview` | `src/ui/approval-card.ts:35-40` | 该函数目前只排除 `note-rename` / `note-delete` / `plugin-command`。**把 `external-publish` 一并加入排除集合**：反馈正文没有「编辑器里的对应位置」可聚焦，🎯 按钮点了只会弹「无预览」 |
| `showApprovalPreviewInEditor` | `src/ui/shell-view.ts:1334-1335` | 它取 `preview.newContent` 当编辑器预览内容。上一条排除后这条路径不会再被 external-publish 触发；同时因为正文不再放 `preview.newContent`，即便被触发也拿不到正文（双保险） |

补一条测试：断言 `previewSupportsEditorPreview({ kind: 'external-publish', ... }) === false`，
并断言其余 kind 的返回值不变。

### Props / State

```
interface ExternalPublishPreviewProps {
  meta: ExternalPublishMeta;                            // 只读元信息
  title: string;                                        // = request.args.title
  body: string;                                         // = request.args.body
  editable: boolean;                                    // pending 时 true，running/终态时 false
  onEdit: (patch: { title?: string; body?: string }) => void;   // 写回 request.args
  warnings: string[];                                   // 三条警告 + confirmExecutions 说明
}
```

**状态约束**：仅在审批状态为 `pending` 时可编辑；`running` 与所有终态下渲染为只读（避免用户
在提交过程中改动正在传输的字节）。

### 与既有审批机制的关系

| 既有机制 | 是否复用 | 说明 |
|---|---|---|
| `approval_required` 响应检测（`pi-approval-policy.ts`） | ✅ 复用 | 工具返回该响应即触发，无条件（BR4.1） |
| `ApprovalRequest` / `ApprovalState` | ✅ 复用 | 不新增审批实体；`request.args` 既是渲染源也是提交源 |
| `ApprovalExecutionRegistry` 的 `requestId` 去重 | ✅ 复用 | 幂等第一层（BR4.4） |
| `renderApprovalCard` 的整体结构（标题、risk、动作按钮、终态） | ✅ 复用 | 只加预览分支 |
| `previewSupportsEditorPreview` | ⚠️ **扩展排除集** | 加入 `external-publish`，见上 |
| `needsApproval()` | ❌ **不改** | 确认由工具内部判定，见 BR4.1 与决策表 5 |

### 必须补的测试

1. **「编辑 → 重挂载 → 卡片显示 == 提交字节」**：编辑标题与正文 → 用同一份 `ApprovalRequest`
   重新渲染卡片 → 断言输入控件的值与 `request.args.title` / `request.args.body` 逐字符相同，
   且与 `executeApprovedAction` 收到的 args 相同。
2. **分支隔离**：`previewSupportsEditorPreview` 对 `external-publish` 返回 false，其余 kind
   返回值不变。
3. **只读态**：`running` 与终态下不出现任何可编辑控件。

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

**会话前置条件不满足时的提示**（三条都不是草稿状态，而是会话级前置条件；三者都必须给出**可区分**的明确提示，不得呈现必然失败的输入框，也不得丢弃用户已输入内容）：

| 前置条件 | 提示 | 依据 |
|---|---|---|
| 内置凭据为空 | 「反馈功能未配置」+ 指向设置页 | BR5.5 |
| `feedback` 技能被禁用或解析不到 | 「反馈功能当前不可用：feedback 技能已被禁用」+ 指向设置页的启用入口；**本轮不发起模型调用** | BR1.1 |
| LLM 不可用（模型未配置 / 网络不可达 / 请求失败） | 按原因分别提示 + 可稍后重试 | BR1.5 |

第二条尤其重要：它是 BR1.1 的 fail-closed 分支在 UI 上的落点。若这里静默继续，工具集就会退回全量（见决策表 6），反馈会话将拿到全部 vault 读工具。

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
