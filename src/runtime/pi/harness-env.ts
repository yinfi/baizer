import type { FileError, FileInfo, Result } from '@earendil-works/pi-agent-core';
import { VaultSessionFileSystem, type VaultFileAdapter } from './vault-session-fs';

/**
 * 把 VaultSessionFileSystem 补全为 pi AgentHarness 所需的完整 ExecutionEnv。
 *
 * 背景：JsonlSessionRepo 只用到 FileSystem 的 11 个方法(VaultSessionFileSystem 已实现);
 * 而 AgentHarness 的构造参数 env: ExecutionEnv = FileSystem(完整) + Shell。
 * 完整 FileSystem 还要 readBinaryFile / canonicalPath / fileInfo / createTempDir /
 * createTempFile / cleanup;Shell 要 exec / cleanup。
 *
 * Obsidian 插件(尤其移动端)没有 shell,也不该跑任意进程,故 Shell 用 NoopShell:
 * 所有调用返回 pi 的 Result err 形态(code: 'shell_unavailable'),绝不 throw
 * (pi 契约要求 exec 不得抛异常)。Baizer 的工具集里没有需要 shell 的工具,
 * 因此 Harness 内部不会真正走到 exec。
 *
 * 临时文件/目录:Harness 的核心聊天路径不使用它们(仅某些 compaction 边角可能触及),
 * 用 vault 隐藏目录下的伪临时路径兜底,失败即返回 err,不影响主流程。
 */

function ok<T>(value: T): Result<T, FileError> {
  return { ok: true, value };
}

function makeFileError(code: string, message: string): FileError {
  const error = new Error(message) as Error & { code: string };
  error.name = 'FileError';
  error.code = code;
  return error as unknown as FileError;
}

function err<T>(code: string, message: string): Result<T, FileError> {
  return { ok: false, error: makeFileError(code, message) };
}

/** Shell 执行错误的 Result 形态(pi 的 ExecutionError code)。 */
function shellUnavailable(): { ok: false; error: { code: string; message: string } } {
  return {
    ok: false,
    error: { code: 'shell_unavailable', message: 'Shell execution is not available in the Obsidian runtime.' },
  };
}

const TEMP_ROOT = '.obsidian/baizer-tmp';

/**
 * 完整的 pi ExecutionEnv:委托 VaultSessionFileSystem 处理会话文件读写,
 * 补齐 Harness 需要但会话持久化用不到的方法,并附一个 NoopShell。
 */
export class HarnessExecutionEnv {
  readonly cwd: string;

  constructor(
    private readonly fs: VaultSessionFileSystem,
  ) {
    this.cwd = fs.cwd;
  }

  // ---- 委托给 VaultSessionFileSystem 的方法 ----
  absolutePath(path: string) { return this.fs.absolutePath(path); }
  joinPath(parts: string[]) { return this.fs.joinPath(parts); }
  readTextFile(path: string) { return this.fs.readTextFile(path); }
  readTextLines(path: string, options?: { maxLines?: number }) { return this.fs.readTextLines(path, options); }
  writeFile(path: string, content: string | Uint8Array) { return this.fs.writeFile(path, content); }
  appendFile(path: string, content: string | Uint8Array) { return this.fs.appendFile(path, content); }
  listDir(path: string) { return this.fs.listDir(path); }
  exists(path: string) { return this.fs.exists(path); }
  createDir(path: string, options?: { recursive?: boolean }) { return this.fs.createDir(path, options); }
  remove(path: string, options?: { recursive?: boolean; force?: boolean }) { return this.fs.remove(path, options); }

  // ---- Harness 要求、但会话持久化用不到的 FileSystem 方法 ----
  async readBinaryFile(path: string): Promise<Result<Uint8Array, FileError>> {
    const result = await this.fs.readTextFile(path);
    if (!result.ok) return result;
    return ok(new TextEncoder().encode(result.value));
  }

  async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
    const normalized = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const name = normalized.slice(normalized.lastIndexOf('/') + 1);

    // 先判目录:vault adapter 没有「路径是否目录」的直接 API,用 listDir 探测——
    // 目录能列出内容(即便为空返回 ok),文件则通常返回错误或不作为目录看待。
    // pi 的 loadPromptTemplates 依赖 fileInfo 正确区分 dir/file,故必须先探目录。
    const listed = await this.fs.listDir(normalized);
    if (listed.ok && Array.isArray(listed.value)) {
      // listDir 成功且该路径下有子项,或该路径本身作为目录存在,视为目录。
      const hasChildren = listed.value.length > 0;
      const existsAsFile = await this.fs.exists(normalized);
      // 有子项 → 一定是目录;无子项但存在 → 可能是空目录或文件,回退到文件判定。
      if (hasChildren) {
        return ok({ name, path: normalized, kind: 'directory', size: 0, mtimeMs: 0 });
      }
      // 无子项:若作为文件存在则报文件,否则报空目录(存在性由 exists 决定)。
      if (existsAsFile.ok && existsAsFile.value) {
        return ok({ name, path: normalized, kind: 'file', size: 0, mtimeMs: 0 });
      }
      return ok({ name, path: normalized, kind: 'directory', size: 0, mtimeMs: 0 });
    }

    const existsResult = await this.fs.exists(normalized);
    if (!existsResult.ok) return existsResult;
    if (!existsResult.value) return err('not_found', `Path does not exist: ${path}`);
    return ok({ name, path: normalized, kind: 'file', size: 0, mtimeMs: 0 });
  }

  async canonicalPath(path: string): Promise<Result<string, FileError>> {
    return this.fs.absolutePath(path);
  }

  async createTempDir(prefix = 'tmp-'): Promise<Result<string, FileError>> {
    const dir = `${TEMP_ROOT}/${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const created = await this.fs.createDir(dir, { recursive: true });
    if (!created.ok) return created;
    return ok(dir);
  }

  async createTempFile(options?: { prefix?: string; suffix?: string }): Promise<Result<string, FileError>> {
    const prefix = options?.prefix ?? '';
    const suffix = options?.suffix ?? '';
    const file = `${TEMP_ROOT}/${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}${suffix}`;
    const written = await this.fs.writeFile(file, '');
    if (!written.ok) return written;
    return ok(file);
  }

  // ---- Shell(NoopShell:Obsidian 无 shell) ----
  async exec(): Promise<ReturnType<typeof shellUnavailable>> {
    return shellUnavailable();
  }

  // ---- 生命周期 ----
  async cleanup(): Promise<void> {
    // 无需释放资源;VaultFileAdapter 由插件持有。
  }
}

/** 从 VaultFileAdapter 构造完整的 Harness ExecutionEnv。 */
export function createHarnessExecutionEnv(adapter: VaultFileAdapter, cwd = '/'): HarnessExecutionEnv {
  const fs = new VaultSessionFileSystem(adapter, cwd);
  return new HarnessExecutionEnv(fs);
}
