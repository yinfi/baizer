# Deployment Strategy

## 结论

版本号从 `1.0.2` 升级到 `1.1.0`（Minor 版本），通过打 `v1.1.0` tag 触发 `release.yml` 生成 Release draft，人工核对后手动 Publish。不采用 blue/green、canary 或滚动发布策略——Obsidian 插件没有服务端部署目标，发布即"用户客户端拉取到新版本"。

## 背景

- 本次 intent（`261021-pi-runtime-refactor`）是对 `@earendil-works/pi-agent-core`/`pi-ai` 从 0.75.5 到 1.3.0 的内部运行时升级 + 自建会话持久化层替代被移除的 `SessionRepo`，属于内部重构，未改变插件对外可见的功能行为或用户数据格式。
- Semver 惯例下，无破坏性变更、无新增对外功能的重构型发布应选 Patch；但用户已明确选择 Minor（`1.0.2 → 1.1.0`），采纳该决策。

## 版本号策略

1. 更新 `manifest.json` 的 `version` 字段：`1.0.2 → 1.1.0`。
2. 更新 `package.json` 的 `version` 字段：同步为 `1.1.0`（两处版本号字段保持一致是仓库既有不变量，由 `test/release-guidelines.test.ts` 的 minAppVersion/versions.json 一致性检查间接守护）。
3. 更新 `versions.json`：新增 `"1.1.0": "<minAppVersion>"` 映射条目（`minAppVersion` 取 `manifest.json` 当前声明的 `1.7.2`，除非本次升级引入了需要更高 Obsidian API 版本的依赖——需在落地前核实 pi-agent-core 1.3.0 是否有此类要求）。
4. 打 tag：`git tag v1.1.0` → `git push origin v1.1.0`。

## 发布流程

```
更新版本号三件套（manifest.json / package.json / versions.json）
  → 提交 commit（遵循 Conventional Commits，如 "chore(release): bump version to 1.1.0"）
  → 打 tag v1.1.0 并推送
  → release.yml 自动触发：build + test + lint + tag/manifest 版本一致性校验
  → 门禁通过后生成 Release draft，附带 main.js / manifest.json / styles.css
  → 人工核对 draft 内容（版本号、附件完整性、Release Notes）
  → 手动点击 Publish
  → Obsidian 客户端 / 社区插件市场在后续检测周期内感知到新版本
```

## 不采用的策略及理由

- **Blue/Green、Canary、滚动发布**：均要求存在可独立切流量的多个运行实例，Obsidian 插件以用户本地客户端为运行环境，没有服务端流量概念，故不适用。此结论对应 `org.md` Deployment 章节默认策略在"无服务端环境"场景下的退化形式——没有环境可切，发布即生效。
- **自动发布（无人工 Publish 环节）**：Release 保持 `draft: true` 是刻意设计，详见 `cd-config.md`；发布漏洞一旦面向用户客户端分发，撤回成本远高于一次 Publish 前的人工核对，故保留该人工关卡。

## 验证

- 构建/测试/lint 门禁已在 `release.yml` 中复用 `ci.yml` 的现有步骤（见 `cd-config.md`），不重新设计验证逻辑。
- 发布成功的健康检查标准：Release 页面产物齐全（`main.js`/`manifest.json`/`styles.css` 三文件均存在且非空）、tag 版本与 `manifest.json` 版本一致（workflow 内置校验步骤）。
