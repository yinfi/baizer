#!/usr/bin/env node
// scripts/gen-third-party-licenses.mjs
//
// 生成 THIRD-PARTY-LICENSES.md。
//
// 为什么需要这个文件：Baizer 打成单个 bundled main.js，把生产依赖全部内联进去
// （只有 obsidian / electron / @codemirror / @lezer / Node 内置模块是 external）。
// 其中有 40+ 个包是 Apache-2.0，而 Apache-2.0 第 4(d) 条要求随分发保留署名 ——
// 仓库根目录那份 MIT 不能免除这项义务。所以必须随插件一起发一份署名清单。
//
// 用法：
//   npm run licenses          # 重新生成 THIRD-PARTY-LICENSES.md
//
// 依赖变动后（增删依赖、升级大版本）都应重跑，否则清单会与实际 bundle 不一致。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execSync } from 'node:child_process';

/** 从 npm ls 的生产依赖树里收集所有包名（含传递依赖）。 */
function collectProdPackages() {
  let tree;
  try {
    tree = JSON.parse(execSync('npm ls --omit=dev --all --json', {
      encoding: 'utf8',
      maxBuffer: 1e8,
    }));
  } catch (error) {
    // npm ls 在有 peer 警告时会以非零退出，但 stdout 仍是完整 JSON。
    tree = JSON.parse(error.stdout || '{}');
  }

  const names = new Set();
  (function recurse(node) {
    if (!node || !node.dependencies) return;
    for (const [name, child] of Object.entries(node.dependencies)) {
      names.add(name);
      recurse(child);
    }
  })(tree);
  return names;
}

/** 读每个包自己的 package.json 取版本与许可证（不信任聚合工具的缓存）。 */
function readLicenses(names) {
  const rows = [];
  for (const name of names) {
    const pkgJson = path.join('node_modules', ...name.split('/'), 'package.json');
    if (!fs.existsSync(pkgJson)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
      const license = typeof meta.license === 'string'
        ? meta.license
        : (meta.license && meta.license.type) || 'UNKNOWN';
      rows.push({ name, version: meta.version, license });
    } catch {
      rows.push({ name, version: '(unreadable)', license: 'UNKNOWN' });
    }
  }
  return rows;
}

function groupByLicense(rows) {
  const groups = {};
  for (const row of rows) {
    (groups[row.license] = groups[row.license] || []).push(row);
  }
  for (const list of Object.values(groups)) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return groups;
}

function render(rows) {
  const groups = groupByLicense(rows);
  const licenses = Object.keys(groups).sort();

  let out = `# Third-Party Licenses

Baizer is distributed as a single bundled \`main.js\`. That bundle inlines the
dependencies listed below; only \`obsidian\`, \`electron\`, \`@codemirror/*\`,
\`@lezer/*\`, and Node built-ins are left external.

This file exists to satisfy the attribution requirements of those licenses —
notably Apache License 2.0 section 4(d), which is not discharged by Baizer's own
MIT license. Baizer's own code is MIT; see [LICENSE](./LICENSE).

Regenerate with \`npm run licenses\`.

## Summary

| License | Packages |
|---------|----------|
`;
  for (const license of licenses) {
    out += `| ${license} | ${groups[license].length} |\n`;
  }
  out += `\nTotal: ${rows.length} bundled packages.\n`;

  if (groups['Apache-2.0']) {
    out += `
## Apache License 2.0

The following packages are licensed under the Apache License, Version 2.0. You
may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0.
Each retains its own copyright notices; see the package sources for details.

`;
    for (const row of groups['Apache-2.0']) {
      out += `- ${row.name} ${row.version}\n`;
    }
  }

  for (const license of licenses) {
    if (license === 'Apache-2.0') continue;
    out += `\n## ${license}\n\n`;
    for (const row of groups[license]) {
      out += `- ${row.name} ${row.version}\n`;
    }
  }

  out += `
## Note on the pi runtime

\`@earendil-works/pi-agent-core\` and \`@earendil-works/pi-ai\` declare MIT in
their \`package.json\` but ship no LICENSE file in the published tarball (their
\`files\` field includes only \`dist\` and \`README.md\`). The MIT grant is taken
from the package metadata and the upstream README.
`;
  return out;
}

const rows = readLicenses(collectProdPackages());
if (rows.length === 0) {
  console.error('No production dependencies found. Run npm install first.');
  process.exit(1);
}
fs.writeFileSync('THIRD-PARTY-LICENSES.md', render(rows));
console.log(`THIRD-PARTY-LICENSES.md written (${rows.length} packages).`);
