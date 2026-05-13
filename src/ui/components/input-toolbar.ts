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

export interface ToolbarCapabilities {
  supportsImageInput: boolean;
  supportsCancellation?: boolean;
}

interface InputToolbarHandlers {
  onProviderChange: (providerId: string) => void | Promise<void>;
  onUnavailableProvider: (providerId: string) => void;
  onModelChange: (modelId: string) => void | Promise<void>;
  onSend?: () => void | Promise<void>;
  onImage?: () => void | Promise<void>;
  onStop?: () => void | Promise<void>;
}

export class InputToolbar {
  private readonly providerSelectEl: HTMLSelectElement;
  private readonly modelSelectEl: HTMLSelectElement;
  private readonly imageButtonEl: HTMLButtonElement;
  private readonly sendButtonEl: HTMLButtonElement;
  private readonly stopButtonEl: HTMLButtonElement;
  private providers = new Map<string, ProviderSelectOption>();
  private activeProviderId = '';

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

    const actions = this.containerEl.createDiv({ cls: 'shell-action-buttons' });
    this.imageButtonEl = actions.createEl('button', {
      cls: 'clickable-icon shell-image-btn',
      text: 'Image',
      attr: { 'aria-label': 'Add image context', title: 'Add image context' },
    }) as HTMLButtonElement;
    this.stopButtonEl = actions.createEl('button', {
      cls: 'clickable-icon shell-stop-btn',
      text: 'Stop',
      attr: { 'aria-label': 'Stop response', title: 'Stop response' },
    }) as HTMLButtonElement;
    this.sendButtonEl = actions.createEl('button', {
      cls: 'clickable-icon shell-send-btn',
      text: 'Send',
      attr: { 'aria-label': 'Send message', title: 'Send message' },
    }) as HTMLButtonElement;

    this.providerSelectEl.addEventListener('change', () => this.handleProviderChange());
    this.modelSelectEl.addEventListener('change', () => this.handleModelChange());
    this.imageButtonEl.addEventListener('click', () => {
      if (!this.imageButtonEl.disabled) void this.handlers.onImage?.();
    });
    this.stopButtonEl.addEventListener('click', () => {
      if (!this.stopButtonEl.disabled) void this.handlers.onStop?.();
    });
    this.sendButtonEl.addEventListener('click', () => {
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
    this.imageButtonEl.disabled = !capabilities.supportsImageInput;
    this.stopButtonEl.disabled = !capabilities.supportsCancellation;
  }

  getProviderSelectEl() {
    return this.providerSelectEl;
  }

  getModelSelectEl() {
    return this.modelSelectEl;
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
}
