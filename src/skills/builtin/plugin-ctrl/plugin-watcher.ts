// src/skills/builtin/plugin-ctrl/plugin-watcher.ts
import { App, Notice } from 'obsidian';
import { PluginSettings, PLUGIN_ID } from '../../../mcp/types';
import {
  pluginSkillDirPath,
  pluginSkillFileExists,
  pluginSkillFilePath,
  pluginSkillSkipMarkerPath,
  ensureDirectory,
  readTextIfExists,
  readPluginSkillProvenance,
} from '../../skill-files';
import { SkillRegistry } from '../../skill-registry';
import { PluginSkillGenerator } from './skill-generator';
import { logger } from '../../../utils/logger';
import { t } from '../../../i18n/zh';

const POLL_INTERVAL_MS = 10_000;
const GENERATE_DELAY_MS = 1_000;
const MAX_RETRIES = 3;

/** 派生 skill 的命名前缀：plugin-<pluginId>。 */
const DERIVED_SKILL_PREFIX = 'plugin-';
/** 内置 plugin-ctrl 与派生前缀撞名，它不是派生 skill，对账时必须排除。 */
const PLUGIN_CTRL_SKILL_NAME = 'plugin-ctrl';

/** 撤下原因——对账表里三种「不再提供」的行。 */
export type DerivedSkillWithdrawal =
  | 'withdrawn-plugin-control'
  | 'withdrawn-missing'
  | 'withdrawn-excluded';

/**
 * 显式重新生成被拒的成因。设置页据此告诉用户「去改哪一项」——
 * 笼统地列举全部前置条件会指向三件与本次无关的事，比不解释更糟。
 */
export type DerivedSkillRegenerateBlocker =
  | 'auto-generate-off'
  | 'plugin-control-off'
  | 'model-not-ready'
  | 'source-missing'
  | 'source-excluded';

/** 对账结论。除三种撤下外，其余都仍然提供给模型。 */
export type DerivedSkillReconcileStatus =
  | DerivedSkillWithdrawal
  /** 源仍在、无版本漂移（或无溯源无法判断）→ 保持注册 */
  | 'offered'
  /** 插件在线、文件在盘上但此前未注册 → 从文件恢复注册（零生成成本） */
  | 'restored'
  /** 版本漂移 + body 未被改动 → 重新生成后重新注册 */
  | 'regenerated'
  /** 版本漂移 + body 被手工编辑 → 保留用户版本，只报 staleness */
  | 'stale-hand-edited'
  /** 版本漂移 + body 未改动，但生成前置条件不满足 → 按原样提供 */
  | 'stale-regenerate-skipped'
  /** 重新生成过程中出错，文件与注册都没动 → 按原样提供 */
  | 'stale-regenerate-failed'
  /** 已覆盖写入但重新注册失败 → 未提供 */
  | 'regenerate-failed'
  /** 盘上文件无法解析或读取，恢复注册失败 → 未提供 */
  | 'restore-failed';

/** 单个派生 skill 的对账结果；设置页据此展示来源插件、版本与 staleness。 */
export interface DerivedSkillStatus {
  /** skill 名，形如 plugin-<pluginId> */
  skillName: string;
  pluginId: string;
  /** 对账后是否仍在注册表里（= 是否交给模型） */
  offered: boolean;
  status: DerivedSkillReconcileStatus;
  /** SKILL.md 溯源记录的生成时版本；无溯源为 null */
  recordedVersion: string | null;
  /** 当前安装的插件版本；插件不在线为 null */
  installedVersion: string | null;
  /** body 是否被手工改过；null = 无溯源，未知 */
  handEdited: boolean | null;
  /** 版本漂移且未被修复 */
  stale: boolean;
  /** 本轮是否真的重写了文件。设置页据此区分「已重新生成」与「没写成」。 */
  regenerated: boolean;
  /** 本轮生成失败的原因；没试过或成功了为 null */
  failureReason: string | null;
}

/** 对账过程中先采集、各分支共用的事实部分（结论字段由分支补齐）。 */
type DerivedSkillFacts = Pick<
  DerivedSkillStatus,
  'skillName' | 'pluginId' | 'recordedVersion' | 'installedVersion' | 'handEdited'
>;

export class PluginWatcher {
  private snapshot: Set<string> = new Set();
  private intervalId: number | null = null;
  private failedRetries = new Map<string, number>();
  /** 上次观察到的「可生成」状态——判断设置变更是否跨过阈值的唯一依据 */
  private lastReadyForGeneration: boolean;
  /** 上次观察到的插件控制授权状态——授权变化必须触发对账，即使 enabledPlugins 没变。 */
  private lastPluginControlGranted: boolean;
  /** 扫描单飞标记：补跑由设置保存非阻塞触发，不能叠加第二轮 */
  private scanInFlight = false;
  /** 轮询单飞：生成是慢操作，10 秒轮询不能叠加第二轮。 */
  private pollingInFlight = false;
  /** 每个插件最近一次生成失败的原因（键 = 插件 id）；成功后清除。设置页据此展示「谁失败、为什么」 */
  private generationFailures = new Map<string, string>();
  /** 最近一次对账结果，供设置页展示来源版本与 staleness */
  private derivedSkillStatuses: DerivedSkillStatus[] = [];

  constructor(
    private app: App,
    private skillRegistry: SkillRegistry,
    private generator: PluginSkillGenerator,
    private settings: PluginSettings,
    private isModelReady: () => boolean,
    /** 提示通道：注入后测试才能断言「前置条件不满足时一句话都不说」 */
    private notify: (message: string) => void = (message) => { new Notice(message); },
  ) {
    this.lastReadyForGeneration = this.canGenerate();
    this.lastPluginControlGranted = this.settings.allowPluginControl === true;
  }

  /**
   * 生成前置条件：自动生成开关 + 插件控制已授权 + 模型配置可用。
   * 所有生成路径（启动扫描、新装插件、补跑扫描）都必须先过这道闸，
   * 且必须在任何信息采集之前——否则会白跑一轮网络请求再失败。
   * 开关也算前置条件，这样「先补 Key 再打开开关」的顺序不会漏掉补跑（见下）。
   */
  private canGenerate(): boolean {
    return this.generationBlocker() === null;
  }

  /** 哪一项前置条件没过（判定顺序即报告顺序）；全过返回 null。 */
  private generationBlocker(): DerivedSkillRegenerateBlocker | null {
    if (this.settings.autoGeneratePluginSkills !== true) return 'auto-generate-off';
    if (this.settings.allowPluginControl !== true) return 'plugin-control-off';
    if (!this.isModelReady()) return 'model-not-ready';
    return null;
  }

  /**
   * 每次设置保存后无条件调用，由 watcher 自己判断要不要补跑扫描。
   * 只有「可生成」从不可用跨到可用（补上 API Key、授权插件控制、打开自动生成开关）
   * 才补跑启动时被跳过的扫描；未跨过阈值的设置变更不触发任何工作。
   */
  async handleSettingsSaved(): Promise<void> {
    const ready = this.canGenerate();
    const crossedThreshold = ready && !this.lastReadyForGeneration;
    this.lastReadyForGeneration = ready;

    const pluginControlGranted = this.settings.allowPluginControl === true;
    const pluginControlChanged = pluginControlGranted !== this.lastPluginControlGranted;
    this.lastPluginControlGranted = pluginControlGranted;
    if (pluginControlChanged) {
      // 授权切换不一定改变 enabledPlugins：重新授权必须直接对账，
      // 才能从盘上恢复此前仅被注销的技能，而不触发生成。
      await this.reconcileDerivedSkills();
    }

    if (!crossedThreshold) return;

    logger.info('前置条件已满足，补跑启动时跳过的扫描', 'PluginWatcher');
    await this.initialScan();
  }

  // ==================== 派生 skill 对账 ====================

  /**
   * 启动对账：逐个派生 skill 核对来源插件的真实状态，决定是否继续交给模型。
   * 必须在 loadUserSkills 之后调用——那一步会把目录里所有 SKILL.md 无条件注册，
   * 包括来源已消失的派生 skill，本方法负责把它们撤下来。
   *
   * 两条不可违背的性质：
   * - 撤下不等于删除：SKILL.md 永远留在盘上，插件重新启用即零成本恢复。
   * - 对账不等于生成：整个流程不看 autoGeneratePluginSkills，只有「重新生成」
   *   那一行才是生成，才受该开关与模型就绪度约束。
   */
  async reconcileDerivedSkills(): Promise<DerivedSkillStatus[]> {
    const registered = this.registeredDerivedPluginIds();
    const candidates = await this.collectCandidatePluginIds(registered);

    const statuses: DerivedSkillStatus[] = [];
    for (const pluginId of candidates) {
      statuses.push(await this.reconcileOne(pluginId, registered.has(pluginId)));
    }

    this.derivedSkillStatuses = statuses;
    const withdrawn = statuses.filter(s => !s.offered).length;
    const stale = statuses.filter(s => s.stale).length;
    logger.info(
      `派生 skill 对账完成：共 ${statuses.length} 个，撤下 ${withdrawn} 个，仍过期 ${stale} 个`,
      'PluginWatcher',
    );
    return statuses;
  }

  /** 最近一次对账结果（未对账过则为空数组）。设置页读它，不重跑对账。 */
  getDerivedSkillStatuses(): DerivedSkillStatus[] {
    return this.derivedSkillStatuses;
  }

  /**
   * 各插件最近一次生成失败的原因，键 = 插件 id；生成成功后该条目移除。
   * 失败原因不能只进 console——设置页要能告诉用户「哪些插件失败、为什么」。
   */
  getGenerationFailures(): ReadonlyMap<string, string> {
    return this.generationFailures;
  }

  /**
   * 用户在设置页显式点「重新生成」：覆盖写，即使 body 被手工改过。
   *
   * 这是「重新生成可以覆盖我们写的，绝不覆盖你写的」的唯一例外——用户亲自要求了，
   * 显式请求优先于对账给手工编辑的保护（对账走 regenerateForReconcile，那条路遇到
   * handEdited 会绕开）。条件不满足时不采集任何信息，并报出**是哪一项**不满足——
   * 笼统列举全部前置条件会指向三件与本次无关的事，比不解释更糟。
   */
  async regenerateDerivedSkill(
    pluginId: string,
  ): Promise<DerivedSkillStatus | { blocker: DerivedSkillRegenerateBlocker }> {
    const blocker = this.regenerateBlocker(pluginId);
    if (blocker) {
      logger.info(`${blocker}，跳过 ${pluginId} 的显式重新生成`, 'PluginWatcher');
      return { blocker };
    }

    // 先读真实溯源：重新生成失败时要按原样报告，而盘上文件的版本与编辑状态都还是旧的。
    // 若这里图省事传 null，失败路径会把「生成版本未知」写进状态，设置页就会撒谎。
    const report = await readPluginSkillProvenance(this.app.vault.adapter, pluginId);
    const facts: DerivedSkillFacts = {
      skillName: `${DERIVED_SKILL_PREFIX}${pluginId}`,
      pluginId,
      recordedVersion: report.provenance?.version || null,
      installedVersion: (await this.readPluginVersion(pluginId)) || null,
      handEdited: report.handEdited,
    };
    // wasRegistered 传 true：这条路径只负责覆盖+重注册，不承担「从文件恢复」的语义。
    // stale 传当前真实的漂移状态：对一个并不过期的技能重新生成（嫌质量差）失败后，
    // 不该被倒打一耙标成过期。
    const status = await this.regenerateForReconcile(facts, true, this.hasVersionDrift(facts));
    this.replaceStatus(status);
    return status;
  }

  /**
   * 显式重新生成被拒的成因：先看生成前置条件，再看来源是否还站得住。
   * 显式请求能压过「不覆盖手工编辑」，但压不过对账表的撤下三行——来源已消失的技能
   * 重新生成出来也不该提供，否则花一次网络+LLM 的钱换回一份注定撤下的文件。
   */
  private regenerateBlocker(pluginId: string): DerivedSkillRegenerateBlocker | null {
    const precondition = this.generationBlocker();
    if (precondition) return precondition;

    const withdrawal = this.withdrawalReason(pluginId);
    if (withdrawal === 'withdrawn-excluded') return 'source-excluded';
    // withdrawn-plugin-control 已被上面的 plugin-control-off 覆盖，剩下的就是来源不在了。
    return withdrawal ? 'source-missing' : null;
  }

  /** 版本漂移：需同时有溯源版本与当前版本才可判定，否则一律视为不漂移。 */
  private hasVersionDrift(facts: DerivedSkillFacts): boolean {
    return !!facts.recordedVersion
      && !!facts.installedVersion
      && facts.recordedVersion !== facts.installedVersion;
  }

  /**
   * 用户在设置页显式点「删除」：文件真的删掉，并停止提供。
   * 与对账的「撤下」相反——撤下留文件（插件重新启用时零成本复用），删除是不可逆的清除。
   * 不受生成前置条件约束：撤回插件控制授权后，用户仍要能清掉盘上的残留。
   */
  async deleteDerivedSkill(pluginId: string): Promise<boolean> {
    const skillName = `${DERIVED_SKILL_PREFIX}${pluginId}`;
    const filePath = pluginSkillFilePath(pluginId);
    const adapter = this.app.vault.adapter as unknown as { remove(path: string): Promise<void> };

    try {
      if (await this.app.vault.adapter.exists(filePath)) {
        await adapter.remove(filePath);
      }
    } catch (e: any) {
      console.error(`[PluginWatcher] Failed to delete skill file for ${pluginId}:`, e?.message ?? e);
      return false;
    }

    this.skillRegistry.unregisterSkill(skillName);
    this.derivedSkillStatuses = this.derivedSkillStatuses
      .filter(status => status.pluginId !== pluginId);
    logger.info(`已删除派生 skill ${skillName} 及其文件`, 'PluginWatcher');
    return true;
  }

  /** 把单个插件的最新状态并回列表，供设置页在不重跑整轮对账的情况下刷新。 */
  private replaceStatus(status: DerivedSkillStatus): void {
    const index = this.derivedSkillStatuses
      .findIndex(existing => existing.pluginId === status.pluginId);
    if (index === -1) {
      this.derivedSkillStatuses = [...this.derivedSkillStatuses, status];
      return;
    }
    const next = [...this.derivedSkillStatuses];
    next[index] = status;
    this.derivedSkillStatuses = next;
  }

  /** 已注册的派生 skill → 插件 id。内置 plugin-ctrl 同前缀但非派生，排除。 */
  private registeredDerivedPluginIds(): Set<string> {
    const ids = new Set<string>();
    for (const summary of this.skillRegistry.getAllSkillSummaries()) {
      if (summary.name === PLUGIN_CTRL_SKILL_NAME) continue;
      if (!summary.name.startsWith(DERIVED_SKILL_PREFIX)) continue;
      ids.add(summary.name.slice(DERIVED_SKILL_PREFIX.length));
    }
    return ids;
  }

  /**
   * 对账范围 = 已注册的派生 skill ∪ 在线插件里盘上已有 SKILL.md 却未注册的。
   * 后半截正是「禁用一周后重新启用」的恢复路径：文件还在，直接重新注册。
   */
  private async collectCandidatePluginIds(registered: Set<string>): Promise<string[]> {
    const ids = new Set(registered);
    for (const pluginId of this.getEnabledPluginIds()) {
      // 未注册的只在「本来就该提供」时才纳入，避免为一个从未注册的 skill 报撤下。
      if (ids.has(pluginId) || this.withdrawalReason(pluginId)) continue;
      if (await this.hasSkillFile(pluginId)) ids.add(pluginId);
    }
    return [...ids].sort();
  }

  /** 单个派生 skill 的对账表求值。 */
  private async reconcileOne(
    pluginId: string, wasRegistered: boolean,
  ): Promise<DerivedSkillStatus> {
    const report = await readPluginSkillProvenance(this.app.vault.adapter, pluginId);
    const facts: DerivedSkillFacts = {
      skillName: `${DERIVED_SKILL_PREFIX}${pluginId}`,
      pluginId,
      recordedVersion: report.provenance?.version || null,
      installedVersion: (await this.readPluginVersion(pluginId)) || null,
      handEdited: report.handEdited,
    };

    const withdrawal = this.withdrawalReason(pluginId);
    if (withdrawal) return this.withdraw(facts, withdrawal);

    // 版本漂移只在有溯源、且能读到当前版本时可判定；否则一律视为不漂移。
    const drifted = !!facts.recordedVersion
      && !!facts.installedVersion
      && facts.recordedVersion !== facts.installedVersion;

    if (drifted && facts.handEdited === false) {
      return this.regenerateForReconcile(facts, wasRegistered);
    }
    if (drifted) {
      // 手工改过：用户的编辑优先，只报 staleness，绝不覆盖。
      return this.offerAsIs(facts, wasRegistered, 'stale-hand-edited', true);
    }
    return this.offerAsIs(facts, wasRegistered, wasRegistered ? 'offered' : 'restored', false);
  }

  /**
   * 撤下的三种条件，判定顺序与对账表一致：权限 → 来源存活 → 排除名单。
   * 都不成立返回 null（= 继续提供）。这里只读设置与 enabledPlugins，不看生成开关。
   */
  private withdrawalReason(pluginId: string): DerivedSkillWithdrawal | null {
    if (this.settings.allowPluginControl !== true) return 'withdrawn-plugin-control';
    const enabled = (this.app as any).plugins?.enabledPlugins as Set<string> | undefined;
    if (!enabled?.has(pluginId)) return 'withdrawn-missing';
    if (this.settings.pluginSkillExcludeList.includes(pluginId)) return 'withdrawn-excluded';
    return null;
  }

  /** 撤下：只注销注册表条目，不动盘上文件——重新启用时才能零成本恢复。 */
  private withdraw(
    facts: DerivedSkillFacts, status: DerivedSkillWithdrawal,
  ): DerivedSkillStatus {
    this.skillRegistry.unregisterSkill(facts.skillName);
    logger.info(`撤下派生 skill ${facts.skillName}（${status}），文件保留在盘上`, 'PluginWatcher');
    return {
      ...facts, offered: false, status, stale: false,
      regenerated: false, failureReason: null,
    };
  }

  /**
   * 按盘上原样提供：已注册的保持不动，未注册的从文件恢复注册。
   * failureReason 由重新生成失败的分支传入——「按原样提供」是那条路的收尾，
   * 但失败本身必须一路带到状态里，否则设置页只能看到一个像成功的结果。
   */
  private async offerAsIs(
    facts: DerivedSkillFacts,
    wasRegistered: boolean,
    status: DerivedSkillReconcileStatus,
    stale: boolean,
    failureReason: string | null = null,
  ): Promise<DerivedSkillStatus> {
    if (!wasRegistered && !await this.loadAndRegister(facts.pluginId)) {
      logger.info(`派生 skill ${facts.skillName} 无法从文件恢复注册`, 'PluginWatcher');
      return {
        ...facts, offered: false, status: 'restore-failed', stale,
        regenerated: false, failureReason,
      };
    }
    if (stale) {
      logger.info(
        `派生 skill ${facts.skillName} 已过期：记录版本 ${facts.recordedVersion}，`
        + `当前版本 ${facts.installedVersion}`,
        'PluginWatcher',
      );
    }
    return {
      ...facts, offered: true, status, stale,
      regenerated: false, failureReason,
    };
  }

  /**
   * 对账表里唯一的生成行：版本漂移且 body 未被改动 → 覆盖重写后重新注册。
   * 前置条件不满足时不采集任何信息，按原样继续提供并保留 staleness 标记。
   *
   * staleOnFailure 是「没写成时该报多陈旧」：对账走这条路一定是因为漂移，故默认 true；
   * 设置页的显式重新生成可能作用在并不过期的技能上（用户只是嫌生成质量差），
   * 那种情况失败后不该被倒打一耙标成过期。
   */
  private async regenerateForReconcile(
    facts: DerivedSkillFacts, wasRegistered: boolean, staleOnFailure = true,
  ): Promise<DerivedSkillStatus> {
    if (!this.canGenerate()) {
      return this.offerAsIs(facts, wasRegistered, 'stale-regenerate-skipped', staleOnFailure);
    }

    try {
      const info = await this.generator.collectPluginInfo(facts.pluginId);
      const content = await this.generator.generateSkillMd(info);
      await this.generator.writeSkillFile(facts.pluginId, content, 'replace');
    } catch (e: any) {
      const reason = String(e?.message ?? e);
      // 原因不能只进 console：设置页要能回答「哪个插件失败、为什么」，
      // 这条路径与启动扫描一样是生成，失败的留痕口径必须一致。
      this.generationFailures.set(facts.pluginId, reason);
      console.error(
        `[PluginWatcher] Failed to regenerate skill for ${facts.pluginId}:`, reason,
      );
      return this.offerAsIs(
        facts, wasRegistered, 'stale-regenerate-failed', staleOnFailure, reason,
      );
    }

    // 文件已被覆盖，注册表里的旧正文必须让位：先注销再从新文件加载。
    this.skillRegistry.unregisterSkill(facts.skillName);
    if (!await this.loadAndRegister(facts.pluginId)) {
      const reason = `Regenerated skill file could not be loaded: ${this.generator.skillFilePath(facts.pluginId)}`;
      this.generationFailures.set(facts.pluginId, reason);
      return {
        ...facts, offered: false, status: 'regenerate-failed', stale: true,
        regenerated: false, failureReason: reason,
      };
    }
    // 成功必须清掉旧原因，否则设置页会在整个会话里继续展示一个已经修好的失败。
    this.generationFailures.delete(facts.pluginId);
    logger.info(`派生 skill ${facts.skillName} 已按新版本重新生成`, 'PluginWatcher');
    return {
      ...facts,
      recordedVersion: facts.installedVersion,
      handEdited: false,
      offered: true,
      status: 'regenerated',
      stale: false,
      regenerated: true,
      failureReason: null,
    };
  }

  getEnabledPluginIds(): string[] {
    const enabled = (this.app as any).plugins.enabledPlugins as Set<string>;
    return [...enabled].filter(id =>
      id !== PLUGIN_ID
      && !this.settings.pluginSkillExcludeList.includes(id)
    );
  }

  diffPlugins(
    oldSet: Set<string>, newSet: Set<string>,
  ): { added: string[]; removed: string[] } {
    const added = [...newSet].filter(id => !oldSet.has(id));
    const removed = [...oldSet].filter(id => !newSet.has(id));
    return { added, removed };
  }

  async hasSkillFile(pluginId: string): Promise<boolean> {
    return pluginSkillFileExists(this.app.vault.adapter, pluginId);
  }

  private async readPluginVersion(pluginId: string): Promise<string> {
    const path = `.obsidian/plugins/${pluginId}/manifest.json`;
    try {
      const raw = await this.app.vault.adapter.read(path);
      const manifest = JSON.parse(raw);
      return manifest.version || '';
    } catch {
      const fallback = (this.app as any).plugins?.manifests?.[pluginId];
      return fallback?.version || '';
    }
  }

  private async readSkipMarkerVersion(pluginId: string): Promise<string> {
    const marker = await readTextIfExists(
      this.app.vault.adapter,
      pluginSkillSkipMarkerPath(pluginId),
    );
    if (marker === null) return '';
    try {
      const parsed = JSON.parse(marker);
      return parsed.version || '';
    } catch {
      return '';
    }
  }

  private async writeSkipMarker(pluginId: string, version: string): Promise<void> {
    const dirPath = pluginSkillDirPath(pluginId);
    await ensureDirectory(this.app.vault.adapter, dirPath);
    await this.app.vault.adapter.write(
      pluginSkillSkipMarkerPath(pluginId),
      JSON.stringify({ version, skippedAt: new Date().toISOString() }, null, 2),
    );
  }

  private async getGenerationCandidate(pluginId: string): Promise<string | null> {
    if (await this.hasSkillFile(pluginId)) return null;

    const version = await this.readPluginVersion(pluginId);
    const cachedVersion = await this.readSkipMarkerVersion(pluginId);
    if (version && cachedVersion && cachedVersion === version) {
      return null;
    }

    const info = await this.generator.collectBasicPluginInfo(pluginId);
    if (this.generator.shouldSkipPlugin(info)) {
      await this.writeSkipMarker(pluginId, info.version || version);
      return null;
    }

    return pluginId;
  }

  async start(): Promise<void> {
    // 自动生成关闭时仍需监听插件增删，才能及时撤下和零成本恢复已有技能。
    // initialScan/checkChanges 内部只在 canGenerate() 通过时执行生成工作。
    logger.info('Starting...', 'PluginWatcher');
    await this.initialScan();
    this.intervalId = window.setInterval(
      () => this.checkChanges(),
      POLL_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info('Stopped', 'PluginWatcher');
  }

  /**
   * 扫描入口：单飞。补跑由设置保存非阻塞触发，而一轮扫描是「逐插件网络 + LLM」
   * 的分钟级工作；期间再次跨过阈值（例如中途撤销又重新授权）不能叠加第二轮，
   * 否则同一个 SKILL.md 会有两个写入方，网络和 LLM 开销也翻倍。
   */
  private async initialScan(): Promise<void> {
    if (this.scanInFlight) {
      logger.info('已有扫描在跑，跳过本轮补跑', 'PluginWatcher');
      return;
    }
    this.scanInFlight = true;
    try {
      await this.runInitialScan();
    } finally {
      this.scanInFlight = false;
    }
  }

  private async runInitialScan(): Promise<void> {
    const pluginIds = this.getEnabledPluginIds();
    // snapshot 只依赖本地 enabledPlugins，先记下来：即使本轮不生成，
    // 后续轮询也只对真实的插件增减做出反应。
    this.snapshot = new Set(pluginIds);

    // 前置条件不满足时：不采集任何信息、不弹任何提示——
    // 用户还没启用这个子系统，首次启动就不该有噪音。
    if (!this.canGenerate()) {
      logger.info('前置条件未满足（开关、插件控制或模型配置），跳过扫描', 'PluginWatcher');
      return;
    }

    const toGenerate: string[] = [];
    for (const id of pluginIds) {
      const candidate = await this.getGenerationCandidate(id);
      if (candidate) {
        toGenerate.push(id);
      }
    }

    if (toGenerate.length === 0) {
      logger.info('All plugins have skills', 'PluginWatcher');
      return;
    }

    const candidates: string[] = [];
    for (const id of toGenerate) {
      candidates.push(id);
    }

    if (candidates.length === 0) return;

    logger.info(`Generating skills for ${candidates.length} plugins`, 'PluginWatcher');
    this.notify(
      t('Generating skills for {n} plugins...').replace('{n}', String(candidates.length)),
    );

    const { succeeded, failed } = await this.generateBatch(candidates);
    this.notify(this.batchOutcomeMessage(succeeded, failed));
  }

  /** 逐个生成并统计真实结果；失败原因由 generateAndRegister 记入 generationFailures。 */
  private async generateBatch(
    pluginIds: string[],
  ): Promise<{ succeeded: number; failed: number }> {
    let succeeded = 0;
    for (let i = 0; i < pluginIds.length; i++) {
      if (await this.generateAndRegister(pluginIds[i])) succeeded += 1;
      if (i < pluginIds.length - 1) {
        await this.delay(GENERATE_DELAY_MS);
      }
    }
    return { succeeded, failed: pluginIds.length - succeeded };
  }

  /**
   * 完成提示：全成功只说成功，全失败只说失败，部分成功才两个数都报。
   * 报「尝试了 N 个」会让用户以为有 N 个技能可用，而实际可能一个都没生成出来。
   */
  private batchOutcomeMessage(succeeded: number, failed: number): string {
    if (failed === 0) {
      return t('Generated skills for {n} plugins').replace('{n}', String(succeeded));
    }
    if (succeeded === 0) {
      return t('Failed to generate skills for {n} plugins').replace('{n}', String(failed));
    }
    return t('Plugin skills: {ok} generated, {failed} failed')
      .replace('{ok}', String(succeeded))
      .replace('{failed}', String(failed));
  }

  private async checkChanges(): Promise<void> {
    if (this.pollingInFlight) return;
    this.pollingInFlight = true;
    try {
      const currentIds = new Set(this.getEnabledPluginIds());
      const { added, removed } = this.diffPlugins(this.snapshot, currentIds);

      const canGenerate = this.canGenerate();
      for (const id of added) {
        // 与对账同一把闸：撤下只在启动跑一次，若轮询能绕过它，撤下就形同白做。
        if (this.withdrawalReason(id)) continue;
        if (await this.hasSkillFile(id)) {
          if (await this.loadAndRegister(id)) {
            this.failedRetries.delete(id);
            this.generationFailures.delete(id);
          }
        } else if (canGenerate) {
          const candidate = await this.getGenerationCandidate(id);
          if (candidate) {
            this.notify(t('Generating skill for {plugin}...').replace('{plugin}', id));
            await this.generateAndRegister(id);
          }
        }
      }

      // 主线已有保证：失败的生成最多跨轮询重试三次。若写盘后注册失败，
      // 只有带 Baizer provenance 的派生文件可覆盖；无 provenance 的文件按用户文件处理。
      if (canGenerate) {
        for (const [id, retries] of [...this.failedRetries]) {
          if (!currentIds.has(id) || retries >= MAX_RETRIES || this.withdrawalReason(id)) continue;

          let mode: 'first-write' | 'replace' = 'first-write';
          if (await this.hasSkillFile(id)) {
            const report = await readPluginSkillProvenance(this.app.vault.adapter, id);
            if (!report.present) {
              if (await this.loadAndRegister(id)) {
                this.failedRetries.delete(id);
                this.generationFailures.delete(id);
              }
              continue;
            }
            mode = 'replace';
          }
          await this.generateAndRegister(id, mode);
        }
      }

      for (const id of removed) {
        const skillName = `plugin-${id}`;
        this.skillRegistry.unregisterSkill(skillName);
        this.failedRetries.delete(id);
        this.generationFailures.delete(id);
        logger.info(`Unregistered skill: ${skillName}`, 'PluginWatcher');
      }

      this.snapshot = currentIds;
    } finally {
      this.pollingInFlight = false;
    }
  }

  /** 返回是否真的生成并注册成功——完成提示的成功数只能来自这个返回值。 */
  private async generateAndRegister(
    pluginId: string,
    mode: 'first-write' | 'replace' = 'first-write',
  ): Promise<boolean> {
    const retries = this.failedRetries.get(pluginId) || 0;
    if (retries >= MAX_RETRIES) return false;

    try {
      const info = await this.generator.collectPluginInfo(pluginId);
      const content = await this.generator.generateSkillMd(info);
      await this.generator.writeSkillFile(pluginId, content, mode);

      const registered = await this.loadAndRegister(pluginId);
      if (!registered) {
        throw new Error(`Generated skill file could not be loaded: ${this.generator.skillFilePath(pluginId)}`);
      }

      this.failedRetries.delete(pluginId);
      this.generationFailures.delete(pluginId);
      logger.info(`Generated skill for: ${pluginId}`, 'PluginWatcher');
      return true;
    } catch (e: any) {
      this.failedRetries.set(pluginId, retries + 1);
      // 原因不能只进 console：设置页要能回答「哪个插件失败、为什么」。
      this.generationFailures.set(pluginId, String(e?.message ?? e));
      console.error(
        `[PluginWatcher] Failed to generate skill for ${pluginId} `
        + `(attempt ${retries + 1}/${MAX_RETRIES}):`, e.message,
      );
      return false;
    }
  }

  private async loadAndRegister(pluginId: string): Promise<boolean> {
    // 生成可能跨越设置变更；在唯一注册入口再次检查，避免撤权期间的在途生成绕过撤下。
    if (this.withdrawalReason(pluginId)) return false;

    const filePath = this.generator.skillFilePath(pluginId);
    const content = await readTextIfExists(this.app.vault.adapter, filePath);
    if (content === null) return false;

    // Stage 3：统一走 registry 的 parseBuiltinSkill 解析器（保留 tools/triggers sidecar），
    // 不再实例化 SkillLoader。
    return this.skillRegistry.registerUserFromMd(content, filePath);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
