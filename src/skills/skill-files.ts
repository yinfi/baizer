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

/**
 * 物化一个内置 skill 到隐藏目录：写入 <skillsDir>/<name>/SKILL.md。
 * 覆盖写——内置为代码所有，每次启动以 bundle 为准（无 staleness）。
 * 返回物化后的文件路径，供 SkillRegistry 记录、read_skill 读取。
 */
export async function materializeBuiltinSkill(
  adapter: Pick<SkillFilesAdapter, 'exists' | 'mkdir' | 'write'>,
  name: string,
  skillMd: string,
  skillsDir = USER_SKILLS_DIR,
): Promise<string> {
  const dir = builtinSkillDirPath(name, skillsDir);
  await ensureDirectory(adapter, dir);
  const filePath = skillFilePath(dir);
  await adapter.write(filePath, skillMd);
  return filePath;
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

export async function listSkillFilePaths(
  adapter: Pick<SkillFilesAdapter, 'exists' | 'list'>,
  dirPath = USER_SKILLS_DIR,
): Promise<string[]> {
  if (!await adapter.exists(dirPath)) return [];

  const listed = await adapter.list(dirPath);
  const paths = new Set<string>();

  for (const filePath of listed.files) {
    if (basename(filePath) === SKILL_FILE_NAME) {
      paths.add(filePath);
    }
  }

  for (const folderPath of listed.folders) {
    const filePath = skillFilePath(folderPath);
    if (await adapter.exists(filePath)) {
      paths.add(filePath);
    }
  }

  return [...paths].sort();
}

export async function ensureDirectory(
  adapter: Pick<SkillFilesAdapter, 'exists' | 'mkdir'>,
  dirPath: string,
): Promise<void> {
  let currentPath = '';

  for (const segment of dirPath.split('/').filter(Boolean)) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    if (!await adapter.exists(currentPath)) {
      await adapter.mkdir(currentPath);
    }
  }
}
