# CD Config — Release Workflow

## 结论

新增 `.github/workflows/release.yml`，在打形如 `v*` 的 git tag 时触发：执行与现有 `ci.yml` 相同的 build+test+lint 质量门禁，通过后把构建产物打包并创建一个 **GitHub Release draft**（不自动发布，人工确认后手动点击 Publish）。

## 背景

- 现有 `.github/workflows/ci.yml`（见 `consumes_absent` 说明：本 intent scope 为 `refactor`，`ci-pipeline`/`infrastructure-design` 阶段按设计跳过，故无正式 `ci-config.md`/`infrastructure-specification.md` 产出物；本阶段改为直接核查工作区既有配置）只在 push/PR 到 `main` 时跑 build+test+lint，不含任何打包或发布步骤。
- 发布机制对应 Obsidian 社区插件标准形态：`manifest.json`（当前 `version: 1.0.2`）、`versions.json`、git tag（已有 `1.0.0`/`1.0.1`/`1.0.2`）。本仓库没有 Docker/服务器部署目标，"部署"等价于"创建一个带构建产物的 GitHub Release"。
- 用户确认：需要新增自动化 release workflow；本仓库侧仅更新自身 Release，不涉及向 `obsidian-releases` 社区仓库提交新 PR。

## Workflow 设计

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Test
        run: npm test

      - name: Lint
        run: npx eslint .

      - name: Verify tag matches manifest version
        run: |
          TAG_VERSION="${GITHUB_REF_NAME#v}"
          MANIFEST_VERSION=$(node -p "require('./manifest.json').version")
          if [ "$TAG_VERSION" != "$MANIFEST_VERSION" ]; then
            echo "Tag v$TAG_VERSION does not match manifest.json version $MANIFEST_VERSION"
            exit 1
          fi

      - name: Create Release draft
        uses: softprops/action-gh-release@v2
        with:
          draft: true
          files: |
            main.js
            manifest.json
            styles.css
```

## 要点

- **门禁复用**：release workflow 复用与 CI 相同的 build+test+lint 步骤，不降低质量门禁；新增的"Verify tag matches manifest version"步骤是本 workflow 独有的额外检查，防止打错 tag 导致发布错版本号的产物。
- **draft: true 是刻意选择**：GitHub Release 创建为草稿而非直接发布，人工确认产物无误后再手动点击 Publish——这是回滚策略（见 `rollback-runbook.md`）的前置防线，比发布后再撤回成本更低。
- **`styles.css`**：已核查，该文件存在于仓库根目录（`esbuild.config.mjs` 构建时产出），故 `files:` 清单保留该行，与 `main.js`/`manifest.json` 一并作为 Release 产物附件。
- **权限**：`permissions: contents: write` 是创建 Release 所必需的最小权限声明。

## 待办（移交给落地执行）

创建该 workflow 文件本身是 Deployment Execution 阶段的落地动作，本阶段只产出配置设计。
