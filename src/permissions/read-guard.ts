// src/permissions/read-guard.ts — 读侧的点目录守卫
//
// 写侧早有 isObsidianConfigPath()（vault-ops.ts），读侧却没有对应的一层——
// 这个不对称就是缺口。写侧有守卫是「我们拥有的契约」，而读侧目前依赖的是
// 「vault API 恰好不索引点目录」这个**被观察到的行为**：代码库自己在
// skill-generator.ts 与 read-skill.ts 的注释里承认了它，而 read_skill /
// plugin-ctrl 已经证明 adapter.read 能读点目录。
//
// 因此这里补的是**显式拒绝**这一层契约：无论 Obsidian 的实现怎么变，判定都由
// 本模块给出，测试断言的是守卫函数本身，而不是「getFiles() 恰好没返回点目录文件」。

/** 归一化：反斜杠转正斜杠、去首尾斜杠、折叠重复斜杠。 */
function normalize(path: string): string {
  return (path || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
}

/** 路径是否等于 configDir 或落在它之下。 */
export function isConfigDirPath(configDir: string, path: string): boolean {
  const dir = normalize(configDir);
  if (!dir) return false;
  const target = normalize(path);
  return target === dir || target.startsWith(`${dir}/`);
}

/**
 * 路径是否落在本插件的 bundle 目录（`<configDir>/plugins/<PLUGIN_ID>/`）之下。
 *
 * 单独一条而不是靠 configDir 前缀顺带覆盖：它的语义是「我们自己那个装着内置凭据的
 * 文件」，将来若把 bundle 挪出 configDir，这条判定仍成立。
 */
export function isPluginBundlePath(configDir: string, pluginId: string, path: string): boolean {
  const dir = normalize(configDir);
  const id = normalize(pluginId);
  if (!dir || !id) return false;
  const bundleDir = `${dir}/plugins/${id}`;
  const target = normalize(path);
  return target === bundleDir || target.startsWith(`${bundleDir}/`);
}

/** 读取 / 列举 / 搜索三条路径共用的拒绝判定。 */
export function isReadDeniedPath(configDir: string, pluginId: string, path: string): boolean {
  return isConfigDirPath(configDir, path) || isPluginBundlePath(configDir, pluginId, path);
}

/** 拒绝时返回的明确错误——**不返回「文件不存在」**，那会让用户以为路径写错了。 */
export function readDeniedError(path: string): string {
  return `Reading ${path} is not allowed: it is inside the Obsidian configuration directory.`;
}
