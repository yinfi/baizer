# Bundle size: Before/After

Generated 2026-11-03T08:13:04.378Z by `tools/provider-settings-shots/bundle-size-diff.mjs` from the
two esbuild metafiles (`BAIZER_METAFILE=1 npm run build`).

| | revision | `dist/main.js` | sha256 | inputs | metafile matches artifact |
| --- | --- | --- | --- | --- | --- |
| Before | `ba078c8` — origin/main @ ba078c8, built in place in this worktree | **3,160,865 B** (3.0144 MiB) | `C74A6EC6F76CB755…` | 1224 | yes |
| After | `965ab79` — branch head @ 965ab79 (code fixes + tooling), built in place in this worktree | **3,180,761 B** (3.0334 MiB) | `215A631F930A3491…` | 1225 | yes |
| **Delta** | | **+19,896 B** (19.43 KiB, 0.6294%) | | | |

Per-module contributions come from `outputs["dist/main.js"].inputs[].bytesInOutput` — the bytes each
module actually occupies in the single-file bundle (the top-level `inputs` map only carries the
module's own source size, which is a different number).

Per-input attribution (sum of module deltas): +19,823 B; the remaining 73 B is bundle-level (banner, esbuild runtime helpers, module plumbing).

## Modules that appeared

| input | before | after | delta |
| --- | --- | --- | --- |
| `src/services/asr-chunking.ts` | 0 | 5,933 | +5,933 |

## Modules that grew

| input | before | after | delta |
| --- | --- | --- | --- |
| `src/services/video-transcription.ts` | 3,828 | 10,818 | +6,990 |
| `src/services/asr-chunking.ts` | 0 | 5,933 | +5,933 |
| `src/settings.ts` | 126,579 | 129,329 | +2,750 |
| `src/i18n/zh-messages.ts` | 48,990 | 50,785 | +1,795 |
| `src/mcp/types.ts` | 4,621 | 5,894 | +1,273 |
| `src/skills/builtin/web-clipper/executor.ts` | 13,793 | 14,875 | +1,082 |

## By owner

| owner | before | after | delta | inputs changed |
| --- | --- | --- | --- | --- |
| plugin source | 197,811 | 217,634 | +19,823 | 6 |

