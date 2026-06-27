import { setIcon } from 'obsidian';

export interface ProviderSelectOption {
  id: string;
  label: string;
  configured: boolean;
}

export interface ModelSelectOption {
  value: string;
  label: string;
}

export interface ModelUpdate {
  loading: boolean;
  providerLabel: string;
  models: ModelSelectOption[];
  activeModelId: string;
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** Thinking 档位的下拉选项：value 为持久化值，label 为紧凑显示文案。 */
const THINKING_OPTIONS: ReadonlyArray<{ value: ThinkingLevel; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
];

export interface ToolbarCapabilities {
  /** provider 是否支持图片输入。仅供调用方参考；附件按钮的可用性不再依赖它。 */
  supportsImageInput?: boolean;
  supportsCancellation?: boolean;
  isResponding?: boolean;
  canSend?: boolean;
}

interface InputToolbarHandlers {
  onProviderChange: (providerId: string) => void | Promise<void>;
  onUnavailableProvider: (providerId: string) => void;
  onModelChange: (modelId: string) => void | Promise<void>;
  onThinkingChange?: (level: ThinkingLevel) => void | Promise<void>;
  onSend?: () => void | Promise<void>;
  onAttach?: () => void | Promise<void>;
  onStop?: () => void | Promise<void>;
}

export class InputToolbar {
  private readonly providerSelectEl: HTMLSelectElement;
  private readonly modelSelectEl: HTMLSelectElement;
  private readonly thinkingSelectEl: HTMLSelectElement;
  private readonly attachButtonEl: HTMLButtonElement;
  private readonly runButtonEl: HTMLButtonElement;
  private providers = new Map<string, ProviderSelectOption>();
  private activeProviderId = '';
  private isResponding = false;

  constructor(
    private readonly containerEl: HTMLElement,
    private readonly handlers: InputToolbarHandlers,
  ) {
    this.containerEl.empty();

    const modelSelectContainer = this.containerEl.createDiv({ cls: 'shell-model-select-container' });
    this.providerSelectEl = modelSelectContainer.createEl('select', {
      cls: 'shell-model-select shell-provider-select',
      attr: { title: 'Select AI Provider' },
    }) as HTMLSelectElement;
    this.modelSelectEl = modelSelectContainer.createEl('select', {
      cls: 'shell-model-select shell-main-model-select',
      attr: { title: 'Select AI Model' },
    }) as HTMLSelectElement;
    this.thinkingSelectEl = modelSelectContainer.createEl('select', {
      cls: 'shell-model-select shell-thinking-select',
      attr: { title: 'Thinking level — lower uses fewer tokens, higher reasons more deeply' },
    }) as HTMLSelectElement;
    THINKING_OPTIONS.forEach(({ value, label }) => {
      this.thinkingSelectEl.createEl('option', { value, text: label });
    });
    this.thinkingSelectEl.value = 'medium';

    const actions = this.containerEl.createDiv({ cls: 'shell-action-buttons' });
    this.attachButtonEl = actions.createEl('button', {
      cls: 'clickable-icon shell-action-btn shell-attach-btn',
      attr: { 'aria-label': 'Add file attachment', title: 'Add file attachment' },
    }) as HTMLButtonElement;
    setIcon(this.attachButtonEl, 'paperclip');
    this.runButtonEl = actions.createEl('button', {
      cls: 'clickable-icon shell-action-btn shell-run-btn',
      attr: { 'aria-label': 'Send message', title: 'Send message' },
    }) as HTMLButtonElement;
    setIcon(this.runButtonEl, 'send-horizontal');

    this.providerSelectEl.addEventListener('change', () => this.handleProviderChange());
    this.modelSelectEl.addEventListener('change', () => this.handleModelChange());
    this.thinkingSelectEl.addEventListener('change', () => this.handleThinkingChange());
    this.attachButtonEl.addEventListener('click', () => {
      if (!this.attachButtonEl.disabled) void this.handlers.onAttach?.();
    });
    this.runButtonEl.addEventListener('click', () => {
      if (this.runButtonEl.disabled) return;
      if (this.isResponding) {
        void this.handlers.onStop?.();
        return;
      }
      void this.handlers.onSend?.();
    });
  }

  updateProviders(providers: ProviderSelectOption[], activeProviderId: string) {
    this.providers = new Map(providers.map(provider => [provider.id, provider]));
    this.activeProviderId = activeProviderId;
    this.providerSelectEl.empty();

    providers.forEach((provider) => {
      const option = this.providerSelectEl.createEl('option', {
        value: provider.id,
        text: provider.configured ? provider.label : `${provider.label} !`,
      }) as HTMLOptionElement;
      option.selected = provider.id === activeProviderId;
    });

    this.providerSelectEl.value = activeProviderId;
  }

  updateModels(update: ModelUpdate) {
    this.modelSelectEl.empty();

    if (update.loading) {
      const loadingOption = this.modelSelectEl.createEl('option', {
        value: '',
        text: `Loading ${update.providerLabel} models...`,
      }) as HTMLOptionElement;
      loadingOption.selected = true;
      this.modelSelectEl.value = '';
      this.modelSelectEl.disabled = true;
      return;
    }

    if (!update.models.length) {
      const emptyOption = this.modelSelectEl.createEl('option', {
        value: '',
        text: 'No models available',
      }) as HTMLOptionElement;
      emptyOption.selected = true;
      emptyOption.disabled = true;
      this.modelSelectEl.value = '';
      this.modelSelectEl.disabled = true;
      return;
    }

    update.models.forEach((model) => {
      const option = this.modelSelectEl.createEl('option', {
        value: model.value,
        text: model.label,
      }) as HTMLOptionElement;
      option.selected = model.value === update.activeModelId;
    });

    this.modelSelectEl.value = update.activeModelId;
    this.modelSelectEl.disabled = false;
  }

  updateCapabilities(capabilities: ToolbarCapabilities) {
    const isResponding = capabilities.isResponding ?? capabilities.supportsCancellation ?? false;
    const canStop = capabilities.supportsCancellation ?? isResponding;
    this.isResponding = isResponding;
    // 文件附件与图片能力无关，仅在响应进行中禁用，避免流式途中改动上下文。
    this.attachButtonEl.disabled = isResponding;
    this.runButtonEl.disabled = isResponding
      ? !canStop
      : capabilities.canSend === false;
    const label = isResponding ? 'Stop response' : 'Send message';
    this.runButtonEl.setAttribute('aria-label', label);
    this.runButtonEl.setAttribute('title', label);
    setIcon(this.runButtonEl, isResponding ? 'square' : 'send-horizontal');
    (this.runButtonEl as any).toggleClass?.('is-stop', isResponding);
    (this.runButtonEl as any).toggleClass?.('is-send', !isResponding);
  }

  /** 同步当前 thinking 档位到下拉框（由 ShellView 在 settings 变更/初始化时调用）。 */
  updateThinking(level: ThinkingLevel) {
    this.thinkingSelectEl.value = level;
  }

  getProviderSelectEl() {
    return this.providerSelectEl;
  }

  getModelSelectEl() {
    return this.modelSelectEl;
  }

  getThinkingSelectEl() {
    return this.thinkingSelectEl;
  }

  private handleProviderChange() {
    const providerId = this.providerSelectEl.value;
    const provider = this.providers.get(providerId);

    if (!provider?.configured) {
      this.providerSelectEl.value = this.activeProviderId;
      this.handlers.onUnavailableProvider(providerId);
      return;
    }

    void this.handlers.onProviderChange(providerId);
  }

  private handleModelChange() {
    if (!this.modelSelectEl.value) return;
    void this.handlers.onModelChange(this.modelSelectEl.value);
  }

  private handleThinkingChange() {
    void this.handlers.onThinkingChange?.(this.thinkingSelectEl.value as ThinkingLevel);
  }
}
