/**
 * 审批执行的生命周期原语。
 *
 * 审批卡片是 presentation，真正的请求身份与执行结果属于这里：
 * - `ApprovalExecutionRegistry` 以 request id 为键，保证同一次审批最多执行一次
 *   （双击、键盘重复触发、视图销毁后重新挂载都走同一个键）。
 * - `ApprovalExecutionOutcome` 是执行层返回给 UI 的结果；`unknown` 表示工具抛错/
 *   进程中断导致「不知道有没有写成」，此时不允许自动重试，必须先核实。
 *
 * 本模块不依赖 Obsidian，也不依赖 UI，方便单测。
 */

/** 审批卡在 UI 上的状态。请求本身由 `ApprovalRequest.id` 标识。 */
export type ApprovalStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'rejected' | 'unknown';

/** 终态记录：留在消息流里可回看。 */
export interface ApprovalOutcome {
  status: 'succeeded' | 'failed' | 'rejected' | 'unknown';
  /** 结果摘要或失败原因（展示在卡片里）。 */
  detail?: string;
  /** 失败时的错误文本。 */
  error?: string;
  /** 实际作用对象（成功时可能是工具返回的落盘路径）。 */
  target?: string;
  /** 结果确定时间。 */
  completedAt: number;
  /** false 表示不能安全重试（例如执行结果未知）。缺省视为可重试。 */
  retryable?: boolean;
}

/** 消息上的审批生命周期快照。与 `ApprovalRequest` 分开保存，切换 tab/重挂载后仍可恢复。 */
export interface ApprovalState {
  status: ApprovalStatus;
  outcome?: ApprovalOutcome;
}

/**
 * 执行层返回的结果。
 * `kind` 是判别字段，避免把普通工具结果误当成审批结果。
 */
export interface ApprovalExecutionOutcome {
  kind: 'approval-execution';
  status: 'succeeded' | 'failed' | 'unknown';
  detail?: string;
  error?: string;
  target?: string;
  completedAt: number;
  /** false 表示「已执行/结果未知」，不允许直接重试。 */
  retryable?: boolean;
  /** 原始工具结果，供宿主打开落盘文件等既有行为使用。 */
  result?: unknown;
}

export interface ApprovalExecutionRunOptions {
  /** 失败后的显式重试。成功的请求永远复用已记录的结果。 */
  retry?: boolean;
}

interface ApprovalExecutionRecord {
  state: 'running' | 'done';
  promise?: Promise<ApprovalExecutionOutcome>;
  outcome?: ApprovalExecutionOutcome;
}

/**
 * 进程内执行登记表。
 *
 * 键是审批请求 id（由创建审批消息时生成并持久化在会话快照里），因此：
 * - 同一张卡片重复点击 → 第二次拿到同一个 in-flight Promise；
 * - 视图销毁后新控制器重新挂载 → 仍能查到正在执行/已完成的结果；
 * - 成功后再点（理论上 UI 已禁用）→ 直接返回成功记录，绝不二次写盘。
 */
export class ApprovalExecutionRegistry {
  private readonly records = new Map<string, ApprovalExecutionRecord>();

  peek(requestId: string): ApprovalExecutionRecord | undefined {
    return this.records.get(requestId);
  }

  async run(
    requestId: string,
    execute: () => Promise<ApprovalExecutionOutcome>,
    options: ApprovalExecutionRunOptions = {},
  ): Promise<ApprovalExecutionOutcome> {
    const existing = this.records.get(requestId);
    if (existing?.state === 'running') return existing.promise as Promise<ApprovalExecutionOutcome>;

    // 已成功的结果是终态：即使调用方传了 retry，也不能再执行一次。
    if (existing?.state === 'done' && existing.outcome?.status === 'succeeded') {
      return existing.outcome;
    }
    // 失败/未知默认复用记录；只有显式 retry 才重新执行。
    if (existing?.state === 'done' && !options.retry) {
      return existing.outcome as ApprovalExecutionOutcome;
    }
    // 「未知」不能重放（副作用可能已经发生）；调用方必须先核实。
    if (existing?.state === 'done' && existing.outcome?.retryable === false) {
      return existing.outcome;
    }

    const promise = (async () => {
      try {
        const outcome = await execute();
        this.records.set(requestId, { state: 'done', outcome });
        return outcome;
      } catch (error) {
        // 工具抛错时无法判断副作用是否已经发生：登记为 unknown，要求先核实再重试。
        const message = error instanceof Error ? error.message : String(error);
        const outcome: ApprovalExecutionOutcome = {
          kind: 'approval-execution',
          status: 'unknown',
          error: message,
          detail: 'The action was interrupted before its result was recorded. Check the target before retrying.',
          completedAt: Date.now(),
          retryable: false,
        };
        this.records.set(requestId, { state: 'done', outcome });
        return outcome;
      }
    })();

    this.records.set(requestId, { state: 'running', promise });
    return promise;
  }
}
