import { execSync } from 'child_process';

const tests = [
  'test/mcp-integration.test.ts',
  'test/skill-registry.test.ts',
  'test/obsidian-markdown-skill.test.ts',
  'test/skill-routing.test.ts',
  'test/model-service.test.ts',
  'test/chat-runtime.test.ts',
  'test/chat-controller.test.ts',
  'test/command-suggestions.test.ts',
  'test/input-controller.test.ts',
  'test/context-controller.test.ts',
  'test/stream-controller.test.ts',
  'test/thinking-renderer.test.ts',
  'test/tool-renderer.test.ts',
  'test/approval-flow.test.ts',
  'test/vault-permissions.test.ts',
  'test/file-tools.test.ts',
  'test/json-canvas.test.ts',
  'test/obsidian-bases.test.ts',
  'test/plugin-tools.test.ts',
  'test/provider-capabilities.test.ts',
  'test/settings-state.test.ts',
  'test/context-budget.test.ts',
  'test/context-manager.test.ts',
  'test/memory-manager.test.ts',
  'test/save-path.test.ts',
  'test/skill-files.test.ts',
  'test/gemini-thought-signatures.test.ts',
  'test/inbox-autosave.test.ts',
  'test/plugin-skill-generator.test.ts',
  'test/plugin-watcher.test.ts',
  'test/video-transcription.test.ts',
  'test/video-utils.test.ts',
  'test/web-clipper.test.ts',
  'test/web-search.test.ts',
  'test/knowledge/compiler.test.ts',
  'test/knowledge/file-back.test.ts',
  'test/knowledge/indexer.test.ts',
  'test/knowledge/linter.test.ts',
  'test/knowledge/ontology.test.ts',
  'test/knowledge/query.test.ts',
  'test/knowledge/types.test.ts',
  'test/knowledge/watcher.test.ts',
];

for (const testFile of tests) {
  console.log(`Running ${testFile}...`);
  try {
    execSync(`npx tsx --tsconfig tsconfig.test.json ${testFile}`, {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
  } catch (error: any) {
    process.exit(error?.status ?? 1);
  }
}

console.log(`Executed ${tests.length} test files successfully.`);
