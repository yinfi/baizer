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
 * 内置为代码所有，磁盘内容以 bundle 为准；但**内容一致时不重写**——
 * 每次启动无条件重写 7 个文件是纯浪费，且移动端每次写盘都要过 native 桥。
 * 返回物化后的文件路径，供 SkillRegistry 记录、read_skill 读取。
 */
export async function materializeBuiltinSkill(
  adapter: Pick<SkillFilesAdapter, 'exists' | 'mkdir' | 'write' | 'read'>,
  name: string,
  skillMd: string,
  skillsDir = USER_SKILLS_DIR,
): Promise<string> {
  const dir = builtinSkillDirPath(name, skillsDir);
  const filePath = skillFilePath(dir);

  // 先比对：命中则一次 read 换掉一次 write + 整条 ensureDirectory。
  // read 抛错（文件不存在）走下面的写入路径。
  try {
    if (await adapter.read(filePath) === skillMd) return filePath;
  } catch {
    // 文件不存在或读失败——继续写入。
  }

  await ensureDirectory(adapter, dir);
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
