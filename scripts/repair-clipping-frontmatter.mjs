#!/usr/bin/env node
// scripts/repair-clipping-frontmatter.mjs
//
// 一次性清洗脚本：修复被知识库自动编译回退循环损坏的剪藏文件 frontmatter。
//
// 背景（见 FORYF.md 2026-07-05 两条）：
//   历史上 fixAndSetFrontmatter 回退路径非幂等，对含冒号的值反复翻倍转义、
//   每轮 append 一份 knowledge_status / 每轮新生成一个 source_id，最终把少数
//   剪藏文件的 frontmatter 撑成非法 YAML。代码根因已修复（不再恶化），但已损坏
//   的历史文件需要本脚本还原。
//
// 三种已知损坏形态：
//   A. 转义炸弹：created/source/author 的值嵌套几十层 \" ，需剥引号还原原始值。
//   B. 字段堆积：knowledge_status / knowledge_source_id 等重复几十份。
//   C. 双 frontmatter 块：文件开头有两个 ---...--- 块，原始 frontmatter 被挤进正文。
//
// 处理策略（已与用户确认）：
//   - 还原 created/source/author 为干净原始值（剥掉所有 \ 和 "）。
//   - 合并同一文件内出现的多个 frontmatter 块 / 重复字段。
//   - 清空全部 knowledge_* 字段（对应摘要均不存在，交给插件事后重新注册编译）。
//   - 正文（最后一个 --- 之后的内容）零改动。
//   - 修复后用 yaml 解析校验；解析仍失败的文件不写盘、单独报告。
//
// 安全设计：
//   - 默认 dry-run：只打印将改哪些文件、before/after diff，不写盘。
//   - --apply 才真正写盘；写盘前把待改文件备份到 _repair_backup_<时间戳>/。
//   - 只处理「检测为损坏」的文件（合法 frontmatter 的文件跳过，不 touch mtime）。
//
// 用法：
//   node scripts/repair-clipping-frontmatter.mjs "D:/code/obsidian/Assets/网页剪藏"          # dry-run
//   node scripts/repair-clipping-frontmatter.mjs "D:/code/obsidian/Assets/网页剪藏" --apply   # 落盘

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import YAML from 'yaml';

const KNOWLEDGE_KEYS = [
  'knowledge_status',
  'knowledge_source_id',
  'knowledge_compiled_at',
  'knowledge_summary',
  'knowledge_error',
  'knowledge_pending_reason',
];

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const targetDir = argv.find((a) => !a.startsWith('--'));

if (!targetDir) {
  console.error('用法: node scripts/repair-clipping-frontmatter.mjs <剪藏目录> [--apply]');
  process.exit(1);
}
if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
  console.error(`目录不存在: ${targetDir}`);
  process.exit(1);
}

/** 从被翻倍转义的值里剥出干净原始值：去掉所有反斜杠和双引号后 trim。
 *  已验证对 created(ISO 时间戳)/source(URL) 可靠还原。 */
function unescapeBomb(raw) {
  return String(raw).replace(/[\\"]/g, '').trim();
}

/** 判断一个值是否是被炸的转义炸弹（含 \" 序列）。 */
function isBombed(raw) {
  return /\\"/.test(String(raw));
}

/** 找出文件开头「连续的」frontmatter 块的结束位置。
 *  返回 { blocks: string[][], bodyStart: number }：
 *  - blocks：每个块的原始行数组（不含 --- 分隔线）
 *  - bodyStart：正文在原文中的字符起点
 *  连续块指形如 ---\n...\n---\n---\n...\n--- 的紧邻多块（损坏形态 C）。 */
function parseLeadingFrontmatterBlocks(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') return null;

  const blocks = [];
  let i = 0;
  while (lines[i] === '---') {
    const block = [];
    i++; // 跳过开头的 ---
    while (i < lines.length && lines[i] !== '---') {
      block.push(lines[i]);
      i++;
    }
    if (i >= lines.length) return null; // 没有闭合 ---，结构异常，交给上层跳过
    blocks.push(block);
    i++; // 跳过闭合的 ---
    // 紧接着又是 --- 则继续吃下一个块（形态 C）；否则结束
  }

  // 正文从第 i 行开始
  const bodyStart = lines.slice(0, i).join('\n').length + (content.includes('\r\n') ? 2 : 1);
  return { blocks, bodyStartLine: i };
}

/** 把单行的值部分解析成合适的 JS 类型：
 *  - 转义炸弹 → 剥引号还原为字符串
 *  - 空数组字面量 [] / 空对象 {} → 原生空容器
 *  - 简单 flow 数组 [a, b] → 数组（仅当能被 yaml 安全解析且结果是数组时）
 *  - 其余（含 URL、含冒号的作者名、时间戳文本等）→ 去掉包裹引号后的字符串
 *  刻意不对任意标量做 YAML.parse，避免 "作者: 水青一木" 被误解析成 map。 */
function parseScalar(rawVal) {
  const val = String(rawVal).trim();
  if (isBombed(val)) return unescapeBomb(val);
  if (val === '[]') return [];
  if (val === '{}') return {};
  // 仅对明确的 flow 数组尝试类型化解析
  if (/^\[.*\]$/.test(val)) {
    try {
      const parsed = YAML.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* 落到字符串分支 */
    }
  }
  return val.replace(/^["']|["']$/g, '').trim();
}

/** 从若干 frontmatter 块的所有行里，提取「非 knowledge_ 的原始字段」，
 *  同名字段取第一次出现的、可还原的干净值。返回有序 Map。 */
function collectOriginalFields(blocks) {
  const fields = new Map(); // key -> value(原生类型)
  for (const block of blocks) {
    for (const line of block) {
      const m = line.match(/^([\w-]+):\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      if (KNOWLEDGE_KEYS.includes(key)) continue; // knowledge_ 字段一律丢弃
      if (fields.has(key)) continue; // 已有则保留首个
      fields.set(key, parseScalar(m[2]));
    }
  }
  return fields;
}

/** 用 yaml 库把字段序列化成合法 frontmatter 块（含首尾 ---）。 */
function buildFrontmatter(fields) {
  const obj = {};
  for (const [k, v] of fields) obj[k] = v;
  // yaml.stringify 会正确处理含冒号/中文/特殊字符的值与数组类型
  const body = YAML.stringify(obj).replace(/\n$/, '');
  return `---\n${body}\n---\n`;
}

/** 判断文件是否损坏，需要清洗。损坏 = 满足任一：
 *  - frontmatter 值里有转义炸弹（\"）
 *  - 有重复的 knowledge_status / knowledge_source_id
 *  - 文件开头有多个连续 frontmatter 块（形态 C）
 *  - 现有 frontmatter 用 yaml 解析失败
 *  返回 { damaged: boolean, reasons: string[] }。 */
function detectDamage(content) {
  const reasons = [];
  const parsed = parseLeadingFrontmatterBlocks(content);
  if (!parsed) return { damaged: false, reasons: [] };

  if (parsed.blocks.length > 1) reasons.push(`${parsed.blocks.length} 个连续 frontmatter 块`);

  const allLines = parsed.blocks.flat();
  const statusCount = allLines.filter((l) => /^knowledge_status:/.test(l)).length;
  const sidCount = allLines.filter((l) => /^knowledge_source_id:/.test(l)).length;
  if (statusCount > 1) reasons.push(`knowledge_status ×${statusCount}`);
  if (sidCount > 1) reasons.push(`knowledge_source_id ×${sidCount}`);

  const bombed = allLines.filter((l) => {
    const m = l.match(/^([\w-]+):\s*(.*)$/);
    return m && isBombed(m[2]);
  });
  if (bombed.length > 0) reasons.push(`${bombed.length} 个字段值转义炸弹`);

  // 单块时用 yaml 试解析，捕捉其它非法 YAML
  if (parsed.blocks.length === 1) {
    try {
      YAML.parse(parsed.blocks[0].join('\n'));
    } catch {
      reasons.push('frontmatter YAML 解析失败');
    }
  }

  return { damaged: reasons.length > 0, reasons };
}

/** 对损坏文件生成修复后的完整内容；失败返回 null。 */
function repairContent(content) {
  const parsed = parseLeadingFrontmatterBlocks(content);
  if (!parsed) return null;

  const fields = collectOriginalFields(parsed.blocks);
  const newFm = buildFrontmatter(fields);

  // 校验：新 frontmatter 必须能被 yaml 解析
  try {
    YAML.parse(newFm.replace(/^---\n/, '').replace(/\n---\n$/, ''));
  } catch (e) {
    return { error: `修复后 YAML 仍非法: ${e.message}` };
  }

  // 取正文：跳过开头所有连续 frontmatter 块
  const lines = content.split(/\r?\n/);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const body = lines.slice(parsed.bodyStartLine).join(eol);
  // 正文前保留一个空行分隔（若正文非空且不以空行开头）
  const newContent = newFm + (body.startsWith('\n') || body.startsWith('\r\n') ? body : '\n' + body);
  return { content: newContent, fields };
}

function shortDiff(before, after) {
  const b = before.match(/^---[\s\S]*?\n---/);
  const a = after.match(/^---[\s\S]*?\n---/);
  return {
    beforeFm: b ? b[0] : '(无)',
    afterFm: a ? a[0] : '(无)',
  };
}

// ---- 主流程 ----
const files = fs
  .readdirSync(targetDir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => path.join(targetDir, f));

const toFix = [];
const failed = [];

for (const fp of files) {
  let content;
  try {
    content = fs.readFileSync(fp, 'utf8');
  } catch {
    continue;
  }
  const { damaged, reasons } = detectDamage(content);
  if (!damaged) continue;

  const result = repairContent(content);
  if (!result || result.error) {
    failed.push({ fp, reason: result?.error || '无法解析结构' });
    continue;
  }
  toFix.push({ fp, before: content, after: result.content, reasons, fields: result.fields });
}

console.log(`\n扫描 ${files.length} 个 .md 文件`);
console.log(`检测到损坏需清洗: ${toFix.length} 个`);
console.log(`无法自动修复(需人工): ${failed.length} 个\n`);

for (const { fp, reasons, before, after, fields } of toFix) {
  const name = path.basename(fp);
  console.log('─'.repeat(70));
  console.log(`文件: ${name}`);
  console.log(`损坏: ${reasons.join('; ')}`);
  const { beforeFm, afterFm } = shortDiff(before, after);
  const beforeHead = beforeFm.length > 400 ? beforeFm.slice(0, 400) + '\n  …(截断)' : beforeFm;
  console.log('  --- BEFORE frontmatter (截断) ---');
  console.log('  ' + beforeHead.replace(/\n/g, '\n  '));
  console.log('  --- AFTER frontmatter ---');
  console.log('  ' + afterFm.replace(/\n/g, '\n  '));
  console.log(`  还原字段: ${[...fields.keys()].join(', ')}`);
}

for (const { fp, reason } of failed) {
  console.log('─'.repeat(70));
  console.log(`[需人工] ${path.basename(fp)}: ${reason}`);
}

if (!APPLY) {
  console.log('\n' + '='.repeat(70));
  console.log('这是 DRY-RUN，未写盘。确认无误后加 --apply 落盘。');
  process.exit(0);
}

if (toFix.length === 0) {
  console.log('\n没有需要写盘的文件。');
  process.exit(0);
}

// 备份到时间戳目录
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(targetDir, `_repair_backup_${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });

let written = 0;
for (const { fp, before, after } of toFix) {
  const name = path.basename(fp);
  fs.writeFileSync(path.join(backupDir, name), before, 'utf8');
  fs.writeFileSync(fp, after, 'utf8');
  written++;
}

console.log('\n' + '='.repeat(70));
console.log(`已备份 ${written} 个原文件到: ${backupDir}`);
console.log(`已写入修复后的 ${written} 个文件。`);
if (failed.length > 0) {
  console.log(`另有 ${failed.length} 个文件需人工处理（未改动）。`);
}
