import { parse } from 'yaml';
import { PLUGIN_DATA_DIR } from '../mcp/types';
import { computeSchemaHash } from '../knowledge/ontology';

export interface ListedFilesLike {
  files: string[];
  folders: string[];
}

export interface SkillFilesAdapter {
  exists(normalizedPath: string, sensitive?: boolean): Promise<boolean>;
  list(normalizedPath: string): Promise<ListedFilesLike>;
  read(normalizedPath: string): Promise<string>;
  write(normalizedPath: string, data: string): Promise<void>;
  mkdir(normalizedPath: string): Promise<void>;
}

export const SKILL_FILE_NAME = 'SKILL.md';
export const SKILL_SKIP_MARKER_FILE_NAME = '.skip-generation.json';
export const BUILTIN_SKILL_SOURCE_FILE_NAME = '.builtin-source.json';
export const USER_SKILLS_DIR = `${PLUGIN_DATA_DIR}/skills`;

function joinPath(...segments: string[]): string {
  return segments
    .filter(Boolean)
    .join('/')
    .replace(/\/{2,}/g, '/');
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || '';
}

export function skillFilePath(dirPath: string): string {
  return joinPath(dirPath, SKILL_FILE_NAME);
}

/** 内置 skill 的物化目录：与用户 skill 同根，按 skill name 分子目录。 */
export function builtinSkillDirPath(
  name: string,
  skillsDir = USER_SKILLS_DIR,
): string {
  return joinPath(skillsDir, name);
}

/** 内置 skill 物化后的 SKILL.md 路径（= read_skill / 系统提示 location 指向的真实路径）。 */
export function builtinSkillFilePath(
  name: string,
  skillsDir = USER_SKILLS_DIR,
): string {
  return skillFilePath(builtinSkillDirPath(name, skillsDir));
}

export function builtinSkillSourcePath(
  name: string,
  skillsDir = USER_SKILLS_DIR,
): string {
  return joinPath(builtinSkillDirPath(name, skillsDir), BUILTIN_SKILL_SOURCE_FILE_NAME);
}

/**
 * 物化一个内置 skill 到隐藏目录：写入 <skillsDir>/<name>/SKILL.md。
 *
 * 两条约束同时成立：
 * - 磁盘以 bundle 为准，但**用户手改过的文件不覆盖**——靠 `.builtin-source.json`
 *   里的 bundleHash 区分"上一版 bundle"与"用户编辑"。
 * - **内容与 marker 都已就位时零写入**——每次启动无条件重写 7 个文件是纯浪费，
 *   移动端每次写盘还要过 native 桥。bundle 升级那一次才付 2 次写（正文 + marker）。
 *
 * 返回物化后的文件路径，供 SkillRegistry 记录、read_skill 读取。
 */
export async function materializeBuiltinSkill(
  adapter: Pick<SkillFilesAdapter, 'exists' | 'mkdir' | 'read' | 'write'>,
  name: string,
  skillMd: string,
  skillsDir = USER_SKILLS_DIR,
): Promise<string> {
  const dir = builtinSkillDirPath(name, skillsDir);
  const filePath = skillFilePath(dir);
  const sourcePath = builtinSkillSourcePath(name, skillsDir);
  const bundleHash = hashSkillContent(skillMd);
  const writeSourceMarker = () =>
    adapter.write(sourcePath, JSON.stringify({ bundleHash }, null, 2));

  // 直接 read 而不是先 exists：常态是文件已存在且内容一致，一次 read 就能收工。
  // read 抛错（文件不存在）走首次写入路径。
  let existing: string | null;
  try {
    existing = await adapter.read(filePath);
  } catch {
    existing = null;
  }

  if (existing === null) {
    await ensureDirectory(adapter, dir);
    await adapter.write(filePath, skillMd);
    await writeSourceMarker();
    return filePath;
  }

  const sourceHash = await readBuiltinSourceHash(adapter, sourcePath);

  // 正文与 marker 都已是当前 bundle：整条路径不写盘，也不必 ensureDirectory
  // （读得到 SKILL.md 就说明目录在）。
  if (existing === skillMd && sourceHash === bundleHash) return filePath;

  // Before source tracking existed, startup always overwrote builtins. Migrate that
  // legacy file once, then use the marker to preserve subsequent user edits.
  if (sourceHash === null) {
    if (existing !== skillMd) await adapter.write(filePath, skillMd);
    await writeSourceMarker();
    return filePath;
  }

  // 手改过：正文既不等于当前 bundle，也不等于 marker 记录的上一版 bundle。
  // 此时连 marker 都不更新——否则下次启动会把手改内容当成 bundle 基线。
  const isUneditedBundle = existing === skillMd || hashSkillContent(existing) === sourceHash;
  if (!isUneditedBundle) return filePath;

  if (existing !== skillMd) await adapter.write(filePath, skillMd);
  await writeSourceMarker();
  return filePath;
}

async function readBuiltinSourceHash(
  adapter: Pick<SkillFilesAdapter, 'exists' | 'read'>,
  sourcePath: string,
): Promise<string | null> {
  if (!await adapter.exists(sourcePath)) return null;
  try {
    const parsed = JSON.parse(await adapter.read(sourcePath));
    return typeof parsed.bundleHash === 'string' ? parsed.bundleHash : null;
  } catch {
    return null;
  }
}

function hashSkillContent(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index++) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}


export function pluginSkillDirPath(
  pluginId: string,
  skillsDir = USER_SKILLS_DIR,
): string {
  return joinPath(skillsDir, `plugin-${pluginId}`);
}

export function pluginSkillFilePath(
  pluginId: string,
  skillsDir = USER_SKILLS_DIR,
): string {
  return skillFilePath(pluginSkillDirPath(pluginId, skillsDir));
}

export function pluginSkillSkipMarkerPath(
  pluginId: string,
  skillsDir = USER_SKILLS_DIR,
): string {
  return joinPath(pluginSkillDirPath(pluginId, skillsDir), SKILL_SKIP_MARKER_FILE_NAME);
}

/** 生成的 skill 的来源追踪文件：记录生成时的插件版本，供升级后重新生成判断。 */
export const SKILL_GENERATED_FROM_FILE_NAME = 'generated-from.json';

export function pluginSkillGeneratedFromPath(
  pluginId: string,
  skillsDir = USER_SKILLS_DIR,
): string {
  return joinPath(pluginSkillDirPath(pluginId, skillsDir), SKILL_GENERATED_FROM_FILE_NAME);
}

export async function pluginSkillFileExists(
  adapter: Pick<SkillFilesAdapter, 'exists'>,
  pluginId: string,
  skillsDir = USER_SKILLS_DIR,
): Promise<boolean> {
  return adapter.exists(pluginSkillFilePath(pluginId, skillsDir));
}

// ==================== 派生 skill 溯源 ====================

/** 派生 skill 写入时记录的来源：插件 id、当时的插件版本、body 哈希。 */
export interface SkillProvenance {
  plugin: string;
  version: string;
  bodyHash: string;
}

/**
 * 溯源读取结果。
 * present=false 表示这个文件没有 source 块（旧版生成或手写 skill），不是错误；
 * 此时 handEdited 为 null——未知，而非"未改过"。
 */
export interface SkillProvenanceReport {
  present: boolean;
  provenance: SkillProvenance | null;
  /** body 是否被手工改过：重算当前 body 的哈希与记录值比对。 */
  handEdited: boolean | null;
}

/**
 * "无溯源"报告。每次新建对象——调用方（reconcile / 设置页）会在报告上
 * 挂显示用字段，共享同一个常量会让一次改写污染后续所有读取。
 */
function absentProvenance(): SkillProvenanceReport {
  return { present: false, provenance: null, handEdited: null };
}

/**
 * 按 frontmatter 边界切开 SKILL.md。
 * 切法与 parseBuiltinSkill 保持一致，body 哈希覆盖的正是模型读到的那段文本。
 */
export function splitSkillFrontmatter(
  raw: string,
): { frontmatter: string | null; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: normalized.trim() };
  return { frontmatter: match[1], body: match[2].trim() };
}

/**
 * 计算 body 哈希（复用 knowledge 的 djb2，纯 JS、移动端可用）。
 * 先归一化换行与首尾空白，避免行尾差异被误判为手工编辑。
 */
export function computeSkillBodyHash(body: string): string {
  const normalized = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  return computeSchemaHash(normalized);
}

/** 从 SKILL.md 原文恢复溯源信息；无 source 块时报告"不存在"而非抛错。 */
export function readSkillProvenanceFromText(raw: string): SkillProvenanceReport {
  const { frontmatter, body } = splitSkillFrontmatter(raw);
  const provenance = frontmatter === null ? null : parseProvenance(frontmatter);
  if (!provenance) return absentProvenance();

  return {
    present: true,
    provenance,
    handEdited: computeSkillBodyHash(body) !== provenance.bodyHash,
  };
}

/** frontmatter YAML 里的 source 嵌套映射；缺 plugin 或 body_hash 视为无溯源。 */
function parseProvenance(frontmatter: string): SkillProvenance | null {
  let fm: any;
  try {
    fm = parse(frontmatter);
  } catch {
    return null;
  }

  const source = fm?.source;
  if (!source || typeof source !== 'object') return null;

  const plugin = typeof source.plugin === 'string' ? source.plugin.trim() : '';
  const bodyHash = typeof source.body_hash === 'string' ? source.body_hash.trim() : '';
  if (!plugin || !bodyHash) return null;

  const version = source.version === undefined || source.version === null
    ? ''
    : String(source.version).trim();
  return { plugin, version, bodyHash };
}

/**
 * 文件版溯源读取：文件不存在时同样报告"不存在"。
 * 读取失败（文件被锁、正在删除）也报告"不存在"并留一条 warn——
 * 调用方要遍历所有 plugin-* skill，单个文件不该中断整轮。
 */
export async function readSkillProvenanceFromFile(
  adapter: Pick<SkillFilesAdapter, 'exists' | 'read'>,
  filePath: string,
): Promise<SkillProvenanceReport> {
  let raw: string | null;
  try {
    raw = await readTextIfExists(adapter, filePath);
  } catch (e: any) {
    console.warn(`[skill-files] Failed to read provenance from ${filePath}:`, e?.message ?? e);
    return absentProvenance();
  }
  if (raw === null) return absentProvenance();
  return readSkillProvenanceFromText(raw);
}

/** 按插件 id 读溯源——reconcile 与设置页的入口。 */
export async function readPluginSkillProvenance(
  adapter: Pick<SkillFilesAdapter, 'exists' | 'read'>,
  pluginId: string,
  skillsDir = USER_SKILLS_DIR,
): Promise<SkillProvenanceReport> {
  return readSkillProvenanceFromFile(
    adapter,
    pluginSkillFilePath(pluginId, skillsDir),
  );
}

export async function readTextIfExists(
  adapter: Pick<SkillFilesAdapter, 'exists' | 'read'>,
  path: string,
): Promise<string | null> {
  if (!await adapter.exists(path)) return null;
  return adapter.read(path);
}

/**
 * 列出 skill 目录下所有 SKILL.md。
 *
 * `skipDirNames` 用于排除已在内存中注册的内置 skill 子目录：它们刚被本次启动
 * 物化到同一个根目录下，回读只会拿到 7 个同名条目并被 registerUserFromMd 全部
 * 丢弃——每个都要付一次 exists + 一次 read，纯无用功。
 */
export async function listSkillFilePaths(
  adapter: Pick<SkillFilesAdapter, 'exists' | 'list'>,
  dirPath = USER_SKILLS_DIR,
  skipDirNames: readonly string[] = [],
): Promise<string[]> {
  if (!await adapter.exists(dirPath)) return [];

  const listed = await adapter.list(dirPath);
  const paths = new Set<string>();
  const skip = new Set(skipDirNames);

  for (const filePath of listed.files) {
    if (basename(filePath) === SKILL_FILE_NAME) {
      paths.add(filePath);
    }
  }

  for (const folderPath of listed.folders) {
    if (skip.has(basename(folderPath))) continue;
    const filePath = skillFilePath(folderPath);
    if (await adapter.exists(filePath)) {
      paths.add(filePath);
    }
  }

  return [...paths].sort();
}

/**
 * 确保目录存在。自深向浅探测第一个已存在的祖先，再由此向下补建。
 *
 * 为什么不是自浅向深逐层 exists：那样即使整棵树都已存在，也要为每一层付一次
 * IO（`.obsidian/baizer/skills/<name>` = 4 次 × 7 个内置 skill = 28 次）。
 * 常态是目录早已存在，自深向浅只需 1 次即可返回。
 */
export async function ensureDirectory(
  adapter: Pick<SkillFilesAdapter, 'exists' | 'mkdir'>,
  dirPath: string,
): Promise<void> {
  const paths: string[] = [];
  let currentPath = '';
  for (const segment of dirPath.split('/').filter(Boolean)) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    paths.push(currentPath);
  }

  let firstMissing = paths.length;
  for (let i = paths.length - 1; i >= 0; i--) {
    if (await adapter.exists(paths[i])) break;
    firstMissing = i;
  }

  for (let i = firstMissing; i < paths.length; i++) {
    await adapter.mkdir(paths[i]);
  }
}
