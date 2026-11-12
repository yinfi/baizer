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

import { t } from '../i18n/zh';

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
  /**
   * 原始工具结果的可展示投影，仅供宿主打开落盘文件等既有行为使用。
   * 只保留 success/status/path/target 等几个字段，不保存整个工具返回（见 #76 P3）。
   */
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
  /**
   * 核实放行标记：只有 `reconcile` 核实「上次尝试没有成功落盘」后才置位，
   * 让 `run(..., { retry: true })` 能绕过 `retryable === false` 的缓存。
   * 成功后记录被新结果替换，标记自然消失，因此只放行一次。
   */
  retryVerified?: boolean;
}

export interface ApprovalExecutionRegistryOptions {
  /**
   * 已结束记录条数上限，防止长会话只增不减（#76 P3）。
   * 只淘汰最早的成功记录：成功是终态、且审批状态已随会话快照持久化；
   * `unknown`/`failed` 仍要留给核实与重试，不淘汰。
   */
  maxRecords?: number;
}

const DEFAULT_MAX_RECORDS = 100;

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
  private readonly maxRecords: number;

  constructor(options: ApprovalExecutionRegistryOptions = {}) {
    this.maxRecords = Math.max(1, options.maxRecords ?? DEFAULT_MAX_RECORDS);
  }

  peek(requestId: string): ApprovalExecutionRecord | undefined {
    return this.records.get(requestId);
  }

  /**
   * 核实路径专用：放行一次「结果未知」的显式重试。
   *
   * 只能由核实流程（`ModelService.reconcileApprovedAction` 确认上次尝试没有成功落盘）
   * 调用；UI 的重试按钮自己不能解锁，否则重试就成了盲写。
   */
  unlock(requestId: string): void {
    const record = this.records.get(requestId);
    if (record?.state === 'done') record.retryVerified = true;
  }

  async run(
    requestId: string,
    execute: () => Promise<ApprovalExecutionOutcome>,
    options: ApprovalExecutionRunOptions = {},
  ): Promise<ApprovalExecutionOutcome> {
    const existing = this.records.get(requestId);
    if (existing?.state === 'running') return existing.promise as Promise<ApprovalExecutionOutcome>;

    if (existing?.state === 'done' && existing.outcome) {
      // 已成功的结果是终态：即使调用方传了 retry，也不能再执行一次。
      if (existing.outcome.status === 'succeeded') return existing.outcome;
      // 失败/未知默认复用记录；只有显式 retry 才重新执行。
      if (!options.retry) return existing.outcome;
      // 「未知」不能重放（副作用可能已经发生）；核实流程解锁后才放行这一次。
      if (existing.outcome.retryable === false && !existing.retryVerified) return existing.outcome;
    }

    const promise = (async () => {
      try {
        const outcome = await execute();
        this.store(requestId, { state: 'done', outcome });
        return outcome;
      } catch (error) {
        // 工具抛错时无法判断副作用是否已经发生：登记为 unknown，要求先核实再重试。
        const message = error instanceof Error ? error.message : String(error);
        const outcome: ApprovalExecutionOutcome = {
          kind: 'approval-execution',
          status: 'unknown',
          error: message,
          detail: t('The action was interrupted before its result was recorded. Check the target before retrying.'),
          completedAt: Date.now(),
          retryable: false,
        };
        this.store(requestId, { state: 'done', outcome });
        return outcome;
      }
    })();

    this.records.set(requestId, { state: 'running', promise });
    return promise;
  }

  private store(requestId: string, record: ApprovalExecutionRecord) {
    this.records.set(requestId, record);
    this.evictFinishedSuccesses();
  }

  /**
   * 超过上限时从最早的成功记录开始淘汰。
   *
   * Map 保持插入顺序，所以遍历顺序≈登记顺序；`running` 与不可重放的未知/失败记录不淘汰，
   * 它们数量有限（每次审批最多一条）且仍参与核实/重试。
   */
  private evictFinishedSuccesses() {
    if (this.records.size <= this.maxRecords) return;
    for (const [requestId, record] of this.records) {
      if (this.records.size <= this.maxRecords) return;
      if (record.state === 'done' && record.outcome?.status === 'succeeded') {
        this.records.delete(requestId);
      }
    }
  }
}
