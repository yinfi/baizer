import { logger } from '../utils/logger';

/**
 * 运行中的 AgentHarness 的最小接口(只暴露 steering 需要的方法)。
 * 用结构化定义而非 import pi 类型,避免静态 value import(pi 是 ESM-only)。
 */
export interface SteerableHarness {
  steer(text: string, options?: { images?: unknown[] }): Promise<void>;
  setActiveTools(toolNames: string[]): Promise<void>;
}

/**
 * 运行中 steering 控制器(取代旧的自造 SteeringController 队列)。
 *
 * 第一性原理:AgentHarness 原生就有 steer()/setActiveTools()——它们把补话注入
 * *当前正在运行的* harness 的下一轮、或替换下一轮的活跃工具集。旧 SteeringController
 * 自己维护 FIFO 队列 + prepareNextTurn 钩子,是在底层 agentLoop 上重造 harness 已有的能力。
 *
 * 本控制器只做一件事:持有「当前活跃的 harness」引用。
 * - runtime 在 queryStream 启动时 register(harness),流结束时 clear()。
 * - UI/ModelService 调 steer()/setActiveTools() 时,直接转发给活跃 harness;
 *   无活跃 run 时静默忽略(补话没有可注入的目标)。
 *
 * 跨轮复用同一实例:每次新流覆盖 register,旧引用被替换,天然避免跨次泄漏
 * (旧 SteeringController 需显式 reset() 才能防泄漏)。
 */
export class ActiveRunController {
  private active: SteerableHarness | null = null;

  /** runtime 在 queryStream 启动时登记当前 harness。 */
  register(harness: SteerableHarness): void {
    this.active = harness;
  }

  /** runtime 在流结束(正常/中断/错误)时清除。仅当传入的仍是当前活跃引用时才清,避免竞态误清新流。 */
  clear(harness?: SteerableHarness): void {
    if (!harness || this.active === harness) {
      this.active = null;
    }
  }

  /** 是否有正在运行、可被补话的 harness。 */
  isActive(): boolean {
    return this.active !== null;
  }

  /**
   * 运行中补话:转发给活跃 harness 的原生 steer()。空白文本或无活跃 run 时忽略。
   * steer 是异步的,但调用方(UI)只需「已排队」语义,故 fire-and-forget,失败仅记日志。
   */
  steer(text: string): void {
    const trimmed = (text ?? '').trim();
    if (!trimmed || !this.active) return;
    void this.active.steer(trimmed).catch((error) => {
      logger.warn('Failed to steer active run', 'ActiveRunController.steer');
      void error;
    });
  }

  /**
   * 运行时调整可用工具集:转发给活跃 harness 的原生 setActiveTools()。
   * read_skill 是 skill 激活的元能力,收窄工具集时必须保留,否则模型无法再读取/切换 skill。
   * 无活跃 run 时忽略。
   */
  setActiveTools(toolNames: string[]): void {
    if (!this.active) return;
    const names = new Set(toolNames ?? []);
    names.add('read_skill');
    void this.active.setActiveTools([...names]).catch(() => {
      logger.warn('Failed to set active tools on active run', 'ActiveRunController.setActiveTools');
    });
  }
}
