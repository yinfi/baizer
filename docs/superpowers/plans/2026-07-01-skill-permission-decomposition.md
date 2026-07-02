# Skill 管理与权限管理解耦 —— 迁移到 pi-agent 原生能力

**Date:** 2026-07-01
**Project:** baizer
**Status:** Plan, pending implementation

## 目标

把现有自研 skill 管理迁移到 pi-agent-core 已有能力上，并把揉在一起的两个关注点拆成正交的两层：

1. **Skill 管理层**：skill 的加载、解析、发现、系统提示格式化、激活，全部改用 pi 原生原语（`Skill` 类型、`loadSkills`、`formatSkillsForSystemPrompt`、`formatSkillInvocation`），删除自研的重复 YAML 解析器与手写格式化器。
2. **权限管理层**：把散落在 10+ 个工具体内的审批判断、adapter 里的工具门控、settings 里的写入范围判定，归拢成一个 `PermissionService`；策略由配置页设置驱动，代码不写死。
3. **两个独立控制面**：配置页新增 `🧩 Skills`（skill 是否可用），与已有的 `⚡ Permissions`（读写权限）解耦——可用性与安全性各管各的。

## 现状与问题

**三处冗余/耦合（已核实）：**

1. **自研 skill 系统重复造轮子**：`skill-registry.ts` 与 `skill-loader.ts` 各有一份 `parseSimpleYaml`/`parseYamlValue`（~110 行），而项目已依赖 `yaml@2.8.3`。pi 原生 `loadSkills`/`formatSkillsForSystemPrompt`/`formatSkillInvocation` 提供了目录扫描、校验、系统提示格式化、激活格式化。
2. **审批逻辑长在工具体内**：`if (ctx.settings.confirmExecutions && !args.approved)` 在 `vault-ops.ts`/`plugin-ctrl.ts` 里逐字复制 10+ 次。工具因此必须“知道”审批存在，不再是纯原子操作。`Tool.risk` 字段（read/write/plugin-control/network）已声明却未参与审批决策。
3. **skill 可用性被权限设置绑架**：`main.ts:96` 用 `(settings) => settings.allowPluginControl` 决定 plugin-ctrl skill 是否可用。关掉插件写权限，整个 skill 连同只读的 `list_plugins` 指引一起消失——可用性被安全性劫持。

**pi 能力边界（已核实）：**

- pi 原生 `Skill = { name, description, content, filePath, disableModelInvocation }`——无 `tools`、无 `triggers`、无 `executor`。pi 刻意不把工具权限耦合进 skill。
- pi **有**权限原语：`setActiveTools()`/`activeToolNames`（准入）、`tool_call` 钩子返回 `ToolCallResult{block, reason}`（执行前审批）。裸 `agentLoop` 路径用 `prepareNextTurn` 换 `context.tools` + adapter 包装等效实现。
- built-in skill 是 esbuild text-loader 打进 bundle 的**字符串**，不是 vault 文件；pi `loadSkills` 只从 `env` 读文件。故 built-in 走自建 `parseBuiltinSkill`（复用 `yaml`），user skill 才走 `loadSkills`。

## 架构：两层 + 两控制面

```
┌─ Skill 管理层（纯内容，零副作用）──┐   ┌─ 权限管理层（纯准入，不关心内容）─┐
│ Skill = pi { name, description,   │   │ PermissionService.check(          │
│              content, filePath }   │   │   toolName, args, risk, settings, │
│ 加载: parseBuiltinSkill / loadSkills│  │   allowedToolNames)               │
│ 清单: formatSkillsForSystemPrompt  │   │  → allow | needs-approval | deny  │
│ 激活: formatSkillInvocation        │   │ 落地: pi tool_call hook / adapter │
│ sidecar: { tools, triggers }       │──▶│ 准入: skill.tools → setActiveTools│
└────────────────────────────────────┘   └────────────────────────────────────┘
         ▲ 可用性                                  ▲ 安全性
┌─ 🧩 Skills 控制面（新增）─────────┐   ┌─ ⚡ Permissions 控制面（已有）───┐
│ disabledSkills: string[]           │   │ vaultWriteScope / allowFile*      │
│ 逐个 skill 开关，默认全开          │   │ allowPluginControl / confirmExec  │
│ 决定: 进不进系统提示 / 能否激活    │   │ 决定: 工具能否执行 / 要不要批     │
└────────────────────────────────────┘   └────────────────────────────────────┘
```

**正交准则**：skill 是否可用，只由 `🧩 Skills` 里它自己的开关决定；它暴露的工具能否执行/要不要批，只由 `⚡ Permissions` 决定。skill 开着 ≠ 其工具免批执行。

## Skill 管理层设计

**新增 `src/skills/pi-skill-source.ts`**：把 bundled SKILL.md 字符串解析成 pi `Skill` + sidecar。

```typescript
import { parse } from 'yaml';
import type { Skill as PiSkill } from '@earendil-works/pi-agent-core';

export interface SkillSidecar {
  tools: string[];
  triggers?: { commands?: string[]; keywords?: string[] };
  executionMode?: 'direct' | 'instructions';
}
export interface LoadedSkill { skill: PiSkill; sidecar: SkillSidecar; }

export function parseBuiltinSkill(md: string, filePath: string): LoadedSkill | null {
  const m = md.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fm = m ? (parse(m[1]) ?? {}) : {};
  const body = (m ? m[2] : md).trim();
  if (!fm.name || !fm.description) return null;
  return {
    skill: { name: fm.name, description: fm.description, content: body,
             filePath, disableModelInvocation: fm['disable-model-invocation'] === true },
    sidecar: { tools: fm.tools ?? [], triggers: fm.triggers,
               executionMode: fm.mode === 'simple' ? 'direct' : 'instructions' },
  };
}
```

**改造 `SkillRegistry`**：
- 内部 `Map<string, LoadedSkill>`，取代 `BuiltinSkill`/`UserSkill` 类。
- 删 `parseFrontmatter`/`parseSimpleYaml`/`parseYamlValue`（registry 一份）。
- `getSkillSummaryText()` → `formatSkillsForSystemPrompt(skills.map(s => s.skill))`。
- `activateSkill(name)`：instructions → `formatSkillInvocation(loaded.skill)`；tools 从 `sidecar.tools` 取，**交给权限层**（不再进 adapter 私有 `allowedToolNames`）。
- `resolveByCommand`/`resolveByIntent` 改读 `sidecar.triggers`（逻辑不变，换数据源）。
- `isEnabled()` 改读 `settings.disabledSkills`（见控制面），`enabled` 不再吃 settings 函数。

**（Stage 2）用户 skill 目录**：改用 pi `loadSkills(env, USER_SKILLS_DIR)`，需给 `VaultSessionFileSystem` 补 `fileInfo`/`canonicalPath`/`Shell` 占位，删 `SkillLoader`（199 行）。

## 权限管理层设计

**原则：PermissionService 不含策略常量，只读配置页设置执行。** 策略 = `⚡ Permissions` 的 6 个设置。

**新增 `src/permissions/permission-service.ts`**：

```typescript
export type PermissionVerdict =
  | { kind: 'allow' }
  | { kind: 'needs-approval'; action: string; target: string; risk: string }
  | { kind: 'deny'; reason: string };

export interface PermissionInput {
  toolName: string; args: any; risk: ToolRisk;
  settings: PluginSettings;
  allowedToolNames: Set<string> | null;  // 激活 skill 的准入白名单，null=全量
}

export class PermissionService {
  check(i: PermissionInput): PermissionVerdict {
    // 1) 准入：不在激活 skill 白名单内 → deny（取代 adapter 的 skillScope 判断）
    if (i.allowedToolNames && !i.allowedToolNames.has(i.toolName))
      return { kind: 'deny', reason: `Tool "${i.toolName}" not available for active skill` };
    // 2) 写入范围：write 类工具受 vaultWriteScope/allowFile* 限制 → deny（搬现有强制点，Stage 3 前先追准）
    const scopeDeny = this.checkWriteScope(i);
    if (scopeDeny) return scopeDeny;
    // 3) 审批：按 risk × confirmExecutions 决策（取代 10+ 工具体硬编码，逐行复刻现状）
    if (this.needsApproval(i.risk, i.settings) && !i.args?.approved)
      return { kind: 'needs-approval', action: i.toolName, target: extractTarget(i.args), risk: mapRisk(i.risk) };
    return { kind: 'allow' };
  }

  // 严格复刻现状 + 按 risk 分类。confirmExecutions 关=全自动。
  private needsApproval(risk: ToolRisk, s: PluginSettings): boolean {
    if (!s.confirmExecutions) return false;
    if (risk === 'read' || risk === 'network') return false;   // 只读/搜索免批（与现状一致）
    return risk === 'write' || risk === 'plugin-control';       // 与现状一致
  }
}
```

**接线（裸 agentLoop 路径）**：`pi-tool-adapter.ts` 的 `executeBaizerTool` 前置一道 gate——`use_skill` 直通；其余先 `permissionService.check()`，`deny→{error}`、`needs-approval→{approval_required,...}`、`allow→toolRegistry.execute`。`approval_required→terminate` 链路与回批路径（`executeApprovedAction(approved:true)`）完全不变。若走 AgentHarness 则改挂 `tool_call` 钩子返回 `{block, reason}`，等价。

**工具体清理**：删 vault-ops/plugin-ctrl 里 10+ 处 `if (confirmExecutions && !approved)` 块。`risk` 声明保留——现在真正被权限层消费。

## 两个独立控制面

**断掉现有耦合**：删 `main.ts:96` 的 `(settings) => settings.allowPluginControl`。plugin-ctrl 降为普通 skill，可用性归 `🧩 Skills`。

**新增 skill 可用性设置**（`mcp/types.ts`）：
```typescript
disabledSkills: string[];   // DEFAULT: []  —— 空 = 全开，零迁移成本
```
`SkillRegistry.isEnabled(skill)` → `!settings.disabledSkills.includes(skill.name)`。

**配置页新增 `🧩 Skills` 区块**（`settings.ts`）：遍历所有已注册 skill（内置 + 用户），每个一个 toggle，写入 `disabledSkills`。纯新增 UI，不动 `⚡ Permissions`。

**解耦后行为**（已确认）：关掉 `allowPluginControl` 但 plugin-ctrl skill 开着时——模型能看到操作插件的指引、能激活 skill、能调只读 `list_plugins`；`execute_plugin_command` 等写操作被权限层拦（deny/审批）。可用性与安全性各管各的。

## 分阶段实施

| Stage | 内容 | 风险 | 行为 |
|---|---|---|---|
| **1** | pi-skill-source + SkillRegistry 改用 pi Skill/formatters；删 registry 内 YAML；`disabledSkills` 设置 + `🧩 Skills` 控制面；断 plugin-ctrl 耦合 | 低 | skill 可用性解耦，其余不变 |
| **2** | 新增 PermissionService；adapter 前置 gate；删 10+ 工具体审批块；`risk` 接入决策 | 中 | 审批行为严格等价，逻辑集中 |
| **3** | user skill 改用 pi `loadSkills`（补 FS env）；删 SkillLoader | 中 | 用户 skill 加载对齐 pi |

每个 Stage 独立可交付、可测、可回滚。Stage 1、2 达成核心目标（skill 管理跑在 pi 能力上 + 两层两控制面解耦）。

## 搬迁对照表

| 代码 | 现在在哪 | 拆分后 |
|---|---|---|
| `parseSimpleYaml`/`parseYamlValue` ×2 | skill-registry + skill-loader | **删**，用 `yaml` 依赖 |
| skill 清单格式化 | `getSkillSummaryText`（手写 md） | `formatSkillsForSystemPrompt`（pi） |
| skill 激活指令 | `use_skill` 拼 instructions | `formatSkillInvocation`（pi） |
| 目录扫描/校验 | `SkillLoader`（199 行） | pi `loadSkills`（Stage 3） |
| `if (confirmExecutions && !approved)` ×10 | vault-ops/plugin-ctrl 工具体 | **删**，归 `PermissionService.needsApproval` |
| `vaultWriteScope` 判定 | settings.ts:491/513 + 工具内 | `PermissionService.checkWriteScope`（先追准） |
| `skillScope`/`allowedToolNames` 门控 | pi-tool-adapter | `PermissionService`（准入分支） |
| `Tool.risk` | 仅喂 `inferToolExecutionMode` | **额外**成审批决策主输入 |
| plugin-ctrl 可用性绑权限 | main.ts:96 `enabledFn` | **删**，归 `disabledSkills` |
| `approval_required→terminate` | pi-approval-policy + adapter | **不动**（层间契约保持） |

## 测试计划

- **Stage 1**：`skill-registry.test.ts`/`skill-routing.test.ts`/`skill-files.test.ts` 按 pi 格式更新断言（系统提示块变 `<available_skills>` XML）；新增 `disabledSkills` 过滤用例。
- **Stage 2**：新增 `permission-service.test.ts`——`risk × confirmExecutions × allowedToolNames` 决策矩阵；回归 `approval-flow.test.ts` 验证审批链路等价；确认工具体删审批后仍受 gate 保护。
- **Stage 3**：`skill-files.test.ts` 覆盖 pi `loadSkills` 路径 + FS env 适配。
- 全量：`npm run build` + `npm test`；移动端约束——src 零新增 Node API import。

## 决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| built-in skill 是否落盘走 pi loadSkills | 否，走 `parseBuiltinSkill` 解析 bundled 字符串 | built-in 是编译期字符串，落盘污染 vault |
| 审批策略是否代码写死 | 否，`PermissionService` 纯读配置页设置 | 用户要求可配置，与现状一致 |
| skill 可用性与读写权限 | 拆成 `🧩 Skills` / `⚡ Permissions` 两控制面 | 可用性 ≠ 安全性，正交 |
| `risk` 是否参与审批 | 是，升级为决策输入 | 消除工具体硬编码，字段名副其实 |
| 写入范围强制点是否本次搬迁 | 先追清现有强制点再搬 | 不凭假设搬，防行为走样 |
| 是否整体迁 AgentHarness | 否，本次只迁 skill 层 | 范围收窄；provider/session 现状自洽 |
