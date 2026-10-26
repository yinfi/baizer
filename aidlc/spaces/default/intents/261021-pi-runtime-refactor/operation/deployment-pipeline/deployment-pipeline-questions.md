# Deployment Pipeline — 澄清问题

## 背景（已核实的工作区证据）

本项目是 Obsidian 社区插件（brownfield），不是服务端/容器化服务：

- 现有 CI（`.github/workflows/ci.yml`）只做 `npm ci` → build → test → lint，**不含任何部署步骤**。
- 发布机制是 Obsidian 插件的标准形态：`manifest.json`/`versions.json` 声明版本号 → 打 git tag → 创建 GitHub Release 并附加 `main.js`/`manifest.json`/`styles.css` → 用户或 Obsidian 内置插件市场拉取更新；社区插件市场收录的插件由 Obsidian 审核团队的 `obsidian-releases` 仓库同步，不受本仓库控制。
- 没有 blue/green、canary、滚动发布等服务器部署概念的适用空间——插件以单文件 `main.js` 整体替换的方式"部署"到每个用户的本地 Obsidian 库。
- 本 intent 的 scope 是 `refactor`，按阶段文件 Step 1 规则，`ci-pipeline`（3.7）与 `infrastructure-design`（3.4）按设计被跳过，CD 流水线、质量门禁、基础设施规格、CI/CD 配置这 4 份预期上游产物均不存在——这是该 scope 的既定行为，不是缺失。
- 当前版本：`manifest.json` version `1.0.2`，已有 git tag `1.0.0`/`1.0.1`/`1.0.2`。`test/release-guidelines.test.ts` 已覆盖并通过版本一致性等 Obsidian 审核规范检查。

## 问题

**[Q1] 本次升级（pi-agent-core/pi-ai 0.75.5→1.3.0 + 自建会话持久化层）发布后的版本号策略？**

A. **Patch 版本**（如 1.0.2 → 1.0.3）—— 对用户可见行为无变化，纯内部依赖升级+重构
B. **Minor 版本**（如 1.0.2 → 1.1.0）—— 视为功能性变更（新增会话分叉/重试等能力）
C. 由你指定具体版本号
X. Other (please specify)

[Answer]: B. Minor 版本（如 1.0.2 → 1.1.0）

**[Q2] 发布前是否需要新增/修改 GitHub Actions workflow（例如自动打包发布产物、自动创建 Release draft）？**

A. **不需要**，沿用现有手动发布流程（本地 build → 手动创建 GitHub Release → 手动上传产物）
B. 需要，新增一个 release workflow（在打 tag 时自动构建并创建 Release draft）
X. Other (please specify)

[Answer]: B. 需要新增 release workflow（打 tag 时自动构建并创建 Release draft）

**[Q3] 回滚策略——如果发布后发现问题，用户侧如何回退？**

A. **依赖 Obsidian 内置插件版本历史**（用户手动降级插件版本，无需本仓库额外动作），本仓库侧的处置是撤回/编辑 GitHub Release 并发布修复版本
B. 需要在 rollback-runbook 中额外记录別的具体步骤（请说明）
X. Other (please specify)

[Answer]: A. 依赖 Obsidian 内置插件版本历史（用户手动降级插件版本，无需本仓库额外动作），本仓库侧的处置是撤回/编辑 GitHub Release 并发布修复版本

**[Q4] 本次发布是否需要在社区插件市场（`obsidian-releases` PR）同步提交，还是仅更新本仓库的 Release？**

A. **仅更新本仓库 Release**（本插件已在社区插件市场收录，版本升级无需重新提交 PR，Obsidian 会自动检测新 Release）
B. 需要额外的社区插件市场同步步骤（请说明）
X. Other (please specify)

[Answer]: A. 仅更新本仓库 Release（本插件已在社区插件市场收录，版本升级无需重新提交 PR，Obsidian 会自动检测新 Release）

## Consolidated Summary Confirmation

基于以上四个回答的理解：版本号 Minor 升级到 1.1.0；新增 `.github/workflows/release.yml`，打 tag 时自动构建并创建 Release draft；回滚依赖 Obsidian 客户端版本历史，仓库侧撤回/编辑 Release 并发布修复版本；仅更新本仓库 Release，不向 `obsidian-releases` 提交 PR。已据此生成 `cd-config.md`/`deployment-strategy.md`/`rollback-runbook.md` 三份产出物。

Does this all look correct?

[Answer]: Looks correct
