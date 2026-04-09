// test/knowledge/linter.test.ts

import {
  LintIssue,
  LintIssueSeverity,
  buildHealthReportContent,
  checkMissingSummaries,
  checkLowConfidenceExtractions,
  checkOrphanConcepts
} from '../../src/knowledge/linter';

function expect(actual: any) {
  return {
    toBe: (expected: any) => {
      if (actual !== expected) throw new Error(`Expected "${expected}" but got "${actual}"`);
    },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy`); },
    toContain: (expected: string) => {
      if (typeof actual !== 'string' || !actual.includes(expected))
        throw new Error(`Expected to contain "${expected}"`);
    }
  };
}

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); process.exit(1); }
}

console.log('=== Knowledge Linter Tests ===');

test('checkMissingSummaries detects records without summary files', () => {
  const records = [
    { id: 'ksrc_a', path: 'a.md', status: 'done' as const, summary_path: 'KW/Articles/ksrc_a.md', created_at: '', updated_at: '', error: null },
    { id: 'ksrc_b', path: 'b.md', status: 'done' as const, summary_path: 'KW/Articles/ksrc_b.md', created_at: '', updated_at: '', error: null }
  ];
  const existingFiles = new Set(['KW/Articles/ksrc_a.md']);
  const issues = checkMissingSummaries(records, existingFiles);
  expect(issues.length).toBe(1);
  expect(issues[0].recordId).toBe('ksrc_b');
  expect(issues[0].type).toBe('missing_summary');
});

test('checkLowConfidenceExtractions detects review_flags', () => {
  const summaries = [
    { sourceId: 'ksrc_a', title: 'A', reviewFlags: ['uncertain author'] },
    { sourceId: 'ksrc_b', title: 'B', reviewFlags: [] }
  ];
  const issues = checkLowConfidenceExtractions(summaries);
  expect(issues.length).toBe(1);
  expect(issues[0].recordId).toBe('ksrc_a');
  expect(issues[0].type).toBe('low_confidence');
});

test('checkOrphanConcepts finds concepts appearing only once', () => {
  const conceptMap: Record<string, string[]> = {
    'AI': ['ksrc_a', 'ksrc_b'],
    'Quantum': ['ksrc_c']
  };
  const issues = checkOrphanConcepts(conceptMap);
  expect(issues.length).toBe(1);
  expect(issues[0].message).toContain('Quantum');
});

test('buildHealthReportContent generates valid markdown', () => {
  const issues: LintIssue[] = [
    { type: 'missing_summary', severity: 'error', recordId: 'ksrc_x', message: 'Summary file missing' },
    { type: 'low_confidence', severity: 'warning', recordId: 'ksrc_y', message: 'Uncertain author' }
  ];
  const content = buildHealthReportContent(issues);
  expect(content).toContain('knowledge_generated: true');
  expect(content).toContain('knowledge_artifact_type: "health_report"');
  expect(content).toContain('## Errors');
  expect(content).toContain('Summary file missing');
  expect(content).toContain('## Warnings');
  expect(content).toContain('Uncertain author');
});

test('buildHealthReportContent with no issues shows clean report', () => {
  const content = buildHealthReportContent([]);
  expect(content).toContain('知识库健康状况良好');
});

console.log('All linter tests passed!');
