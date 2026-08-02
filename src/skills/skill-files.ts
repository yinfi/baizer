import { PLUGIN_DATA_DIR } from '../mcp/types';

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
 * 覆盖写——内置为代码所有，每次启动以 bundle 为准（无 staleness）。
 * 返回物化后的文件路径，供 SkillRegistry 记录、read_skill 读取。
 */
export async function materializeBuiltinSkill(
  adapter: Pick<SkillFilesAdapter, 'exists' | 'mkdir' | 'read' | 'write'>,
  name: string,
  skillMd: string,
  skillsDir = USER_SKILLS_DIR,
): Promise<string> {
  const dir = builtinSkillDirPath(name, skillsDir);
  await ensureDirectory(adapter, dir);
  const filePath = skillFilePath(dir);
  const sourcePath = builtinSkillSourcePath(name, skillsDir);
  const bundleHash = hashSkillContent(skillMd);

  if (await adapter.exists(filePath)) {
    const existing = await adapter.read(filePath);
    const sourceHash = await readBuiltinSourceHash(adapter, sourcePath);
    // Before source tracking existed, startup always overwrote builtins. Migrate that
    // legacy file once, then use the marker to preserve subsequent user edits.
    if (sourceHash === null) {
      if (existing !== skillMd) await adapter.write(filePath, skillMd);
      await adapter.write(sourcePath, JSON.stringify({ bundleHash }, null, 2));
      return filePath;
    }
    const isUneditedBundle = existing === skillMd || hashSkillContent(existing) === sourceHash;

    if (!isUneditedBundle) return filePath;
    if (existing !== skillMd) await adapter.write(filePath, skillMd);
  } else {
    await adapter.write(filePath, skillMd);
  }

  await adapter.write(sourcePath, JSON.stringify({ bundleHash }, null, 2));
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
