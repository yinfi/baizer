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
