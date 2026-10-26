/**
 * session-store/memory-adapter.ts
 *
 * 内存版 `VaultFileAdapter`。两个用途：
 * 1. `conversationId` 缺省的一次性调用（file-back、/edit 等）需要「不持久化的临时会话」——
 *    旧实现用 pi 的 `InMemorySessionRepo`（1.3.0 已移除）。用内存 adapter 跑同一套
 *    `SessionStore`，逻辑零分叉，且天然不碰磁盘。
 * 2. 单元测试注入，避免真实磁盘 IO。
 */

import type { VaultFileAdapter } from '../vault-session-fs';

function normalize(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/');
}

/** 构造一个内存 VaultFileAdapter（可选预置文件内容）。 */
export function createInMemoryVaultAdapter(seed: Record<string, string> = {}): VaultFileAdapter {
  const files = new Map<string, string>();
  for (const [path, content] of Object.entries(seed)) {
    files.set(normalize(path), content);
  }
  return {
    read: async (path) => {
      const key = normalize(path);
      if (!files.has(key)) throw new Error(`ENOENT ${key}`);
      return files.get(key)!;
    },
    write: async (path, data) => { files.set(normalize(path), data); },
    append: async (path, data) => {
      const key = normalize(path);
      files.set(key, (files.get(key) ?? '') + data);
    },
    exists: async (path) => files.has(normalize(path)),
    // 目录在内存实现里是隐含的（由文件路径推导），无需真实建目录。
    mkdir: async () => {},
    list: async (path) => {
      const base = normalize(path);
      const prefix = base ? `${base}/` : '';
      const outFiles: string[] = [];
      const folders = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest.includes('/')) folders.add(prefix + rest.split('/')[0]);
        else outFiles.push(key);
      }
      return { files: outFiles, folders: [...folders] };
    },
    remove: async (path) => { files.delete(normalize(path)); },
  };
}
