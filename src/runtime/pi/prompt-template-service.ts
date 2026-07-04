import { logger } from '../../utils/logger';

/** pi PromptTemplate 的最小形状(type-only,避免静态 value import)。 */
interface PiPromptTemplate {
  name: string;
  description?: string;
  content: string;
}

/** 用户自定义命令的展示条目(供 / 补全与 slash 契约)。 */
export interface UserCommandEntry {
  /** 斜杠命令,如 "/summarize"(name 前加斜杠)。 */
  command: string;
  /** 命令名(= 模板文件名去扩展名)。 */
  name: string;
  /** 描述(取模板 frontmatter 的 description,缺省用通用文案)。 */
  description: string;
}

const DEFAULT_COMMANDS_DIR = '.obsidian/baizer-commands';

/**
 * 用户自定义 slash 命令服务(基于 pi 的 prompt-template)。
 *
 * 第一性原理:一条用户命令 = 读一个 .md 模板 + 用参数替换占位符($ARGUMENTS/$1...) + 当作普通对话轮发送。
 * 不需要 Harness 的 promptFromTemplate(那是给 Harness 自持资源用的);这里把「命令→展开后的 prompt」
 * 做成纯解析,展开结果交给 ModelService 走正常 chat/chatStream,与运行时解耦。
 *
 * 模板放 vault 隐藏目录(.obsidian/baizer-commands/*.md),用户丢文件即可扩展,零代码。
 * 加载走 pi 的 loadPromptTemplates(env, dir),复用已有的 HarnessExecutionEnv(移动端安全)。
 * 命令名 = 文件名去扩展(summarize.md → /summarize)。与内置命令冲突时内置优先(由调用方保证)。
 */
export class PromptTemplateService {
  private templates = new Map<string, PiPromptTemplate>();
  private loaded = false;

  constructor(
    private readonly env: unknown,
    private readonly commandsDir: string = DEFAULT_COMMANDS_DIR,
  ) {}

  /**
   * 从隐藏目录加载所有 .md 模板。幂等失败安全:目录不存在/读失败时静默置空,不抛。
   * 可重复调用以刷新(用户新增/修改模板后)。
   */
  async load(): Promise<void> {
    this.templates.clear();
    this.loaded = true;
    if (!this.env) return;
    try {
      const mod = (await import('@earendil-works/pi-agent-core')) as any;
      const result = await mod.loadPromptTemplates(this.env, this.commandsDir);
      for (const template of result.promptTemplates as PiPromptTemplate[]) {
        if (template?.name) this.templates.set(template.name, template);
      }
      for (const diag of result.diagnostics ?? []) {
        logger.warn(`Prompt template diagnostic (${diag.code}): ${diag.path}`, 'PromptTemplateService.load');
      }
    } catch {
      logger.warn('Failed to load user prompt templates; user commands disabled this session.', 'PromptTemplateService.load');
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  /** 列出用户命令(供 / 补全与 slash 契约合并)。未加载时先加载。 */
  async listCommands(): Promise<UserCommandEntry[]> {
    await this.ensureLoaded();
    return this.listCommandsSync();
  }

  /**
   * 同步返回「已加载」的用户命令快照(未加载时为空)。
   * 供同步 UI 路径(/ 补全)使用;首次为空,startup 调 load() 预热后即有值。
   */
  listCommandsSync(): UserCommandEntry[] {
    return [...this.templates.values()].map((template) => ({
      command: `/${template.name}`,
      name: template.name,
      description: describeTemplate(template),
    }));
  }

  /** 该命令是否为已加载的用户模板(command 形如 "/summarize")。 */
  async has(command: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.templates.has(stripSlash(command));
  }

  /**
   * 把「命令 + 参数串」解析成展开后的 prompt。
   * - 用 pi parseCommandArgs 按 shell 风格(单/双引号)切分参数;
   * - 用 pi substituteArgs 替换 $ARGUMENTS/$1/${@:N} 等占位符。
   * 未找到模板返回 null(调用方回退到未知命令处理)。
   */
  async resolve(command: string, argsString: string): Promise<string | null> {
    await this.ensureLoaded();
    const template = this.templates.get(stripSlash(command));
    if (!template) return null;
    try {
      const mod = (await import('@earendil-works/pi-agent-core')) as any;
      const args: string[] = mod.parseCommandArgs(argsString ?? '');
      return mod.substituteArgs(template.content, args);
    } catch {
      logger.warn(`Failed to expand user command ${command}`, 'PromptTemplateService.resolve');
      return null;
    }
  }
}

/** 去掉命令前导斜杠(/summarize → summarize);无斜杠原样返回。 */
function stripSlash(command: string): string {
  return command.startsWith('/') ? command.slice(1) : command;
}

/**
 * 取模板的展示描述。pi loadPromptTemplates 在无 frontmatter 时把 description 设为正文本身,
 * 这作为命令描述是噪音(会把整段模板正文显示在 / 补全里)。故:仅当 description 存在且
 * 不等于正文时才采用,否则回退到通用文案。
 */
function describeTemplate(template: PiPromptTemplate): string {
  const desc = template.description?.trim();
  if (desc && desc !== template.content?.trim()) return desc;
  return `Run the ${template.name} command`;
}
