# Obsidian CLI 对标 Claudian 改进计划

> **For agentic workers:** REQUIRED: Use `superpowers:subagent-driven-development` (if subagents available) or `superpowers:executing-plans` to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `obsidian-cli` 从“可工作的多模型 Obsidian AI 插件”升级为“边界清晰、权限安全、可扩展的 agent runtime”。

**Architecture:** 保留当前 `KnowledgeRuntime + ToolRegistry + SkillRegistry` 的产品方向，不照搬 `claudian` 的全部复杂度；优先补齐 Skill 路由、权限确认、测试体系和 runtime 分层，再逐步拆出 provider runtime 和 chat controller 边界。

**Tech Stack:** TypeScript, Obsidian Plugin API, esbuild, CodeMirror 6, current `ToolRegistry/SkillRegistry/ModelService` stack, lightweight custom test harness.

---

## Chunk 1: 完成 Skill 架构迁移

### Task 1: Slash Command 动态路由

**Files:**
- Modify: `src/ui/chat-controller.ts`
- Modify: `src/ui/shell-view.ts`
- Modify: `src/skills/skill-registry.ts`
- Test: `test/model-service.test.ts`
- Test: `test/skill-registry.test.ts`

- [ ] **Step 1: 为 `SkillRegistry` 补齐命令枚举接口**
- [ ] **Step 2: 让 `chat-controller.ts` 优先走 `resolveByCommand()`，只保留 `/clear`、`/profile` 这类纯本地命令**
- [ ] **Step 3: 让 `shell-view.ts` 的命令补全从 `SkillRegistry` 动态生成，而不是硬编码数组**
- [ ] **Step 4: 为未命中 skill 的命令保留明确错误提示**
- [ ] **Step 5: 运行相关测试并构建**

Run: `npm run build`

### Task 2: Skill 路由补完

**Files:**
- Modify: `src/skills/skill-registry.ts`
- Modify: `src/mcp/types.ts`
- Test: `test/skill-routing.test.ts`

- [ ] **Step 1: 实现 `resolveByIntent()` 的最小关键词路由，不求聪明，先求稳定**
- [ ] **Step 2: 梳理系统提示词，减少“硬逼模型调用 `use_skill`”的脆弱提示**
- [ ] **Step 3: 给每个 builtin skill 补清晰 triggers**
- [ ] **Step 4: 验证常见场景是否会正确走 `use_skill`**
- [ ] **Step 5: 提交一个独立 commit**

Commit: `git commit -m "refactor: complete skill routing flow"`

## Chunk 2: 补齐权限与确认链路

### Task 3: 写操作权限收口

**Files:**
- Modify: `src/skills/builtin/vault-ops.ts`
- Modify: `src/skills/builtin/plugin-ctrl/executor.ts`
- Modify: `src/mcp/types.ts`
- Test: `test/vault-permissions.test.ts`
- Test: `test/plugin-tools.test.ts`

- [ ] **Step 1: 明确区分 `allowFileCreation`、`allowFileModification`、`allowPluginControl` 的生效范围**
- [ ] **Step 2: 在 `create_note`、`update_note`、`append_to_note`、`delete_note`、`rename_note` 内统一做权限判断**
- [ ] **Step 3: 修正 `confirmExecutions` 当前“开启了也直接执行”的假确认行为**
- [ ] **Step 4: 先用结构化返回值表示 `approval_required`，不要直接在工具层弹 UI**
- [ ] **Step 5: 为“允许、拒绝、需确认”三条路径补测试**
- [ ] **Step 6: 提交一个独立 commit**

Commit: `git commit -m "feat: enforce write permissions and approvals"`

### Task 4: Shell UI 确认交互

**Files:**
- Modify: `src/ui/chat-controller.ts`
- Modify: `src/ui/shell-view.ts`
- Create: `src/ui/approval-card.ts`
- Test: `test/approval-flow.test.ts`

- [ ] **Step 1: 定义 approval message 的最小数据结构**
- [ ] **Step 2: 在 chat 流里识别 `approval_required` 响应并渲染确认卡片**
- [ ] **Step 3: 用户确认后再继续执行目标 tool**
- [ ] **Step 4: 用户取消时记录明确系统消息**
- [ ] **Step 5: 构建并验证不会破坏现有流式输出**

Run: `npm run build`

## Chunk 3: 拆出更清晰的 runtime 边界

### Task 5: 从 `ModelService` 中抽出 Chat Runtime

**Files:**
- Modify: `src/services/model-service.ts`
- Modify: `src/models/interfaces.ts`
- Create: `src/runtime/chat-runtime.ts`
- Create: `src/runtime/runtime-types.ts`
- Create: `src/runtime/runtime-factory.ts`
- Test: `test/model-service.test.ts`

- [ ] **Step 1: 定义 provider-neutral 的 turn request、turn result、stream event 边界**
- [ ] **Step 2: 把 prompt 拼接、tool loop、skill activation 从 `ModelService` 拆到 `ChatRuntime`**
- [ ] **Step 3: 让 `ModelService` 回退成 provider lifecycle 和 settings facade**
- [ ] **Step 4: 保持 Gemini/OpenAI provider 接口不大改，先做兼容层**
- [ ] **Step 5: 用现有 build 和最小测试验证回归**
- [ ] **Step 6: 提交一个独立 commit**

Commit: `git commit -m "refactor: extract chat runtime from model service"`

### Task 6: Provider 能力声明

**Files:**
- Modify: `src/models/interfaces.ts`
- Modify: `src/models/gemini.ts`
- Modify: `src/models/openai.ts`
- Create: `src/runtime/provider-capabilities.ts`

- [ ] **Step 1: 为 provider 增加 capability 声明，如 thinking、tool-calls、model-list、image-context**
- [ ] **Step 2: 让 UI 根据 capability 决定展示，而不是靠 provider 名称分支**
- [ ] **Step 3: 清理 `shell-view.ts` 内部对 provider 细节的耦合**
- [ ] **Step 4: 提交一个独立 commit**

Commit: `git commit -m "refactor: add provider capability layer"`

## Chunk 4: 精简 ShellView，提升会话体验

### Task 7: 拆分 ShellView 控制职责

**Files:**
- Modify: `src/ui/shell-view.ts`
- Create: `src/ui/controllers/input-controller.ts`
- Create: `src/ui/controllers/stream-controller.ts`
- Create: `src/ui/controllers/context-controller.ts`
- Create: `src/ui/renderers/thinking-renderer.ts`
- Create: `src/ui/renderers/tool-renderer.ts`

- [ ] **Step 1: 把输入与补全逻辑拆走**
- [ ] **Step 2: 把流式 thinking/tool timeline 渲染拆走**
- [ ] **Step 3: 把 context chip 与 paste/drop 解析拆走**
- [ ] **Step 4: 保持 `ShellView` 只做装配和生命周期**
- [ ] **Step 5: 构建验证 UI 没有明显回归**

Run: `npm run build`

### Task 8: 会话与上下文预算化

**Files:**
- Modify: `src/services/context-manager.ts`
- Modify: `src/memory/memory-manager.ts`
- Create: `src/services/context-budget.ts`
- Test: `test/context-manager.test.ts`
- Test: `test/memory-manager.test.ts`

- [ ] **Step 1: 给 context 加大小、优先级、裁剪策略**
- [ ] **Step 2: 区分“即时上下文”和“长期记忆”**
- [ ] **Step 3: 对 URL 和视频内容做摘要后注入，而不是全文注入**
- [ ] **Step 4: 为超限场景补测试**
- [ ] **Step 5: 提交一个独立 commit**

Commit: `git commit -m "feat: add context budgeting and trimming"`

## Chunk 5: 测试与文档对齐

### Task 9: 清理过时测试与统一测试入口

**Files:**
- Modify: `package.json`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `test/mcp-integration.test.ts`
- Modify: `test/plugin-tools.test.ts`
- Modify: `test/functional-test.js`

- [ ] **Step 1: 删除或迁移所有 `ToolManager` 旧引用**
- [ ] **Step 2: 增加统一 `test` 脚本，至少能跑当前自定义 harness**
- [ ] **Step 3: 解决 `obsidian` 模块 mock 入口问题，让测试可直接执行**
- [ ] **Step 4: 更新 `AGENTS.md` 和 README，反映当前 `ToolRegistry/SkillRegistry/KnowledgeRuntime` 架构**
- [ ] **Step 5: 运行一次完整构建和测试**

Run: `npm run build`

Run: `npm test`

### Task 10: 补架构文档

**Files:**
- Create: `docs/architecture/runtime.md`
- Create: `docs/architecture/skills.md`
- Create: `docs/architecture/permissions.md`

- [ ] **Step 1: 记录新的 runtime 边界**
- [ ] **Step 2: 记录 skill、tool、approval 流程**
- [ ] **Step 3: 记录 provider capability 与扩展约定**
- [ ] **Step 4: 提交一个独立 commit**

Commit: `git commit -m "docs: document runtime and skill architecture"`

## Priority

1. `P0`: Chunk 1 + Chunk 2
2. `P1`: Chunk 3
3. `P1`: Chunk 5
4. `P2`: Chunk 4

## Expected Outcome

- 第一周结束后，项目会从“功能多但半迁移”变成“主链路统一、权限可信、文档一致”。
- 第二周结束后，项目会更接近 `claudian` 最值得借鉴的部分：清晰 runtime 边界和可持续扩展性。

## Reference

- `claudian` repository: <https://github.com/YishenTu/claudian>
- `src/core/CLAUDE.md`: <https://github.com/YishenTu/claudian/blob/main/src/core/CLAUDE.md>
- `src/features/chat/CLAUDE.md`: <https://github.com/YishenTu/claudian/blob/main/src/features/chat/CLAUDE.md>
- `src/providers/codex/CLAUDE.md`: <https://github.com/YishenTu/claudian/blob/main/src/providers/codex/CLAUDE.md>
