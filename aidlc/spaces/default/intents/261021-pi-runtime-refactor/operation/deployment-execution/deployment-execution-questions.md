# Deployment Execution — 澄清问题

## 背景（已核实的工作区证据）

- 本项目是 Obsidian 社区插件，发布目标为 **GitHub Release**，不是服务端/容器化部署——blue/green、canary、滚动发布等策略没有适用空间（无服务端流量可切）。
- 本 intent 的 scope 是 `refactor`，按阶段规则 `environment-provisioning` 被跳过：`operation/environment-provisioning/environment-inventory.md` 不存在是既定行为，不是缺失。本阶段改为盘点工作区真实配置。
- **依赖服务**：本项目无外部依赖服务（无数据库、无消息队列、无第三方运行时服务）。插件以单文件 `main.js` 整体替换的方式分发到每个用户的本地 Obsidian 库。
- **已落地的发布配置**（本阶段的落地动作，已完成于分支 `chore/release-v1.1.0`）：
  - 新增 `.github/workflows/release.yml`：打纯数字 tag（`[0-9]+.[0-9]+.[0-9]+`）触发，复用 `ci.yml` 的 build + test + lint 门禁，并额外校验 tag 与 `manifest.json` 版本一致，全部通过后创建 **Release draft**（附件为 `dist/main.js` / `dist/manifest.json` / `dist/styles.css`）。
  - 版本号三件套已升级至 `1.1.0`：`manifest.json`、`package.json`、`versions.json`（新增 `"1.1.0": "1.7.2"`），`package-lock.json` 已同步。
  - 改动已提交并推送至分支 `chore/release-v1.1.0`，PR **#52** 已创建且 CI 通过（`build-and-test` pass）。
- **tag 命名**：采用纯数字 `1.1.0`，与仓库既有 `1.0.0` / `1.0.1` / `1.0.2` 保持一致。注：`deployment-strategy.md` 中仍留有 `v1.1.0` 的旧表述，已由 `cd-config.md` 的修正取代；本阶段按纯数字执行。
- **`minAppVersion` 保持 `1.7.2`**：本次升级的 pi-agent-core / pi-ai 1.3.0 未引入需要更高 Obsidian API 版本的依赖。

## Q1. [release-engineering] 部署前置检查是否全部通过，可以进入发布？

CI 门禁已绿（PR #52 的 `build-and-test`）、版本号三件套一致、无外部依赖服务需要探活。`aws sts get-caller-identity` 一类的云身份检查不适用（发布目标是 GitHub Release，不经过 AWS CLI/CDK/SAM/CloudFormation）。

A. **全部通过**，可以进入发布
B. 有未通过项（请说明是哪一项、什么现象）
X. Other (please specify)

[Answer]: 全部通过

## Q2. [developer] 是否需要数据迁移或兼容性评估？

本次重构用自建会话持久化层替代了 pi 的 `SessionRepo`，会话数据落在用户 vault 内的 JSONL 文件。已安装用户 vault 里可能已有旧格式的会话文件，需要确认新版本能否读取。本项目**无数据库**，所以问题实质是"既有 JSONL 会话文件是否仍可被新版本读取"，而不是 schema 迁移。

A. **不需要迁移**：新版本可读取既有会话 JSONL，格式兼容已由既有测试覆盖
B. 需要迁移或兼容性评估（请说明范围与做法）
X. Other (please specify)

[Answer]: 不需要迁移

## Q3. [release-manager] 部署窗口与 tag 时机？

打 tag 前需要先把 PR #52 合并进 `main`（tag 必须指向包含 `manifest.json` 版本 `1.1.0` 的提交，否则 `release.yml` 的版本一致性校验会失败）。因此本次发布的"部署窗口"就是 PR #52 的合并时机。

A. **我现在合并 PR #52**；合并后你立即在 `main` 打 tag `1.1.0` 并推送，触发 release workflow
B. 稍后再合并（请说明时间）
C. 授权你自行合并 PR #52 并打 tag，全程执行
X. Other (please specify)

[Answer]: 授权你全权执行（合并 PR #52、打 tag 1.1.0、推送触发发布）

## Consolidated Summary Confirmation

- 部署前置检查全部通过：PR #52 的 `build-and-test` CI 已绿，版本号三件套（`manifest.json`/`package.json`/`versions.json`）已一致升级到 `1.1.0`，无外部依赖服务需要探活，云身份检查不适用。
- 无需数据迁移：本次重构替换的自建会话持久化层仍以 JSONL 文件读写用户 vault 内的既有会话数据，格式兼容已由现有测试覆盖。
- 部署窗口与执行方式：用户已授权全权执行——接下来将合并 PR #52 进 `main`，在 `main` 上打纯数字 tag `1.1.0` 并推送（通过 SSH，因为本环境 HTTPS 推送因代理问题不可用），触发 `.github/workflows/release.yml` 完成构建、测试、lint 门禁及 tag/manifest 版本一致性校验，并创建 Release draft。
- 已知文档差异（将记录为 Deviation，不回改上游已批准产物）：`deployment-strategy.md` 中仍有旧的 `v1.1.0` 带前缀 tag 表述，与已修正的 `cd-config.md`（纯数字 `1.1.0`）不一致；本阶段按纯数字执行，差异将写入 `deployment-log.md`。

[Answer]:
