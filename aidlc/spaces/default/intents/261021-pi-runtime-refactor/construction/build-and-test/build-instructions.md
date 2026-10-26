# Build Instructions —— pi 运行时底座重构

来源：`code-generation-plan.md`、`code-summary.md`（已创建/修改文件清单与构建相关决策）、`unit-test-instructions.md`（单元测试运行命令，见下方全量回归命令）。

## 依赖安装

```
npm install
```

`package.json` 已将 `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai` 锁定为精确版本 `1.3.0`（无 `^`），`package-lock.json` 已随之更新，无需额外步骤。

## 环境准备

本次改造不引入新的环境变量、配置文件或本地服务依赖：

- 无需 `.env` 或新增配置文件
- 无需启动任何本地服务（数据库、mock server 等）
- 测试运行器（`test/run-tests.ts`）与既有 `tsconfig.test.json` 的 `obsidian` mock 路径映射保持不变

## 构建命令

```
npm run build
```

底层调用 `esbuild.config.mjs`（esbuild 0.17.19），产出单文件 `dist/main.js`。该配置文件本次新增/修改了四个插件（详见 `code-summary.md` Step 5.1 小节）：

- `strip-json-import-attributes`：剥除 pi-ai 1.3.0 源码里 esbuild 0.17.19 无法解析的 `import ... with { type: "json" }` 语法
- `stub-unused-pi-providers`：存根 40 个未使用的 pi provider（仅保留 `google.js`/`openai.js`）
- `stub-unused-pi-apis`：存根 7 个未使用的 pi api 实现（仅保留 `google-generative-ai`/`openai-completions`/`openai-responses`）
- `stub-node-builtin-dynamic-imports`：中和 Electron 渲染进程里的 Node 内置动态导入分支，避免启动期 unhandled rejection

类型检查（构建不含类型检查，需单独运行）：

```
npx tsc -p tsconfig.json --noEmit
```

## 构建验证步骤

1. `npm run build` 退出码为 0，且 `dist/main.js` 文件生成
2. `npx tsc -p tsconfig.json --noEmit` 输出 0 个错误
3. 运行 `npx tsx test/run-tests.ts`（`unit-test-instructions.md` 记录的全量回归命令，含 `test/bundle-size.test.ts`）确认：
   - `dist/main.js` < 5 MB 硬限（Obsidian Sync 限制，NFR1，不可调整）
   - `dist/main.js` < 4.8 MB 仓库自设软预算（人工已确认采用的新阈值，见 `code-summary.md`「体积预算决策」）
   - 包内不含未使用 provider SDK 的路径标记（如 `@mistralai/mistralai`）

## 常见构建问题排查

| 现象 | 根因 | 处置 |
|---|---|---|
| esbuild 报 `Expected ";" but found "with"` | pi-ai 1.3.0 源码的 `with { type: "json" }` 语法，esbuild 0.17.19 不支持 | 确认 `strip-json-import-attributes` 插件已启用且未被移除 |
| esbuild 报 `No matching export` | 存根插件的导出名与 `all.js`/`compat.js` 的 import 名不一致 | 核对 `esbuild.config.mjs` 里 `STUBBED_PI_PROVIDERS`/`STUBBED_PI_APIS` 的导出名，必须逐字匹配实际 import 名 |
| 构建成功但插件运行期崩溃（`xxx is not a function`） | 存根返回值语义不对（如旧版"调用即抛错"写法在 1.3.0 顶层初始化时就会触发） | 核对存根是否返回"惰性占位 provider/api"而非直接抛错的对象，参考 `code-summary.md` Step 5.1②的返回值语义说明 |
| `dist/main.js` 体积超过 4.8 MB | 新增了未经存根处理的 provider/api 依赖 | 先确认是否为必需依赖（Gemini/OpenAI 路径），不得为了省体积而移除必需依赖；超预算需人工决策，不得自行调整 `BUDGET_BYTES` |
