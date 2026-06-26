import type { FileError, FileErrorCode, FileInfo, Result } from '@earendil-works/pi-agent-core';

// pi 包仅暴露 ESM `import` 条件（无 `require`），静态 value import 在 CJS 测试/打包下会失败，
// 因此这里只做 type-only import。运行时所需的 Result/FileError 形态用本地构造，
// pi 的 repo-utils 只读取 error.code / error.message，不做 instanceof 判断，故无需真正的 FileError 类。
function ok<T>(value: T): Result<T, FileError> {
  return { ok: true, value };
}

function err<T>(error: FileError): Result<T, FileError> {
  return { ok: false, error };
}

function makeFileError(code: FileErrorCode, message: string, path?: string, cause?: Error): FileError {
  const error = new Error(message) as Error & { code: FileErrorCode; path?: string; cause?: Error };
  error.name = 'FileError';
  error.code = code;
  error.path = path;
  error.cause = cause;
  return error as unknown as FileError;
}

/**
 * Obsidian Vault 文件读写的最小切片接口。
 *
 * 移动端硬约束：所有落盘只允许走 `app.vault.adapter`（DataAdapter）。
 * 这里只声明 Session 持久化用到的方法，避免依赖完整 DataAdapter，
 * 同时让单元测试可以注入内存实现而不必加载 Obsidian。
 */
export interface VaultFileAdapter {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  append(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  remove(path: string): Promise<void>;
}

/**
 * pi 的 JsonlSessionRepo 需要的 FileSystem 切片（11 个方法）。
 * 直接复用 pi 类型可避免与上游漂移，但为保持移动端零 node 依赖，
 * 这里用结构化的最小定义。
 */
export interface JsonlSessionRepoFileSystem {
  cwd: string;
  absolutePath(path: string): Promise<Result<string, FileError>>;
  joinPath(parts: string[]): Promise<Result<string, FileError>>;
  readTextFile(path: string): Promise<Result<string, FileError>>;
  readTextLines(
    path: string,
    options?: { maxLines?: number },
  ): Promise<Result<string[], FileError>>;
  writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>>;
  appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>>;
  listDir(path: string): Promise<Result<FileInfo[], FileError>>;
  exists(path: string): Promise<Result<boolean, FileError>>;
  createDir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<Result<void, FileError>>;
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<Result<void, FileError>>;
}

/** 归一化 vault 相对路径：折叠重复斜杠、去掉首尾斜杠与 "./" 段。 */
function normalizeVaultPath(path: string): string {
  const segments = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');
  return segments.join('/');
}

/** 取父目录路径（vault 相对，归一化后）。根路径返回空串。 */
function dirname(path: string): string {
  const normalized = normalizeVaultPath(path);
  const idx = normalized.lastIndexOf('/');
  return idx <= 0 ? '' : normalized.slice(0, idx);
}

/**
 * 判断是否为"文件不存在"类错误。Obsidian adapter 在不同平台抛出的错误信息不一致，
 * 这里用宽松的字符串匹配，识别失败时回退为 unknown（绝不抛出，符合 FileSystem 契约）。
 */
function isNotFoundError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes('enoent')
    || message.includes('no such file')
    || message.includes('not exist')
    || message.includes('does not exist')
    || message.includes('not found')
  );
}

function toContentString(content: string | Uint8Array): string {
  if (typeof content === 'string') return content;
  return new TextDecoder().decode(content);
}

/**
 * 把 Obsidian Vault adapter 适配成 pi 的 JsonlSessionRepo 所需的 FileSystem 切片。
 *
 * 设计要点：
 * - 全程只调用注入的 VaultFileAdapter（桌面 = Node adapter，移动 = Capacitor adapter），
 *   不直接 import node 的 fs/path/os/child_process，满足移动端硬约束。
 * - 所有方法返回 Result<T, FileError> 且绝不抛异常（pi FileSystem 契约 types.d.ts:163）。
 * - 路径语义：pi 只会把本类返回的路径（joinPath/absolutePath 产物）再传回本类，
 *   因此用 vault 相对 POSIX 路径自洽即可，无需模拟真实 Node 绝对路径。
 */
export class VaultSessionFileSystem implements JsonlSessionRepoFileSystem {
  /** pi 用 cwd 仅作会话目录编码的输入，对单插件固定为 vault 根标识即可。 */
  readonly cwd: string;

  constructor(private readonly adapter: VaultFileAdapter, cwd = '/') {
    this.cwd = cwd;
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    // vault 相对路径即我们的"绝对"命名空间，归一化后原样返回。
    return ok(normalizeVaultPath(path));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    const joined = parts
      .map((part) => normalizeVaultPath(part))
      .filter((part) => part.length > 0)
      .join('/');
    return ok(joined);
  }

  async readTextFile(path: string): Promise<Result<string, FileError>> {
    const normalized = normalizeVaultPath(path);
    try {
      return ok(await this.adapter.read(normalized));
    } catch (error) {
      return err(this.toFileError(error, normalized));
    }
  }

  async readTextLines(
    path: string,
    options?: { maxLines?: number },
  ): Promise<Result<string[], FileError>> {
    const result = await this.readTextFile(path);
    if (!result.ok) return result;
    // Obsidian adapter 无逐行读取 API：整读后按 \n 切分（jsonl-storage 的 readTextLines 用法）。
    let lines = result.value.split('\n');
    if (options?.maxLines !== undefined && options.maxLines >= 0) {
      lines = lines.slice(0, options.maxLines);
    }
    return ok(lines);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    const normalized = normalizeVaultPath(path);
    try {
      await this.ensureParentDir(normalized);
      await this.adapter.write(normalized, toContentString(content));
      return ok(undefined);
    } catch (error) {
      return err(this.toFileError(error, normalized));
    }
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
    const normalized = normalizeVaultPath(path);
    try {
      await this.ensureParentDir(normalized);
      await this.adapter.append(normalized, toContentString(content));
      return ok(undefined);
    } catch (error) {
      return err(this.toFileError(error, normalized));
    }
  }

  async listDir(path: string): Promise<Result<FileInfo[], FileError>> {
    const normalized = normalizeVaultPath(path);
    try {
      const listed = await this.adapter.list(normalized);
      const infos: FileInfo[] = [
        ...listed.folders.map((folder) => this.toFileInfo(folder, 'directory')),
        ...listed.files.map((file) => this.toFileInfo(file, 'file')),
      ];
      return ok(infos);
    } catch (error) {
      return err(this.toFileError(error, normalized));
    }
  }

  async exists(path: string): Promise<Result<boolean, FileError>> {
    const normalized = normalizeVaultPath(path);
    try {
      return ok(await this.adapter.exists(normalized));
    } catch (error) {
      return err(this.toFileError(error, normalized));
    }
  }

  async createDir(
    path: string,
    _options?: { recursive?: boolean },
  ): Promise<Result<void, FileError>> {
    const normalized = normalizeVaultPath(path);
    try {
      // mkdir 在目录已存在时可能抛错，先 exists 判断，递归建中间目录。
      await this.ensureDir(normalized);
      return ok(undefined);
    } catch (error) {
      return err(this.toFileError(error, normalized));
    }
  }

  async remove(
    path: string,
    _options?: { recursive?: boolean; force?: boolean },
  ): Promise<Result<void, FileError>> {
    const normalized = normalizeVaultPath(path);
    try {
      if (!(await this.adapter.exists(normalized))) {
        // force 语义：不存在视为成功。
        return ok(undefined);
      }
      await this.adapter.remove(normalized);
      return ok(undefined);
    } catch (error) {
      return err(this.toFileError(error, normalized));
    }
  }

  /** 递归确保某个路径自身的所有目录段存在。 */
  private async ensureDir(dir: string): Promise<void> {
    if (!dir) return;
    const segments = dir.split('/');
    let current = '';
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!(await this.adapter.exists(current))) {
        await this.adapter.mkdir(current);
      }
    }
  }

  /** 写入前确保父目录存在（pi 约定 writeFile/appendFile 自动建父目录）。 */
  private async ensureParentDir(path: string): Promise<void> {
    await this.ensureDir(dirname(path));
  }

  private toFileInfo(path: string, kind: 'file' | 'directory'): FileInfo {
    const normalized = normalizeVaultPath(path);
    const name = normalized.slice(normalized.lastIndexOf('/') + 1);
    return {
      name,
      path: normalized,
      kind,
      size: 0,
      mtimeMs: 0,
    };
  }

  private toFileError(error: unknown, path: string): FileError {
    const message = error instanceof Error ? error.message : String(error);
    const code: FileErrorCode = isNotFoundError(error) ? 'not_found' : 'unknown';
    return makeFileError(code, message, path, error instanceof Error ? error : undefined);
  }
}

/** 从 Obsidian App 的 vault.adapter 构造一个 VaultFileAdapter（保持窄接口便于测试）。 */
export function createVaultFileAdapter(adapter: {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  append(path: string, data: string): Promise<void>;
  exists(path: string, sensitive?: boolean): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  remove(path: string): Promise<void>;
}): VaultFileAdapter {
  return {
    read: (path) => adapter.read(path),
    write: (path, data) => adapter.write(path, data),
    append: (path, data) => adapter.append(path, data),
    exists: (path) => adapter.exists(path),
    mkdir: (path) => adapter.mkdir(path),
    list: (path) => adapter.list(path),
    remove: (path) => adapter.remove(path),
  };
}
