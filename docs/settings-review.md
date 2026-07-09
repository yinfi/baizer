# Baizer 配置页面全方位分析报告

> 生成时间:2026-07-08 · 方法:6 维度并行审查 + 对抗验证 + 综合
> 审查对象:`src/settings.ts`(约 2316 行)、`styles.css`(约 4306 行)、`src/mcp/types.ts`

## 整体评价

配置页面已从"左侧导航+双栏"迭代到"手风琴 details/summary + 顶部搜索 + i18n"的现代形态,信息架构方向正确,`renderToken` 防竞态、`MemoryConfirmModal` 二次确认、T8 部分 a11y 已有基础。但它卡在一个**根因性缺陷**上:**所有 UI 更新都靠 `this.display()` 整页 `containerEl.empty()` 重建**。这一个设计决策派生出全页最痛的三个问题:

1. **搜索框每敲一个字符就失焦,搜索实际不可用**(4 个维度独立发现同一条,全部 CONFIRMED / high)——当前最严重缺陷。
2. **拖动滑块(字号/透明度/上下文窗口)时每一格都整页重建 + 落盘 + 重建 LLM 客户端**,拖拽被打断、几十次写盘、反复初始化模型客户端。
3. **配置页样式存在三处并存且相互冲突的真相源**;更严重的是 `baizer-memory-*` / `baizer-settings-task` 等大量实际渲染的类在 styles.css 里 0 定义,唯一样式源是名为 "fallback" 的 JS 注入串。

---

## P0 — 阻断 / 高频痛点 / 数据风险

### P0-1 搜索框失焦,搜索不可用
- **问题**:`input` 事件直接 `this.display()` → `containerEl.empty()` 销毁正在输入的 `<input>`,重建后只回填 `.value` 不恢复焦点/光标。
- **定位**:`src/settings.ts:854-857` + `:827` + `:836-858`
- **方案**:搜索不走整页重建。把 `renderMain` 手风琴部分抽成可单独刷新的方法,input 只更新 `searchQuery` + 局部重绘 accordion,hero/搜索行 DOM 不动;叠加 debounce。
- **成本**:中。是后续多项优化的公共基础。

### P0-2 新增/自定义 Provider 静默落到空模型
- **问题**:`select.value = options[0].value` 只改视觉,不触发 change、不 persist,`activeConfig.model` 仍为空。Run test 和对话都拿空模型发请求。
- **定位**:`src/settings.ts:1451-1491`(`:1475`)+ `:1194-1201`
- **方案**:`currentModel` 为空且列表非空时主动 `switchModel(options[0].value)` 写回。
- **成本**:低。

### P0-3 滑块拖动 = 整页重建 + 每格落盘 + 重建 LLM 客户端
- **问题**:滑块 `onChange` 每格 `await persistSettings()` + `this.display()`;`saveSettings` 无条件 `updateSettings()`(cleanup + initializeProvider + modelListCache.clear)。拖字号滑块 = 拖拽中断 + 几十次写盘 + 反复初始化模型客户端。
- **定位**:`src/settings.ts:1897-1921`、`:1497-1504`、`:1590-1597`;`main.ts:348-356`;`model-service.ts:225-234`
- **方案**:(a) `saveSettings` 区分需重建 provider 的字段与纯 UI 字段;(b) 滑块去掉 `display()`,预览局部更新;(c) 滑块落盘走 `debouncedPersist`。
- **成本**:中。

### P0-4 配置页样式真相源混乱
- **问题**:同名类三处并存(styles.css flex 版 / grid 覆盖版 / settings.ts 内联 fallback)数值不一致,呈现取决于插入顺序;`baizer-memory-*` 等类在 styles.css 0 定义,唯一源是 JS 注入串。
- **定位**:`styles.css:2875-3450`、`:3916-4097`;`src/settings.ts:76-519`、`:521-535`
- **方案**:单一真相源——样式下沉 styles.css,删死选择器,fallback 退化为极简兜底或删除。
- **成本**:中-高。

---

## P1 — 明显体验缺陷

### P1-1 破坏性操作确认策略不一致
删除 Provider(`:1410`)、清空记忆(`:1137/1148`)、插件控制开关(`:1717/1745`)都有 `MemoryConfirmModal`,但两处同样不可逆的操作没有:
- **Clear API Key**(`:1361` 直接 `apiKey=''`)—— 误点即抹掉密钥。
- **Restore Default Prompt**(`:1546` 直接覆盖)—— 误点即覆盖自定义提示词。
- **提权路径不一致**:"Open access" 权限预设(`:1847`)静默打开 allowPluginControl,绕过单独开关的确认。
- **方案**:给两者补 `MemoryConfirmModal`;预设含提权项时复用确认或标注。**成本**:低。

### P1-2 搜索命中却不展开,首屏 12 分区全折叠
- 搜索只过滤 section 不加入 `openSectionIds`;首次进入 `openSectionIds` 为空,看不到任何设置项。
- **定位**:`src/settings.ts:561-573` + `:872-899` + `:732`
- **方案**:搜索命中自动展开;首次默认展开 overview/connection;搜索索引下沉到设置项级。**成本**:低-中。

### P1-3 嵌套"高级"块每次重渲染塌回折叠
- 顶层有 `openSectionIds` 记忆,但嵌套 `advanced` details(`:1650`/`:2063`)无记忆。切 Vault Write Scope 后高级块折叠,新出现的 Writable Folders 必填项被隐藏。
- **方案**:嵌套 details 也持久化展开态,或走局部刷新。**成本**:低。

### P1-4 硬编码文案破坏 i18n(双向)
- 硬编码中文:Overview `'权限过宽'`/`' 缺少 API Key'`(`:625/630`)、Guardian 深挖(`:1613-1614`)。
- 硬编码英文:section badge(`:589-615`)、Provider 卡片文案(`:694/1216`)、`Data folder:`、本体状态串。
- **方案**:全部走 `t()`;`'Risk'`→"权限偏宽",`'N actions'` 用占位模板。**成本**:低-中。

### P1-5 异步状态无 aria-live,读屏收不到反馈
- 连接测试/记忆加载/本体状态都是普通 div,靠整页重建切换,全文件无 `aria-live`。
- **方案**:状态容器加 `role="status" aria-live="polite"`,跨重渲染保持存在仅更新 textContent(依赖 P0-1)。**成本**:低。

### P1-6 记忆 tab 缺 tablist 语义 + 记忆搜索需点按钮
- 记忆 tab 无 `role=tab`/`aria-selected`,选中态仅靠颜色;记忆搜索不支持回车,`aria-label` 缺失(`:1047`)。
- **方案**:tab 加 tablist/tab/aria-selected + 非颜色标记;记忆搜索加 Enter 提交 + aria-label。**成本**:低。

---

## P2 — 打磨项

- **模型加载失败无重试入口**(`:1290-1310`):加"刷新模型"按钮走 `forceRefresh=true`。
- **description 单行省略截断文案**(`styles.css:3937-4002`):改允许换行或 `line-clamp:2`。
- **无 tone 的 inline-note 是裸文字**(`styles.css:3124`):补中性容器样式或 `is-muted` tone。
- **chevron 用字符 `>`**(`:894`):改 `setIcon(el,'chevron-right')` + `aria-hidden="true"`。
- **触控目标偏小**(`:948-963`):overview 按钮改 `.baizer-settings-action`(32px)+ 动作动词文案。
- **prefers-reduced-motion 漏配置页**(`styles.css:4223`):纳入 `.baizer-settings-page *`。
- **:focus-visible 缺失**:配置页自定义按钮/卡片补 `:focus-visible`。
- **死代码/僵尸设置**:删 `loadDynamicModelOptions`(`:770-815`);`getProviderListSummary`(`:662`)挂 UI 或删;`terminalFont`(types.ts:133/203,无 UI 无消费点)补控件或移除。
- **innerHTML=''**(`:1455/1464/1480`):统一为 `.empty()`。
- **capture 名实不符**:描述承诺通用采集,实际仅微信 3 项。收窄命名或补齐。
- **Guardian 分区排第 9 位**:可上移到 behavior/memory 附近(主观 IA 建议)。

---

## 已排除 / 修正的误报

- **"Guardian 中文用户完全搜不到"** → PARTIAL:description 走 t(),搜"行内/触发/忽略"可命中。
- **"违反 T8『重渲染后焦点保持』约定"** → 该约定不存在;onChange 焦点丢失属实但可 Tab 恢复,降 medium;details toggle 是条件性重建。
- **"refreshOntologyStatus 竞态覆盖新结果"** → PARTIAL:每次建独立新节点,旧 promise 只写回已 detach 旧节点,不污染新 UI。
- **"innerHTML='' 有注入风险"** → 赋空字符串不注入,属风格一致性。
- **"记忆搜索框完全无可访问名称"** → PARTIAL:placeholder 是兜底,主流读屏会念。
- **badge/focus-visible** → 按钮未设 `outline:none`,默认焦点框仍在,属打磨项。

---

## 实施顺序建议

P0-1(抽出局部刷新方法)是 P0-3、P1-2、P1-3、P1-5 的公共前置。建议:
1. **先做 P0-1 局部刷新重构**(公共基础)
2. P0-2 模型写回、P0-3 saveSettings 字段分流(数据正确性)
3. P1 系列搭车局部刷新完成
4. P0-4 CSS 真相源合并(独立进行)
5. P2 打磨

---

## 实施状态(2026-07-08 已完成)

全部 P0 + P1 + 大部分 P2 已落地,`npm run build` 零警告、`tsc --noEmit` 零错误、88 个测试文件全通过。

| 项 | 状态 | 关键改动 |
|----|------|----------|
| P0-1 局部刷新 | ✅ | `display()` 只建骨架(hero+搜索+`accordionHost`);新增 `renderAccordion()` 局部重绘;33 处 handler 内 `display()`→`renderAccordion()`;搜索框不再重建,焦点保留 |
| P0-2 模型写回 | ✅ | `loadDynamicModelSelect` 拿到真实列表且 `config.model` 空时 `switchModel(options[0])` 写回;`innerHTML=''`→`.empty()` |
| P0-3 滑块/saveSettings | ✅ | 新增 `saveSettingsLight()`(只写盘)+ `debouncedPersistLight`;外观 3 项走轻量 debounce + 局部预览;上下文/灵敏度/编译批量滑块改 `debouncedPersist` |
| P0-4 CSS 真相源 | ✅ | 删除 nav/workspace/main/section-header/provider-card 子元素等旧设计死选择器(~180 行 + 1 个死断点块);合并重复的 page/hero/title/subtitle 到单一定义;修复 subtitle/section-description 截断(改 2 行 clamp) |
| P1-1 破坏性确认 | ✅ | Clear API Key、Restore Default Prompt 补 `MemoryConfirmModal`;open/automation 预设提权前二次确认 |
| P1-2 搜索展开/首屏 | ✅ | 首次打开默认展开 overview+connection;搜索命中自动展开命中分区 |
| P1-3 嵌套高级展开态 | ✅ | 新增 `openAdvanced` + `trackAdvancedDetails()`,权限/本体高级块记忆展开态 |
| P1-4 硬编码文案 i18n | ✅ | badge/overview/provider 卡片/Data folder/guardian 深挖/本体状态全走 `t()`,补 zh-messages;`Risk`→权限偏宽,`N actions`→占位模板 |
| P1-5 aria-live | ✅ | 连接测试状态、记忆列表/错误加 `role=status/alert` + `aria-live` |
| P1-6 记忆 tab/搜索 | ✅ | tab 加 `role=tablist/tab`+`aria-selected`;记忆搜索补 `aria-label`+回车提交 |
| P2 打磨 | ✅ 大部分 | chevron 改 `setIcon`+`aria-hidden`;overview 按钮改 `.baizer-settings-action`+动作文案;prefers-reduced-motion 覆盖配置页;补 `:focus-visible`;Guardian 中文关键词;`Configuration` 标题 i18n |
| P2 剩余(未做) | ⏳ | 模型加载失败重试按钮;capture 分区名实收窄;`terminalFont` 僵尸设置清理;inline-note 无 tone 中性容器;`getProviderListSummary`/`loadDynamicModelOptions` 死代码;Guardian 分区排序 |

**验证**:build 零警告、tsc 项目源零错误、`npm test` 88 文件全通过(含更新后的 `settings-state.test.ts`)。
**未验证**:CSS 视觉回归需在真实 Obsidian 中肉眼确认(删除的均为 src 中 0 引用的死选择器,风险低)。

