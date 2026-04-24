// src/knowledge/linter.ts

import { App, TFile } from 'obsidian';
import { WIKI_HEALTH_SUBFOLDER } from './types';
import { getFilesByKnowledgeStatus } from './frontmatter';

export type LintIssueType =
  | 'missing_summary'
  | 'low_confidence'
  | 'orphan_concept'
  | 'duplicate_topic';

export type LintIssueSeverity = 'error' | 'warning' | 'info';

export interface LintIssue {
  type: LintIssueType;
  severity: LintIssueSeverity;
  filePath?: string;
  message: string;
}

/**
 * 检查：done 状态但 summary 文件不存在
 */
export function checkMissingSummaries(
  doneFiles: { path: string; summaryPath: string | null }[],
  existingFiles: Set<string>
): LintIssue[] {
  return doneFiles
    .filter(f => f.summaryPath && !existingFiles.has(f.summaryPath!))
    .map(f => ({
      type: 'missing_summary' as const,
      severity: 'error' as const,
      filePath: f.path,
      message: `Summary file missing for "${f.path}" (expected: ${f.summaryPath})`
    }));
}

/**
 * 检查：summary 中有 review_flags 的低置信度提取
 */
export function checkLowConfidenceExtractions(
  summaries: { path: string; title: string; reviewFlags: string[] }[]
): LintIssue[] {
  return summaries
    .filter(s => s.reviewFlags.length > 0)
    .map(s => ({
      type: 'low_confidence' as const,
      severity: 'warning' as const,
      filePath: s.path,
      message: `Low confidence extraction in "${s.title}": ${s.reviewFlags.join(', ')}`
    }));
}

/**
 * 检查：某 concept 只出现在一篇 summary 中（孤立概念）
 */
export function checkOrphanConcepts(
  conceptMap: Record<string, string[]>
): LintIssue[] {
  return Object.entries(conceptMap)
    .filter(([_, sources]) => sources.length === 1)
    .map(([concept, sources]) => ({
      type: 'orphan_concept' as const,
      severity: 'info' as const,
      filePath: sources[0],
      message: `Orphan concept "${concept}" only appears in one summary`
    }));
}

/**
 * 生成健康报告 Markdown
 */
export function buildHealthReportContent(issues: LintIssue[]): string {
  const now = new Date().toISOString();
  let md = `---\nknowledge_generated: true\nknowledge_artifact_type: "health_report"\ngenerated_at: "${now}"\n---\n# Knowledge Wiki Health Report\n\n`;

  if (issues.length === 0) {
    md += '知识库健康状况良好，未发现问题。\n';
    return md;
  }

  md += `共发现 ${issues.length} 个问题。\n\n`;

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  const infos = issues.filter(i => i.severity === 'info');

  if (errors.length > 0) {
    md += '## Errors\n\n';
    for (const e of errors) {
      md += `- **[${e.type}]** ${e.message}\n`;
    }
    md += '\n';
  }

  if (warnings.length > 0) {
    md += '## Warnings\n\n';
    for (const w of warnings) {
      md += `- **[${w.type}]** ${w.message}\n`;
    }
    md += '\n';
  }

  if (infos.length > 0) {
    md += '## Info\n\n';
    for (const i of infos) {
      md += `- **[${i.type}]** ${i.message}\n`;
    }
    md += '\n';
  }

  return md;
}

/**
 * Linter 主类：运行所有检查，生成报告
 */
export class KnowledgeLinter {
  constructor(
    private app: App,
    private wikiFolder: string
  ) {}

  async runLint(): Promise<LintIssue[]> {
    const allIssues: LintIssue[] = [];
    const existingFiles = new Set(this.app.vault.getFiles().map(f => f.path));

    // 检查 done 状态文件的 summary 是否存在
    const doneFiles = getFilesByKnowledgeStatus(this.app, 'done');
    const doneInfo = doneFiles.map(f => {
      const cache = this.app.metadataCache.getFileCache(f);
      return {
        path: f.path,
        summaryPath: cache?.frontmatter?.knowledge_summary ?? null
      };
    });
    allIssues.push(...checkMissingSummaries(doneInfo, existingFiles));

    // 检查 summary 文件的 review_flags 和 concepts
    const summaries: { path: string; title: string; reviewFlags: string[] }[] = [];
    const conceptMap: Record<string, string[]> = {};

    const wikiFiles = this.app.vault.getFiles().filter(
      f => f.path.startsWith(this.wikiFolder + '/Articles/') && f.extension === 'md'
    );

    for (const file of wikiFiles) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!fm || !fm.knowledge_generated) continue;

      const title = fm.title || file.basename;
      let reviewFlags: string[] = [];
      if (Array.isArray(fm.review_flags)) {
        reviewFlags = fm.review_flags;
      } else if (typeof fm.review_flags === 'string') {
        try { reviewFlags = JSON.parse(fm.review_flags); } catch {}
      }
      summaries.push({ path: file.path, title, reviewFlags });

      let concepts: string[] = [];
      if (Array.isArray(fm.concepts)) {
        concepts = fm.concepts;
      } else if (typeof fm.concepts === 'string') {
        try { concepts = JSON.parse(fm.concepts); } catch {}
      }
      for (const c of concepts) {
        if (!conceptMap[c]) conceptMap[c] = [];
        conceptMap[c].push(file.path);
      }
    }

    allIssues.push(...checkLowConfidenceExtractions(summaries));
    allIssues.push(...checkOrphanConcepts(conceptMap));

    return allIssues;
  }

  async generateReport(): Promise<string> {
    const issues = await this.runLint();
    const reportContent = buildHealthReportContent(issues);

    const reportDir = `${this.wikiFolder}/${WIKI_HEALTH_SUBFOLDER}`;
    const reportPath = `${reportDir}/report.md`;

    if (!this.app.vault.getAbstractFileByPath(reportDir)) {
      try { await this.app.vault.createFolder(reportDir); } catch {}
    }

    const existing = this.app.vault.getAbstractFileByPath(reportPath);
    if (existing && existing instanceof TFile) {
      await this.app.vault.modify(existing, reportContent);
    } else {
      await this.app.vault.create(reportPath, reportContent);
    }

    return reportPath;
  }
}
