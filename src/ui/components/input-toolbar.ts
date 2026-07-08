import { setIcon } from 'obsidian';

export interface ModelSelectOption {
  value: string;
  label: string;
}

/** 一个 provider 的模型分组，渲染为下拉里的一个 <optgroup>。 */
export interface ModelGroup {
  providerId: string;
  providerLabel: string;
  models: ModelSelectOption[];
}

export interface ModelUpdate {
  loading: boolean;
  groups: ModelGroup[];
  activeProviderId: string;
  activeModelId: string;
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * 合并下拉里每个 <option> 的 value 需要同时携带 provider 与 model。
 * 用 NUL 字符拼接：provider id 由我们控制(settings.providers 的 key)、model id 均不含 NUL，
 * 故切分零歧义。
 */
const MODEL_VALUE_SEP = ' ';

export function encodeModelValue(providerId: string, modelId: string): string {
  return `${providerId}${MODEL_VALUE_SEP}${modelId}`;
}

export function decodeModelValue(value: string): { providerId: string; modelId: string } {
  const idx = value.indexOf(MODEL_VALUE_SEP);
  if (idx < 0) return { providerId: '', modelId: value };
  return { providerId: value.slice(0, idx), modelId: value.slice(idx + 1) };
}

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
  /** 选中某个模型:同时给出它所属 provider 与 model id(合并下拉的唯一切换入口)。 */
  onModelSelect: (providerId: string, modelId: string) => void | Promise<void>;
  onThinkingChange?: (level: ThinkingLevel) => void | Promise<void>;
  onSend?: () => void | Promise<void>;
  onAttach?: () => void | Promise<void>;
  onStop?: () => void | Promise<void>;
}

export class InputToolbar {
  private readonly modelSelectEl: HTMLSelectElement;
  private readonly thinkingSelectEl: HTMLSelectElement;
  private readonly attachButtonEl: HTMLButtonElement;
  private readonly runButtonEl: HTMLButtonElement;
  private isResponding = false;

  constructor(
    private readonly containerEl: HTMLElement,
    private readonly handlers: InputToolbarHandlers,
  ) {
    this.containerEl.empty();

    const modelSelectContainer = this.containerEl.createDiv({ cls: 'shell-model-select-container' });
    // provider 与 model 合并为单个分组下拉:provider 作 optgroup 标题,模型列于其下,
    // 选中模型即隐含切到对应 provider。原独立的 provider select 已移除(三控件 → 两控件)。
    this.modelSelectEl = modelSelectContainer.createEl('select', {
      cls: 'shell-model-select shell-main-model-select',
      attr: { title: 'Select AI Model', 'aria-label': 'Select AI Model' },
    }) as HTMLSelectElement;
    this.thinkingSelectEl = modelSelectContainer.createEl('select', {
      cls: 'shell-model-select shell-thinking-select',
      attr: {
        title: 'Thinking level — lower uses fewer tokens, higher reasons more deeply',
        'aria-label': 'Thinking level',
      },
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

  updateModels(update: ModelUpdate) {
    this.modelSelectEl.empty();

    if (update.loading) {
      const loadingOption = this.modelSelectEl.createEl('option', {
        value: '',
        text: 'Loading models...',
      }) as HTMLOptionElement;
      loadingOption.selected = true;
      this.modelSelectEl.value = '';
      this.modelSelectEl.disabled = true;
      return;
    }

    const hasModels = update.groups.some(group => group.models.length > 0);
    if (!hasModels) {
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

    const activeValue = encodeModelValue(update.activeProviderId, update.activeModelId);
    for (const group of update.groups) {
      if (!group.models.length) continue;
      const optgroup = this.modelSelectEl.createEl('optgroup', {
        attr: { label: group.providerLabel },
      }) as HTMLOptGroupElement;
      for (const model of group.models) {
        const value = encodeModelValue(group.providerId, model.value);
        const option = optgroup.createEl('option', {
          value,
          text: model.label,
        }) as HTMLOptionElement;
        option.selected = value === activeValue;
      }
    }

    this.modelSelectEl.value = activeValue;
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

  getModelSelectEl() {
    return this.modelSelectEl;
  }

  getThinkingSelectEl() {
    return this.thinkingSelectEl;
  }

  private handleModelChange() {
    const raw = this.modelSelectEl.value;
    if (!raw) return;
    const { providerId, modelId } = decodeModelValue(raw);
    if (!modelId) return;
    void this.handlers.onModelSelect(providerId, modelId);
  }

  private handleThinkingChange() {
    void this.handlers.onThinkingChange?.(this.thinkingSelectEl.value as ThinkingLevel);
  }
}
