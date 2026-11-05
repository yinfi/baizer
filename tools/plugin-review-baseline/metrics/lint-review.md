# Typed-lint report (Obsidian Review scan reproduction)

- Config: `tools/plugin-review-baseline/eslint.review.config.mjs`
- Source: live ESLint run over the current working tree
- Targets: `main.ts`, `src`
- ESLint: `undefined`

## Totals

| metric | value |
| --- | --- |
| files linted | 127 |
| files with problems | 78 |
| errors | 72 |
| warnings | 1996 |
| **problems** | **2068** |

## Problems per rule

| count | rule |
| ---: | --- |
| 799 | `@typescript-eslint/no-unsafe-member-access` |
| 387 | `@typescript-eslint/no-unsafe-assignment` |
| 334 | `@typescript-eslint/no-explicit-any` |
| 187 | `@typescript-eslint/no-unsafe-call` |
| 134 | `@typescript-eslint/no-unsafe-argument` |
| 63 | `@typescript-eslint/no-unsafe-return` |
| 61 | `@typescript-eslint/no-unnecessary-type-assertion` |
| 38 | `@typescript-eslint/require-await` |
| 17 | `@typescript-eslint/no-unused-vars` |
| 14 | `@typescript-eslint/no-misused-promises` |
| 8 | `@typescript-eslint/no-floating-promises` |
| 7 | `@typescript-eslint/no-redundant-type-constituents` |
| 7 | `no-useless-escape` |
| 4 | `prefer-const` |
| 3 | `@typescript-eslint/no-base-to-string` |
| 2 | `@typescript-eslint/unbound-method` |
| 2 | `no-case-declarations` |
| 1 | `no-irregular-whitespace` |

## Per-file distribution of `@typescript-eslint/no-unsafe-member-access` (799 problems, 44 files)

| count | file |
| ---: | --- |
| 79 | `src/settings.ts` |
| 76 | `src/memory/hindsight-migration.ts` |
| 65 | `src/skills/builtin/vault-ops.ts` |
| 47 | `main.ts` |
| 37 | `src/memory/memory-manager.ts` |
| 35 | `src/knowledge/compiler.ts` |
| 33 | `src/skills/builtin/plugin-ctrl/executor.ts` |
| 30 | `src/services/video-transcription.ts` |
| 30 | `src/skills/builtin/obsidian-bases/executor.ts` |
| 26 | `src/runtime/pi/pi-event-adapter.ts` |
| 25 | `src/services/model-catalog-service.ts` |
| 25 | `src/skills/builtin/json-canvas/executor.ts` |
| 24 | `src/utils/video_utils.ts` |
| 23 | `src/services/model-service.ts` |
| 22 | `src/utils/request-url-fetch.ts` |
| 18 | `src/skills/builtin/plugin-ctrl/skill-generator.ts` |
| 17 | `src/knowledge/ontology.ts` |
| 16 | `src/knowledge/metadata-index.ts` |
| 16 | `src/services/operation-audit-log.ts` |
| 15 | `src/runtime/pi/harness-chat-runtime.ts` |
| 14 | `src/knowledge/runtime.ts` |
| 14 | `src/services/obsidian-context-service.ts` |
| 14 | `src/utils/file-operation-contract.ts` |
| 12 | `src/knowledge/frontmatter.ts` |
| 11 | `src/skills/skill-files.ts` |
| 10 | `src/runtime/base-chat-runtime.ts` |
| 10 | `src/skills/builtin/plugin-ctrl/plugin-watcher.ts` |
| 10 | `src/skills/builtin/web-clipper/executor.ts` |
| 8 | `src/runtime/pi/anthropic-sdk-shim.ts` |
| 6 | `src/services/workspace-edit-service.ts` |
| 6 | `src/skills/pi-skill-source.ts` |
| 4 | `src/knowledge/indexer.ts` |
| 4 | `src/skills/builtin/web-search/executor.ts` |
| 3 | `src/runtime/pi/session-store/compaction.ts` |
| 3 | `src/skills/builtin/knowledge/executor.ts` |
| 2 | `src/knowledge/ontology-service.ts` |
| 2 | `src/skills/builtin/read-skill.ts` |
| 1 | `src/knowledge/file-back.ts` |
| 1 | `src/runtime/pi/pi-approval-policy.ts` |
| 1 | `src/runtime/pi/pi-native-model.ts` |
| 1 | `src/runtime/pi/pi-tool-adapter.ts` |
| 1 | `src/services/clip-protocol.ts` |
| 1 | `src/skills/tool-registry.ts` |
| 1 | `src/utils/logger.ts` |

## All files with problems

| problems | file |
| ---: | --- |
| 184 | `src/settings.ts` |
| 148 | `src/memory/hindsight-migration.ts` |
| 140 | `main.ts` |
| 126 | `src/skills/builtin/vault-ops.ts` |
| 97 | `src/memory/memory-manager.ts` |
| 79 | `src/skills/builtin/plugin-ctrl/executor.ts` |
| 75 | `src/services/model-service.ts` |
| 75 | `src/utils/request-url-fetch.ts` |
| 73 | `src/services/video-transcription.ts` |
| 70 | `src/knowledge/compiler.ts` |
| 61 | `src/utils/video_utils.ts` |
| 58 | `src/services/model-catalog-service.ts` |
| 53 | `src/skills/builtin/plugin-ctrl/skill-generator.ts` |
| 48 | `src/knowledge/metadata-index.ts` |
| 46 | `src/runtime/pi/harness-chat-runtime.ts` |
| 45 | `src/knowledge/ontology.ts` |
| 43 | `src/skills/builtin/obsidian-bases/executor.ts` |
| 42 | `src/runtime/pi/pi-event-adapter.ts` |
| 42 | `src/skills/builtin/web-clipper/executor.ts` |
| 41 | `src/knowledge/runtime.ts` |
| 40 | `src/skills/builtin/json-canvas/executor.ts` |
| 32 | `src/knowledge/frontmatter.ts` |
| 32 | `src/services/obsidian-context-service.ts` |
| 30 | `src/runtime/pi/anthropic-sdk-shim.ts` |
| 26 | `src/utils/file-operation-contract.ts` |
| 25 | `src/runtime/base-chat-runtime.ts` |
| 24 | `src/ui/shell-view.ts` |
| 23 | `src/skills/builtin/plugin-ctrl/plugin-watcher.ts` |
| 23 | `src/skills/skill-files.ts` |
| 22 | `src/services/operation-audit-log.ts` |
| 18 | `src/skills/pi-skill-source.ts` |
| 18 | `src/utils/logger.ts` |
| 17 | `src/ui/chat-controller.ts` |
| 15 | `src/services/workspace-edit-service.ts` |
| 11 | `src/runtime/pi/pi-tool-adapter.ts` |
| 11 | `src/skills/builtin/knowledge/executor.ts` |
| 10 | `src/knowledge/ontology-service.ts` |
| 9 | `src/runtime/pi/session-store/compaction.ts` |
| 9 | `src/skills/builtin/web-search/executor.ts` |
| 9 | `src/utils/throttle.ts` |
| 8 | `src/knowledge/indexer.ts` |
| 8 | `src/knowledge/linter.ts` |
| 8 | `src/ui/components/input-toolbar.ts` |
| 7 | `src/skills/builtin/read-skill.ts` |
| 6 | `src/runtime/pi/session-store/memory-adapter.ts` |
| 6 | `src/skills/types.ts` |
| 5 | `src/models/interfaces.ts` |
| 5 | `src/skills/tool-registry.ts` |
| 5 | `src/ui/diff-modal.ts` |
| 5 | `src/ui/guardian-gutter.ts` |
| 4 | `src/skills/skill-registry.ts` |
| 3 | `src/knowledge/file-back.ts` |
| 3 | `src/mcp/types.ts` |
| 3 | `src/runtime/pi/pi-approval-policy.ts` |
| 3 | `src/runtime/pi/pi-native-model.ts` |
| 3 | `src/runtime/pi/session-store/migrate.ts` |
| 3 | `src/runtime/pi/vault-session-fs.ts` |
| 3 | `src/services/clip-input.ts` |
| 3 | `src/ui/components/attachment-modal.ts` |
| 2 | `src/memory/hindsight-store.ts` |
| 2 | `src/runtime/pi/session-store/conversation-session.ts` |
| 2 | `src/services/clip-protocol.ts` |
| 2 | `src/services/context-manager.ts` |
| 2 | `src/ui/controllers/stream-controller.ts` |
| 2 | `src/ui/ghost-text.ts` |
| 2 | `src/ui/guardian-completion.ts` |
| 2 | `src/ui/selection-menu.ts` |
| 1 | `src/knowledge/query.ts` |
| 1 | `src/runtime/pi/harness-env.ts` |
| 1 | `src/runtime/pi/harness-session-manager.ts` |
| 1 | `src/runtime/runtime-types.ts` |
| 1 | `src/services/inbox-autosave.ts` |
| 1 | `src/ui/approval-card.ts` |
| 1 | `src/ui/components/history-menu.ts` |
| 1 | `src/ui/controllers/context-controller.ts` |
| 1 | `src/ui/renderers/message-renderer.ts` |
| 1 | `src/ui/scroll/scroll-follow-controller.ts` |
| 1 | `src/utils/thrown-message.ts` |

