// src/knowledge/linter.ts

import { App, TFile } from 'obsidian';
import { KnowledgeRegistryManager } from './registry';
import { KnowledgeRegistryRecord, WIKI_HEALTH_SUBFOLDER } from './types';

export type LintIssueType =
  | 'missing_summary'
  | 'low_confidence'
  | 'orphan_concept'
  | 'duplicate_topic'
  | 'stale_missing_source';

export type LintIssueSeverity = 'error' | 'warning' | 'info';

export interface LintIssue {
  type: LintIssueType;
  severity: LintIssueSeverity;
  recordId?: string;
  message: string;
}

/**
 * 检查：registry 中 done 状态但无对应 summary 文件
 */
export function checkMissingSummaries(
  records: KnowledgeRegistryRecord[],
  existingFiles: Set<string>
): LintIssue[] {
  return records
    .filter(r => r.status === 'done' && r.summary_path && !existingFiles.has(r.summary_path!))
    .map(r => ({
      type: 'missing_summary' as const,
      severity: 'error' as const,
      recordId: r.id,
      message: `Summary file missing for "${r.path}" (expected: ${r.summary_path})`
    }));
}

/**
 * 检查：summary 中有 review_flags 的低置信度提取
 */
export function checkLowConfidenceExtractions(
  summaries: { sourceId: string; title: string; reviewFlags: string[] }[]
): LintIssue[] {
  return summaries
    .filter(s => s.reviewFlags.length > 0)
    .map(s => ({
      type: 'low_confidence' as const,
      severity: 'warning' as const,
      recordId: s.sourceId,
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
      recordId: sources[0],
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
      md += `- **[${e.type}]** ${e.message}${e.recordId ? ` (${e.recordId})` : ''}\n`;
    }
    md += '\n';
  }

  if (warnings.length > 0) {
    md += '## Warnings\n\n';
    for (const w of warnings) {
      md += `- **[${w.type}]** ${w.message}${w.recordId ? ` (${w.recordId})` : ''}\n`;
    }
    md += '\n';
  }

  if (infos.length > 0) {
    md += '## Info\n\n';
    for (const i of infos) {
      md += `- **[${i.type}]** ${i.message}${i.recordId ? ` (${i.recordId})` : ''}\n`;
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
    private registry: KnowledgeRegistryManager,
    private wikiFolder: string
  ) {}

  async runLint(): Promise<LintIssue[]> {
    const allIssues: LintIssue[] = [];

    const doneRecords = this.registry.getByStatus('done');
    const existingFiles = new Set(
      this.app.vault.getFiles().map(f => f.path)
    );
    allIssues.push(...checkMissingSummaries(doneRecords, existingFiles));

    const summaries: { sourceId: string; title: string; reviewFlags: string[] }[] = [];
    const conceptMap: Record<string, string[]> = {};

    for (const record of doneRecords) {
      if (!record.summary_path) continue;
      const file = this.app.vault.getAbstractFileByPath(record.summary_path);
      if (!file || !(file instanceof TFile)) continue;

      try {
        const content = await this.app.vault.read(file);
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;

        const fmText = fmMatch[1];
        const flagsMatch = fmText.match(/review_flags:\s*(\[.*\])/);
        let reviewFlags: string[] = [];
        if (flagsMatch) {
          try { reviewFlags = JSON.parse(flagsMatch[1]); } catch {}
        }

        const titleMatch = fmText.match(/title:\s*"([^"]+)"/);
        const title = titleMatch ? titleMatch[1] : record.path;
        summaries.push({ sourceId: record.id, title, reviewFlags });

        const conceptsMatch = fmText.match(/concepts:\s*(\[.*\])/);
        if (conceptsMatch) {
          try {
            const concepts: string[] = JSON.parse(conceptsMatch[1]);
            for (const c of concepts) {
              if (!conceptMap[c]) conceptMap[c] = [];
              conceptMap[c].push(record.id);
            }
          } catch {}
        }
      } catch { continue; }
    }

    allIssues.push(...checkLowConfidenceExtractions(summaries));
    allIssues.push(...checkOrphanConcepts(conceptMap));

    const missingRecords = this.registry.getByStatus('missing_source');
    for (const r of missingRecords) {
      if (r.summary_path && existingFiles.has(r.summary_path)) {
        allIssues.push({
          type: 'stale_missing_source',
          severity: 'warning',
          recordId: r.id,
          message: `Source deleted but summary still exists: ${r.summary_path}`
        });
      }
    }

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
