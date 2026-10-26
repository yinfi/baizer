import { parse } from 'yaml';
import { logger } from '../../utils/logger';

/** 用户自定义命令的展示条目(供 / 补全与 slash 契约)。 */
export interface UserCommandEntry {
  /** 斜杠命令,如 "/summarize"(name 前加斜杠)。 */
  command: string;
  /** 命令名(= 模板文件名去扩展名)。 */
  name: string;
  /** 描述(取模板 frontmatter 的 description,缺省用通用文案)。 */
  description: string;
}

/** 已加载的模板(name/description/content 三者齐备)。 */
interface PromptTemplate {
  name: string;
  description?: string;
  content: string;
}

/**
 * 本服务对执行环境的最小需求(vault 相对路径的文件读取)。
 *
 * 结构类型而非 import pi 类型:pi 1.3.0 移除了 `loadPromptTemplates` 及其依赖的
 * FileSystem 抽象,模板加载改为本地实现(见下方 `loadTemplatesFromDir`),故这里只需
 * 声明真正用到的两个方法。`HarnessExecutionEnv` 与 `VaultSessionFileSystem` 都满足它。
 */
export interface PromptTemplateEnv {
  listDir(path: string): Promise<{ ok: true; value: Array<{ name: string; path: string; kind: 'file' | 'directory' }> } | { ok: false; error: unknown }>;
  readTextFile(path: string): Promise<{ ok: true; value: string } | { ok: false; error: unknown }>;
}

const DEFAULT_COMMANDS_DIR = '.obsidian/baizer-commands';

/**
 * 用户自定义 slash 命令服务。
 *
 * 第一性原理:一条用户命令 = 读一个 .md 模板 + 用参数替换占位符($ARGUMENTS/$1...) + 当作普通对话轮发送。
 * 不需要 Harness 的 promptFromTemplate(那是给 Harness 自持资源用的);这里把「命令→展开后的 prompt」
 * 做成纯解析,展开结果交给 ModelService 走正常 chat/chatStream,与运行时解耦。
 *
 * 模板放 vault 隐藏目录(.obsidian/baizer-commands/*.md),用户丢文件即可扩展,零代码。
 * 加载/参数切分/占位符替换三件事原先都借 pi 的导出(`loadPromptTemplates`/
 * `parseCommandArgs`/`substituteArgs`),pi 1.3.0 已整体移除,故改为本地实现
 * (保持原有可观察行为,见各函数注释)。
 * 命令名 = 文件名去扩展(summarize.md → /summarize)。与内置命令冲突时内置优先(由调用方保证)。
 */
export class PromptTemplateService {
  private templates = new Map<string, PromptTemplate>();
  private loaded = false;

  constructor(
    private readonly env: PromptTemplateEnv | null | undefined,
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
      const templates = await loadTemplatesFromDir(this.env, this.commandsDir);
      for (const template of templates) {
        if (template.name) this.templates.set(template.name, template);
      }
    } catch (error) {
      // 目录不存在是常态(用户没建过命令目录),与真正的读失败一并静默置空。
      logger.warn(
        `Failed to load user prompt templates; user commands disabled this session. (${error instanceof Error ? error.message : String(error)})`,
        'PromptTemplateService.load',
      );
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
   * - 用 parseCommandArgs 按 shell 风格(单/双引号)切分参数;
   * - 用 substituteArgs 替换 $ARGUMENTS/$1/${@:N} 等占位符。
   * 未找到模板返回 null(调用方回退到未知命令处理)。
   */
  async resolve(command: string, argsString: string): Promise<string | null> {
    await this.ensureLoaded();
    const template = this.templates.get(stripSlash(command));
    if (!template) return null;
    try {
      const args = parseCommandArgs(argsString ?? '');
      return substituteArgs(template.content, args);
    } catch (error) {
      logger.warn(
        `Failed to expand user command ${command}: ${error instanceof Error ? error.message : String(error)}`,
        'PromptTemplateService.resolve',
      );
      return null;
    }
  }
}

/**
 * 从目录加载所有 `.md` 模板(取代 pi 1.3.0 已移除的 `loadPromptTemplates`)。
 *
 * 目录不存在或不可列时抛错,由调用方 `load()` 静默置空。逐个文件独立容错:
 * 单个文件读失败/解析失败只跳过该文件,不影响其余模板。
 *
 * frontmatter 语义与旧实现一致:取 `description` 作命令描述;`content` 为去掉 frontmatter
 * 的正文(占位符替换只作用于正文,不碰元数据)。
 */
async function loadTemplatesFromDir(env: PromptTemplateEnv, dir: string): Promise<PromptTemplate[]> {
  const listed = await env.listDir(dir);
  if (!listed.ok) {
    throw new Error(`Cannot list prompt template directory: ${dir}`);
  }

  const templates: PromptTemplate[] = [];
  for (const entry of listed.value) {
    if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.md')) continue;
    const name = entry.name.slice(0, -3);
    if (!name) continue;
    const read = await env.readTextFile(entry.path);
    if (!read.ok) {
      logger.warn(`Failed to read prompt template: ${entry.path}`, 'PromptTemplateService.load');
      continue;
    }
    const parsed = parseTemplateFile(read.value);
    templates.push({ name, description: parsed.description, content: parsed.content });
  }
  return templates;
}

/**
 * 切出 frontmatter 的 `description` 与正文。
 *
 * frontmatter 缺失或 YAML 非法时:整篇作正文、description 留空(与旧实现
 * "无 frontmatter 时 description 退化为正文"的可观察结果一致——`describeTemplate`
 * 会把 description === content 的情形一并回退到通用文案)。
 */
function parseTemplateFile(raw: string): { description?: string; content: string } {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { content: normalized.trim() };

  let description: string | undefined;
  try {
    const fm = parse(match[1]) as Record<string, unknown> | null;
    if (fm && typeof fm.description === 'string') description = fm.description;
  } catch {
    // frontmatter YAML 非法:仍按有 frontmatter 处理(正文已切出),仅丢描述。
  }
  return { description, content: match[2].trim() };
}

/**
 * 按 shell 风格切分命令参数(取代 pi 1.3.0 已移除的 `parseCommandArgs`)。
 *
 * 规则:空白分隔;单引号内为字面量;双引号内支持 `\"` `\\` 转义;反斜杠在引号外转义下一个字符。
 * 引号未闭合时抛错(fail loud)——旧实现在此也会失败,静默产出半截参数会让模型收到错误的 prompt。
 */
export function parseCommandArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }

    if (quote === '"') {
      if (char === '\\' && i + 1 < input.length) {
        const next = input[i + 1];
        if (next === '"' || next === '\\') {
          current += next;
          i++;
          continue;
        }
      }
      if (char === '"') quote = null;
      else current += char;
      continue;
    }

    if (char === '\\' && i + 1 < input.length) {
      current += input[i + 1];
      i++;
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (quote) throw new Error('Unterminated quote in command arguments');
  if (started) args.push(current);
  return args;
}

/**
 * 替换模板正文里的参数占位符(取代 pi 1.3.0 已移除的 `substituteArgs`)。
 *
 * 支持三种形式(与旧实现一致):
 *   - `$ARGUMENTS`  全部参数,空格连接
 *   - `$1` … `$9`   第 N 个参数(越界为空串)
 *   - `${@:N}`      从第 N 个参数起(1-based)的全部参数,空格连接
 * `$0` 不替换(旧实现同样从 $1 起),故 `$10` 不会误解析成 `$1` + `0`。
 */
export function substituteArgs(content: string, args: string[]): string {
  return content
    .replace(/\$\{@:(\d+)\}/g, (_match, index: string) => {
      const start = Number.parseInt(index, 10);
      return start >= 1 ? args.slice(start - 1).join(' ') : '';
    })
    .replace(/\$ARGUMENTS\b/g, () => args.join(' '))
    .replace(/\$([1-9])/g, (_match, digit: string) => args[Number.parseInt(digit, 10) - 1] ?? '');
}

/** 去掉命令前导斜杠(/summarize → summarize);无斜杠原样返回。 */
function stripSlash(command: string): string {
  return command.startsWith('/') ? command.slice(1) : command;
}

/**
 * 取模板的展示描述。无 frontmatter 时 description 缺失(或退化为正文本身),
 * 这作为命令描述是噪音(会把整段模板正文显示在 / 补全里)。故:仅当 description 存在且
 * 不等于正文时才采用,否则回退到通用文案。
 */
function describeTemplate(template: PromptTemplate): string {
  const desc = template.description?.trim();
  if (desc && desc !== template.content?.trim()) return desc;
  return `Run the ${template.name} command`;
}
