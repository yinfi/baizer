# Provider 配置重构设计

## 问题

当前 AI 供应商配置存在以下结构性问题：

1. **扁平数据结构** — 每个 provider 的 apiKey/baseUrl/model 是独立字段，新增 provider 需改 6 处 switch/case（4 个文件）
2. **设置页与边栏不同步** — 设置页切换 provider 不通知 ShellView，边栏切换不通知设置页
3. **切换 provider 不清理 chat session** — MemoryManager 持有旧 session，切换后可能用旧 provider 发请求
4. **边栏不区分已配置/未配置 provider** — 切到没配 key 的 provider 直接报错
5. **DeepSeek/Qwen 通过运行时修改 id/name 实现** — 违反封装，脆弱
6. **设置页与边栏 model 选择体验不一致** — Gemini 动态下拉，OpenAI 系手动输入
7. **thinkingModel 死字段** — 定义了但从未使用

## 设计

### 1. 统一数据结构

```typescript
interface ProviderConfig {
    type: 'gemini' | 'openai-compatible';
    label: string;
    apiKey: string;
    baseUrl: string;
    model: string;
}

interface PluginSettings {
    activeProvider: string;
    providers: Record<string, ProviderConfig>;
    // 其他字段不变（guardian, permissions, terminal, prompt, wechat, knowledge）
}
```

默认值：

```typescript
const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
    'gemini': {
        type: 'gemini',
        label: 'Google Gemini',
        apiKey: '',
        baseUrl: '',
        model: 'gemini-2.5-flash'
    },
    'openai': {
        type: 'openai-compatible',
        label: 'OpenAI',
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o'
    },
    'deepseek': {
        type: 'openai-compatible',
        label: 'DeepSeek',
        apiKey: '',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat'
    },
    'qwen': {
        type: 'openai-compatible',
        label: 'Qwen',
        apiKey: '',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-turbo'
    }
};
```

关键变化：
- `provider` 字段重命名为 `activeProvider`
- 删除所有扁平的 per-provider 字段（apiKey, openaiApiKey, deepseekApiKey 等）
- 删除 `thinkingModel` 死字段
- DeepSeek/Qwen 不再是特殊 case，只是 `openai-compatible` + 不同 baseUrl

### 2. ModelService 简化

消除所有 switch/case，统一通过 `providers[activeProvider]` 读取配置：

```typescript
// 之前：6 处 switch/case
// 之后：1 处 switch（仅按 type 创建实例）

initializeProvider() {
    const config = this.settings.providers[this.settings.activeProvider];
    if (!config) { /* fallback to gemini */ }

    switch (config.type) {
        case 'gemini':
            this.provider = new GeminiProvider();
            break;
        case 'openai-compatible':
            this.provider = new OpenAIProvider();
            break;
    }
    this.provider.configure({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        modelName: config.model,
        systemPrompt: this.settings.systemPrompt,
        contextWindow: this.settings.contextWindow
    });
}

hasValidConfig(): boolean {
    const config = this.getActiveProviderConfig();
    return !!config?.apiKey;
}

getCurrentModel(): string {
    return this.getActiveProviderConfig()?.model || '';
}

getActiveProviderConfig(): ProviderConfig | undefined {
    return this.settings.providers[this.settings.activeProvider];
}
```

### 3. 事件驱动 UI 同步

新增 `switchProvider()` 方法作为唯一的 provider 切换入口：

```typescript
// ModelService
private providerChangedCallbacks: Array<() => void> = [];

onProviderChanged(callback: () => void): () => void {
    this.providerChangedCallbacks.push(callback);
    return () => {
        // 返回取消注册函数
        this.providerChangedCallbacks =
            this.providerChangedCallbacks.filter(cb => cb !== callback);
    };
}

async switchProvider(providerId: string): Promise<void> {
    const config = this.settings.providers[providerId];
    if (!config) return;

    this.settings.activeProvider = providerId;
    await this.saveSettings();

    // 清理旧状态
    if (this.memoryManager) {
        await this.memoryManager.clearSession();
    }
    this.modelListCache.clear();

    // 重建 provider
    this.initializeProvider();

    // 通知所有监听者
    this.providerChangedCallbacks.forEach(cb => cb());
}
```

消费方注册：

```typescript
// ShellView.onOpen()
this.unsubscribeProvider = this.modelService.onProviderChanged(() => {
    this.populateProviderOptions(this.providerSelectEl);
    this.populateModelOptions(this.modelSelectEl, true);
    this.updatePlaceholder();
});

// ShellView.onClose()
this.unsubscribeProvider?.();
```

```typescript
// SettingTab — 设置页切换 provider
drop.onChange(async (value) => {
    await this.plugin.modelService.switchProvider(value);
    this.display(); // 重绘设置页自身
});
```

### 4. 边栏 provider 状态感知

```typescript
populateProviderOptions(selectEl: HTMLSelectElement) {
    selectEl.empty();
    const providers = this.settings.providers;
    const active = this.settings.activeProvider;

    for (const [id, config] of Object.entries(providers)) {
        const configured = !!config.apiKey;
        const option = selectEl.createEl('option', {
            value: id,
            text: configured ? config.label : `${config.label} ⚠️`
        });
        if (id === active) option.selected = true;
    }
}

// 切换时检查
providerSelectEl.addEventListener('change', async (e) => {
    const id = (e.target as HTMLSelectElement).value;
    const config = this.settings.providers[id];
    if (!config?.apiKey) {
        new Notice(`${config.label} 未配置 API Key，请先在设置中配置`);
        // 打开设置页
        this.app.setting.open();
        this.app.setting.openTabById('obsidian-cli');
        // 恢复选择
        this.populateProviderOptions(this.providerSelectEl);
        return;
    }
    await this.modelService.switchProvider(id);
    new Notice(`已切换到 ${config.label}`);
});
```

### 5. 数据迁移

在 plugin `onload()` 中执行一次性迁移：

```typescript
private migrateSettings(settings: any): PluginSettings {
    // 已经是新格式
    if (settings.providers) return settings;

    // 旧格式 → 新格式
    settings.activeProvider = settings.provider || 'gemini';
    settings.providers = {
        'gemini': {
            type: 'gemini',
            label: 'Google Gemini',
            apiKey: settings.apiKey || '',
            baseUrl: '',
            model: settings.primaryModel || 'gemini-2.5-flash'
        },
        'openai': {
            type: 'openai-compatible',
            label: 'OpenAI',
            apiKey: settings.openaiApiKey || '',
            baseUrl: settings.openaiBaseUrl || 'https://api.openai.com/v1',
            model: settings.openaiModel || 'gpt-4o'
        },
        'deepseek': {
            type: 'openai-compatible',
            label: 'DeepSeek',
            apiKey: settings.deepseekApiKey || '',
            baseUrl: settings.deepseekBaseUrl || 'https://api.deepseek.com',
            model: settings.deepseekModel || 'deepseek-chat'
        },
        'qwen': {
            type: 'openai-compatible',
            label: 'Qwen',
            apiKey: settings.qwenApiKey || '',
            baseUrl: settings.qwenBaseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            model: settings.qwenModel || 'qwen-turbo'
        }
    };

    // 清理旧字段
    delete settings.provider;
    delete settings.apiKey;
    delete settings.primaryModel;
    delete settings.openaiApiKey;
    delete settings.openaiBaseUrl;
    delete settings.openaiModel;
    delete settings.deepseekApiKey;
    delete settings.deepseekBaseUrl;
    delete settings.deepseekModel;
    delete settings.qwenApiKey;
    delete settings.qwenBaseUrl;
    delete settings.qwenModel;
    delete settings.thinkingModel;

    return settings;
}
```

### 6. 设置页统一 model 选择

所有 provider 的 model 选择都改为动态下拉（调 `getAvailableModels()`），
与边栏行为一致。加载失败时 fallback 到当前 model + 手动输入。

## 影响范围

| 文件 | 变更 |
|------|------|
| `src/mcp/types.ts` | 新增 ProviderConfig，重构 PluginSettings，更新 DEFAULT_SETTINGS |
| `src/services/model-service.ts` | 消除 switch/case，新增 switchProvider() + 事件机制 |
| `src/settings.ts` | 遍历 providers map 渲染，统一动态 model 下拉 |
| `src/ui/shell-view.ts` | 注册 onProviderChanged，简化 changeProvider/changeModel |
| `main.ts` | 新增 migrateSettings() 数据迁移 |

不影响：GeminiProvider、OpenAIProvider、IModelProvider 接口、工具系统、记忆系统、知识编译器。

## 交互闭环验证

完成后应满足：

1. 设置页切换 provider → 边栏立即同步（provider 下拉 + model 下拉 + placeholder）
2. 边栏切换 provider → 设置页下次打开时显示正确 provider
3. 切换 provider → 旧 chat session 被清理，新对话用新 provider
4. 未配置 key 的 provider → 边栏标记 ⚠️，切换时提示并引导到设置页
5. OpenAI Compatible 类型的 label 显示用户配置的名称（如 "DeepSeek"），不是固定的 "OpenAI Compatible"
6. 所有 provider 的 model 选择都是动态下拉，体验一致
