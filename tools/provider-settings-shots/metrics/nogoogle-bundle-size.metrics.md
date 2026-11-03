# Bundle size: Before/After

Generated 2026-11-03T06:11:36.160Z by `tools/provider-settings-shots/bundle-size-diff.mjs` from the
two esbuild metafiles (`BAIZER_METAFILE=1 npm run build`).

| | revision | `dist/main.js` | sha256 | inputs | metafile matches artifact |
| --- | --- | --- | --- | --- | --- |
| Before | `caf9703` — tree-identical to main @ 1f4c695 (git diff caf9703 origin/main is empty; both trees d05a9be6); artifact built in the pristine caf9703 worktree | **4,137,811 B** (3.9461 MiB) | `C622438F7B33AC97…` | 1234 | yes |
| After | `c6b99e7` — final rebased head; tree fa4d502, byte-identical to pre-rebase 1f29a77 | **3,162,611 B** (3.0161 MiB) | `87D4B012FC0DDDFA…` | 1225 | yes |
| **Delta** | | **-975,200 B** (-952.34 KiB, -23.568%) | | | |

Per-module contributions come from `outputs["dist/main.js"].inputs[].bytesInOutput` — the bytes each
module actually occupies in the single-file bundle (the top-level `inputs` map only carries the
module's own source size, which is a different number).

Per-input attribution (sum of module deltas): -972,988 B; the remaining -2,212 B is bundle-level (banner, esbuild runtime helpers, module plumbing).

## Modules that disappeared entirely

| input | before | after | delta |
| --- | --- | --- | --- |
| `node_modules/@google/genai/dist/web/index.mjs` | 876,277 | 0 | -876,277 |
| `node_modules/@google/generative-ai/dist/index.mjs` | 40,209 | 0 | -40,209 |
| `node_modules/@earendil-works/pi-ai/dist/providers/data/google.json` | 14,828 | 0 | -14,828 |
| `node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js` | 14,258 | 0 | -14,258 |
| `node_modules/@earendil-works/pi-ai/dist/api/google-shared.js` | 11,894 | 0 | -11,894 |
| `node_modules/retry/lib/retry_operation.js` | 4,237 | 0 | -4,237 |
| `node_modules/retry/lib/retry.js` | 2,666 | 0 | -2,666 |
| `node_modules/p-retry/index.js` | 2,489 | 0 | -2,489 |
| `node_modules/@earendil-works/pi-ai/dist/providers/google.js` | 522 | 0 | -522 |
| `node_modules/@earendil-works/pi-ai/dist/providers/google.models.js` | 464 | 0 | -464 |
| `node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.lazy.js` | 318 | 0 | -318 |
| `node_modules/retry/index.js` | 133 | 0 | -133 |

## Modules that appeared

| input | before | after | delta |
| --- | --- | --- | --- |
| `pi-model-catalog-stub:pi-model-catalog-stub:google.models.js` | 0 | 226 | +226 |
| `pi-api-stub:pi-api-stub:google-generative-ai` | 0 | 530 | +530 |
| `pi-stub:pi-provider-stub:google.js` | 0 | 573 | +573 |

## Modules that shrank but survived

| input | before | after | delta |
| --- | --- | --- | --- |
| `src/services/model-catalog-service.ts` | 6,508 | 5,216 | -1,292 |
| `src/runtime/pi/pi-native-model.ts` | 7,836 | 6,563 | -1,273 |
| `src/services/video-transcription.ts` | 4,991 | 3,828 | -1,163 |
| `src/settings.ts` | 127,716 | 126,579 | -1,137 |
| `src/i18n/zh-messages.ts` | 49,314 | 48,990 | -324 |
| `src/services/model-service.ts` | 36,250 | 36,021 | -229 |
| `main.ts` | 36,000 | 35,895 | -105 |
| `src/runtime/pi/harness-chat-runtime.ts` | 10,550 | 10,484 | -66 |
| `node_modules/typebox/build/type/script/parser.mjs` | 39,264 | 39,224 | -40 |
| `node_modules/openai/client.mjs` | 62,662 | 62,624 | -38 |
| `node_modules/openai/core/error.mjs` | 5,137 | 5,105 | -32 |
| `node_modules/openai/core/streaming.mjs` | 19,334 | 19,308 | -26 |
| `node_modules/openai/internal/auth/x509-workload-identity-auth.mjs` | 44,760 | 44,735 | -25 |
| `node_modules/yaml/browser/dist/stringify/stringifyString.js` | 9,430 | 9,410 | -20 |
| `node_modules/@earendil-works/pi-ai/dist/env-api-keys.js` | 5,514 | 5,495 | -19 |
| `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js` | 46,898 | 46,880 | -18 |
| `src/services/inbox-autosave.ts` | 2,952 | 2,936 | -16 |
| `node_modules/@earendil-works/pi-ai/dist/utils/json-parse.js` | 3,082 | 3,069 | -13 |
| `node_modules/openai/lib/EventStream.mjs` | 59,696 | 59,683 | -13 |
| `src/skills/builtin/plugin-ctrl/skill-generator.ts` | 22,918 | 22,905 | -13 |
| `node_modules/openai/internal/responses/response-accumulator.mjs` | 35,411 | 35,399 | -12 |
| `node_modules/yaml/browser/dist/stringify/stringify.js` | 3,613 | 3,603 | -10 |
| `node_modules/openai/lib/AssistantStream.mjs` | 41,465 | 41,456 | -9 |
| `src/runtime/pi/prompt-template-service.ts` | 5,784 | 5,775 | -9 |
| `pi-api-stub:pi-api-stub:azure-openai-responses` | 544 | 536 | -8 |
| `pi-api-stub:pi-api-stub:bedrock-converse-stream` | 553 | 545 | -8 |
| `pi-api-stub:pi-api-stub:google-vertex` | 505 | 497 | -8 |
| `pi-api-stub:pi-api-stub:mistral-conversations` | 545 | 537 | -8 |
| `pi-api-stub:pi-api-stub:openai-codex-responses` | 548 | 540 | -8 |
| `pi-api-stub:pi-api-stub:pi-messages` | 495 | 487 | -8 |
| `pi-stub:pi-provider-stub:amazon-bedrock.js` | 624 | 616 | -8 |
| `pi-stub:pi-provider-stub:ant-ling.js` | 588 | 580 | -8 |
| `pi-stub:pi-provider-stub:azure.js` | 575 | 567 | -8 |
| `pi-stub:pi-provider-stub:baseten.js` | 587 | 579 | -8 |
| `pi-stub:pi-provider-stub:cerebras.js` | 593 | 585 | -8 |
| `pi-stub:pi-provider-stub:cloudflare-ai-gateway.js` | 669 | 661 | -8 |
| `pi-stub:pi-provider-stub:cloudflare-workers-ai.js` | 669 | 661 | -8 |
| `pi-stub:pi-provider-stub:deepseek.js` | 593 | 585 | -8 |
| `pi-stub:pi-provider-stub:fireworks.js` | 599 | 591 | -8 |
| `pi-stub:pi-provider-stub:github-copilot.js` | 628 | 620 | -8 |

## Modules that grew

| input | before | after | delta |
| --- | --- | --- | --- |
| `pi-stub:pi-provider-stub:google.js` | 0 | 573 | +573 |
| `pi-api-stub:pi-api-stub:google-generative-ai` | 0 | 530 | +530 |
| `src/mcp/types.ts` | 4,302 | 4,621 | +319 |
| `pi-model-catalog-stub:pi-model-catalog-stub:google.models.js` | 0 | 226 | +226 |
| `src/ui/shell-view.ts` | 73,831 | 73,877 | +46 |
| `node_modules/@earendil-works/pi-ai/dist/models.generated.js` | 6,044 | 6,066 | +22 |
| `node_modules/@earendil-works/pi-ai/dist/providers/all.js` | 3,415 | 3,431 | +16 |
| `node_modules/@earendil-works/pi-ai/dist/compat.js` | 13,154 | 13,168 | +14 |
| `node_modules/@earendil-works/pi-ai/dist/legacy-api-aliases.js` | 2,537 | 2,544 | +7 |

## By owner

| owner | before | after | delta | inputs changed |
| --- | --- | --- | --- | --- |
| @google/genai | 876,277 | 0 | -876,277 | 1 |
| @earendil-works/pi-ai | 230,730 | 188,429 | -42,301 | 20 |
| @google/generative-ai | 40,209 | 0 | -40,209 | 1 |
| retry | 7,036 | 0 | -7,036 | 3 |
| plugin source | 452,611 | 447,318 | -5,293 | 21 |
| p-retry | 2,489 | 0 | -2,489 | 1 |
| openai | 438,460 | 438,219 | -241 | 35 |
| yaml | 33,928 | 33,873 | -55 | 6 |
| typebox | 49,769 | 49,719 | -50 | 4 |
| pi-stub:pi-provider-stub:amazon-bedrock.js | 624 | 616 | -8 | 1 |
| pi-stub:pi-provider-stub:ant-ling.js | 588 | 580 | -8 | 1 |
| pi-stub:pi-provider-stub:azure.js | 575 | 567 | -8 | 1 |
| pi-stub:pi-provider-stub:baseten.js | 587 | 579 | -8 | 1 |
| pi-stub:pi-provider-stub:cerebras.js | 593 | 585 | -8 | 1 |
| pi-stub:pi-provider-stub:cloudflare-ai-gateway.js | 669 | 661 | -8 | 1 |
| pi-stub:pi-provider-stub:cloudflare-workers-ai.js | 669 | 661 | -8 | 1 |
| pi-stub:pi-provider-stub:deepseek.js | 593 | 585 | -8 | 1 |
| pi-stub:pi-provider-stub:fireworks.js | 599 | 591 | -8 | 1 |
| pi-stub:pi-provider-stub:github-copilot.js | 628 | 620 | -8 | 1 |
| pi-stub:pi-provider-stub:google-vertex.js | 622 | 614 | -8 | 1 |
| pi-stub:pi-provider-stub:groq.js | 569 | 561 | -8 | 1 |
| pi-stub:pi-provider-stub:huggingface.js | 611 | 603 | -8 | 1 |
| pi-stub:pi-provider-stub:kimi-coding.js | 610 | 602 | -8 | 1 |
| pi-stub:pi-provider-stub:meta.js | 569 | 561 | -8 | 1 |
| pi-stub:pi-provider-stub:minimax.js | 587 | 579 | -8 | 1 |
| pi-stub:pi-provider-stub:minimax-cn.js | 604 | 596 | -8 | 1 |
| pi-stub:pi-provider-stub:mistral.js | 587 | 579 | -8 | 1 |
| pi-stub:pi-provider-stub:moonshotai.js | 605 | 597 | -8 | 1 |
| pi-stub:pi-provider-stub:moonshotai-cn.js | 622 | 614 | -8 | 1 |
| pi-stub:pi-provider-stub:nvidia.js | 581 | 573 | -8 | 1 |
| pi-stub:pi-provider-stub:openai-codex.js | 616 | 608 | -8 | 1 |
| pi-stub:pi-provider-stub:opencode.js | 593 | 585 | -8 | 1 |
| pi-stub:pi-provider-stub:opencode-go.js | 610 | 602 | -8 | 1 |
| pi-stub:pi-provider-stub:openrouter.js | 605 | 597 | -8 | 1 |
| pi-stub:pi-provider-stub:qwen-token-plan.js | 633 | 625 | -8 | 1 |
| pi-stub:pi-provider-stub:qwen-token-plan-cn.js | 650 | 642 | -8 | 1 |
| pi-stub:pi-provider-stub:qwen-token-plan-individual.js | 698 | 690 | -8 | 1 |
| pi-stub:pi-provider-stub:radius.js | 581 | 573 | -8 | 1 |
| pi-stub:pi-provider-stub:together.js | 593 | 585 | -8 | 1 |
| pi-stub:pi-provider-stub:typesafe.js | 593 | 585 | -8 | 1 |
| pi-stub:pi-provider-stub:vercel-ai-gateway.js | 645 | 637 | -8 | 1 |
| pi-stub:pi-provider-stub:xai.js | 563 | 555 | -8 | 1 |
| pi-stub:pi-provider-stub:xiaomi.js | 581 | 573 | -8 | 1 |
| pi-stub:pi-provider-stub:xiaomi-token-plan-ams.js | 668 | 660 | -8 | 1 |
| pi-stub:pi-provider-stub:xiaomi-token-plan-cn.js | 662 | 654 | -8 | 1 |
| pi-stub:pi-provider-stub:xiaomi-token-plan-sgp.js | 668 | 660 | -8 | 1 |
| pi-stub:pi-provider-stub:zai.js | 563 | 555 | -8 | 1 |
| pi-stub:pi-provider-stub:zai-coding-cn.js | 621 | 613 | -8 | 1 |
| pi-stub:pi-provider-stub:anthropic.js | 595 | 591 | -4 | 1 |
| @mozilla/readability | 79,361 | 79,359 | -2 | 1 |
| esbuild-plugin stub (pi-model-catalog-stub) | 0 | 226 | +226 | 1 |
| esbuild-plugin stub (pi-api-stub) | 3,190 | 3,672 | +482 | 7 |
| pi-stub:pi-provider-stub:google.js | 0 | 573 | +573 | 1 |

