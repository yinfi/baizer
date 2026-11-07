// src/knowledge/stale-marker.ts
//
// Persisted "last checked" marker for stale detection.
//
// KnowledgeStatusService.getStaleFiles() used to read and hash the full content of every
// tracked, already-compiled note on every plugin load. The marker remembers, per source note,
// the (mtime, size) of the note and of its compiled summary at the moment a full hash comparison
// last found them in sync. On the next load a note whose fingerprints are unchanged is skipped;
// anything that changed, is missing from the marker, or has no readable fingerprint goes through
// the full check exactly as before. A missing or corrupt marker file is just an empty marker, so
// the worst case is the old behaviour (one full pass), never a missed stale note.

import type { App, TFile } from 'obsidian';
import { PLUGIN_ID } from '../mcp/types';
import { logger } from '../utils/logger';

// v2: added per-entry verifiedAt (see MAX_VERIFY_AGE_MS).
const MARKER_VERSION = 2;

/**
 * 指纹只比 (mtime, size)：保留时间戳的同步/还原、或 1 秒精度文件系统上的同秒改写，
 * 都可能"看起来没变"。所以每条记录带一个 verifiedAt，超过这个时长就强制走一次全量哈希，
 * 把最坏情况的漏检窗口限制在这个天数内。
 */
const MAX_VERIFY_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface FileFingerprint {
  mtime: number;
  size: number;
}

interface MarkerEntry {
  summaryPath: string;
  source: FileFingerprint;
  summary: FileFingerprint;
  /** 上次全量哈希确认同步的时刻（epoch ms）。 */
  verifiedAt: number;
}

interface MarkerFile {
  version: number;
  entries: Record<string, MarkerEntry>;
}

/** (mtime, size) of a file, or null when the host does not expose a usable stat. */
export function fingerprintOf(file: TFile | null | undefined): FileFingerprint | null {
  const stat = (file as { stat?: { mtime?: unknown; size?: unknown } } | null | undefined)?.stat;
  if (!stat || typeof stat.mtime !== 'number' || typeof stat.size !== 'number') return null;
  if (!Number.isFinite(stat.mtime) || !Number.isFinite(stat.size)) return null;
  return { mtime: stat.mtime, size: stat.size };
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.mtime === b.mtime && a.size === b.size;
}

function isFingerprint(value: unknown): value is FileFingerprint {
  const v = value as FileFingerprint | null;
  return !!v && typeof v.mtime === 'number' && typeof v.size === 'number'
    && Number.isFinite(v.mtime) && Number.isFinite(v.size);
}

function isEntry(value: unknown): value is MarkerEntry {
  const v = value as MarkerEntry | null;
  return !!v && typeof v.summaryPath === 'string' && isFingerprint(v.source) && isFingerprint(v.summary)
    && typeof v.verifiedAt === 'number' && Number.isFinite(v.verifiedAt);
}

export class StaleCheckMarker {
  private entries = new Map<string, MarkerEntry>();
  private dirty = false;

  constructor(private app: App) {}

  /** Marker lives next to the other private plugin data, under the vault's real config dir. */
  private get path(): string | null {
    const configDir = (this.app.vault as { configDir?: string }).configDir;
    if (!configDir) return null;
    return `${configDir}/${PLUGIN_ID}-knowledge/stale-check.json`;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Replaces the in-memory state with the persisted marker. Anything unreadable means "empty". */
  async load(): Promise<void> {
    this.entries.clear();
    this.dirty = false;
    const path = this.path;
    const adapter = this.app.vault.adapter;
    if (!path || typeof adapter?.exists !== 'function' || typeof adapter?.read !== 'function') return;
    try {
      if (!(await adapter.exists(path))) return;
      const parsed = JSON.parse(await adapter.read(path)) as Partial<MarkerFile> | null;
      if (!parsed || parsed.version !== MARKER_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
        return;
      }
      for (const [sourcePath, entry] of Object.entries(parsed.entries)) {
        if (isEntry(entry)) this.entries.set(sourcePath, entry);
      }
    } catch (error) {
      // Corrupt or unreadable: fall back to a full check. Never let this block stale detection.
      this.entries.clear();
      logger.warn(`Stale-check marker unreadable, falling back to a full check: ${String(error)}`, 'StaleCheckMarker');
    }
  }

  /**
   * True only when both the source note and its summary still have exactly the fingerprints that
   * were recorded after a full hash comparison, and the summary path is unchanged.
   */
  isUnchanged(source: TFile, summary: TFile | null, summaryPath: string): boolean {
    const entry = this.entries.get(source.path);
    if (!entry || entry.summaryPath !== summaryPath) return false;
    // 超过 MAX_VERIFY_AGE_MS 没做过全量比对就重新比一次，别让指纹碰撞无限期存活。
    if (Date.now() - entry.verifiedAt > MAX_VERIFY_AGE_MS) return false;
    const sourcePrint = fingerprintOf(source);
    const summaryPrint = fingerprintOf(summary);
    if (!sourcePrint || !summaryPrint) return false;
    return sameFingerprint(entry.source, sourcePrint) && sameFingerprint(entry.summary, summaryPrint);
  }

  /** Records that a full comparison just found source and summary in sync. */
  recordFresh(source: TFile, summary: TFile | null, summaryPath: string): void {
    const sourcePrint = fingerprintOf(source);
    const summaryPrint = fingerprintOf(summary);
    if (!sourcePrint || !summaryPrint) {
      this.forget(source.path);
      return;
    }
    const previous = this.entries.get(source.path);
    if (previous && previous.summaryPath === summaryPath
      && sameFingerprint(previous.source, sourcePrint) && sameFingerprint(previous.summary, summaryPrint)) {
      // 指纹没变，但 verifiedAt 要刷新：这次全量比对刚刚确认过它是同步的。
      if (Date.now() - previous.verifiedAt <= MAX_VERIFY_AGE_MS) return;
    }
    this.entries.set(source.path, { summaryPath, source: sourcePrint, summary: summaryPrint, verifiedAt: Date.now() });
    this.dirty = true;
  }

  forget(sourcePath: string): void {
    if (this.entries.delete(sourcePath)) this.dirty = true;
  }

  /** Drops entries whose source was not confirmed in sync during this pass (stale, deleted, moved). */
  retainOnly(confirmedSourcePaths: ReadonlySet<string>): void {
    for (const sourcePath of Array.from(this.entries.keys())) {
      if (!confirmedSourcePaths.has(sourcePath)) this.forget(sourcePath);
    }
  }

  /** Writes the marker only when something changed. Failure is logged and otherwise harmless. */
  async save(): Promise<void> {
    if (!this.dirty) return;
    const path = this.path;
    const adapter = this.app.vault.adapter;
    if (!path || typeof adapter?.write !== 'function') return;
    try {
      const dir = path.slice(0, path.lastIndexOf('/'));
      if (typeof adapter.exists === 'function' && typeof adapter.mkdir === 'function' && !(await adapter.exists(dir))) {
        await adapter.mkdir(dir);
      }
      const body: MarkerFile = { version: MARKER_VERSION, entries: Object.fromEntries(this.entries) };
      await adapter.write(path, JSON.stringify(body));
      this.dirty = false;
    } catch (error) {
      logger.warn(`Could not persist stale-check marker: ${String(error)}`, 'StaleCheckMarker');
    }
  }
}