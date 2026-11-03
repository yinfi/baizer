# Provider Architecture

Baizer speaks two wire protocols. `ProviderConfig` (`src/mcp/types.ts`) carries a
`type` of `openai-compatible` or `anthropic`, and
`src/runtime/pi/pi-native-model.ts` maps each config to a pi-ai `Model` whose `api`
field selects the implementation inside pi-ai. There is no per-provider API wrapper
in this repository — the mapping table below *is* the routing.

| `ProviderConfig.type` | pi-ai `Model.api` | Request |
|---|---|---|
| `openai-compatible` + `apiFlavor: 'completions'` (default) | `openai-completions` | `{baseUrl}/chat/completions` |
| `openai-compatible` + `apiFlavor: 'responses'` | `openai-responses` | `{baseUrl}/responses` |
| `anthropic` | `anthropic-messages` | `{baseUrl}/v1/messages` |

`apiFlavor` applies **only** to `openai-compatible`. Anthropic is not an OpenAI
flavour: it has its own request body (`system` as a top-level parameter, a required
`max_tokens`, typed content blocks, `tool_use`/`tool_result`) and its own SSE event
vocabulary. Do not model it as an OpenAI flavour with a different base URL — the
body and stream shapes differ, not just the path.

The `default:` branch of `ModelService.buildModelForConfig` logs a warning and
degrades to OpenAI-compatible rather than throwing, so a `ProviderConfig` on disk
with an unknown `type` still yields a usable (if possibly wrong) provider instead of
a hard failure. Since the prune described below runs at load, this branch is a second
safety net rather than the first line of defence.

## Provider types that are no longer supported

Google Gemini (`type: 'gemini'`, pi-ai `api: 'google-generative-ai'`) is no longer
supported: it was removed to cut bundle size, and with it the third wire protocol.
OpenAI-compatible and Anthropic are what remains.

The removal is enforced when settings load, not when a request is built.
`pruneUnsupportedProviders()` (`src/mcp/types.ts`) drops every entry whose `type`
fails `isSupportedProviderType()` — a malformed null entry is dropped too. The test
is on the config's `type`, **not** on its key in the `providers` map — a provider
saved under the key `gemini` but carrying `type: 'openai-compatible'` survives, while
an entry of the removed type is dropped whatever it is called. `loadSettings()`
(`main.ts`) applies the prune after `mergeProviderDefaults()` and before the
`activeProvider` repair.

What an existing install sees:

- The dropped entry is gone from settings. Its API key and model are not migrated to
  another provider, and nothing is shown to the user — no notice, no error. The
  Google credentials are simply dropped.
- If `activeProvider` named the dropped entry, the repair moves it to the first
  remaining provider (`Object.keys(providers)[0]`, falling back to
  `DEFAULT_SETTINGS.activeProvider`, i.e. `openai`). That provider is typically
  unconfigured, so requests fail until one is set up.
- The prune runs on **every** load and is in-memory only: `loadSettings()` does not
  write it back. The dead entry therefore remains in `data.json` until the next
  settings save rewrites the file, which keeps the drop reversible for a user who
  downgrades. A stale `type` still present in `data.json` is not evidence that the
  plugin accepted it.
- The dropped id is *not* added to `deletedProviderIds`; that list is unnecessary
  here because the removed key no longer exists in `DEFAULT_PROVIDERS`, so
  `mergeProviderDefaults()` cannot re-add it. Pre-existing stale ids in that list are
  left untouched.
- The legacy flat-format branch (`raw.provider` present, `raw.providers` absent) no
  longer synthesises a Gemini entry, and the old Google credentials
  (`old.apiKey` / `old.primaryModel`) are not migrated into any surviving entry.
  `activeProvider` is set from `old.provider`, and if that id does not exist among the
  surviving providers the repair above moves it to the first one — so a Gemini-only
  user lands on OpenAI, whose credentials come solely from the old
  `openaiApiKey` / `openaiBaseUrl` / `openaiModel` fields. Unlike the prune, that
  branch persists its result (`saveData`), as it always did.

## Base URL semantics

The two protocols disagree about whether `/v1` belongs in the configured address,
and this is the single most common misconfiguration:

- **Anthropic** — configure the root, e.g. `https://api.anthropic.com`, **without**
  `/v1`. The SDK appends `/v1/messages`. Including `/v1` produces `/v1/v1/messages`
  and a 404. This is why `DEFAULT_PROVIDERS.anthropic.baseUrl` has no `/v1`.
- **OpenAI-compatible** — the address is a base that already ends in the API root,
  e.g. `https://api.openai.com/v1`.

The settings panel states the resulting request path for the selected protocol, so
the rule is visible at the point of configuration rather than only here.

## Authentication and headers

Anthropic uses `x-api-key` (not `Authorization: Bearer`) plus a required
`anthropic-version: 2023-06-01`. Header merge order, highest priority last, is:

> built-in defaults → authentication → `defaultHeaders` (this includes the user's
> custom headers) → `content-type` → `anthropic-beta` → per-request headers

Two consequences worth knowing:

- Custom headers **can** override `anthropic-version` and `x-api-key`, but **cannot**
  override `content-type` or `anthropic-beta` — those are derived from the request
  body and win.
- `{{conversationId}}` in a custom header value is expanded per turn
  (`resolveCustomHeaders()`), which is what opencode-style gateways require.

## Why the Anthropic SDK is shimmed

pi-ai's `anthropic-messages` implementation imports `@anthropic-ai/sdk`. Bundling
the real SDK is not an option: this plugin ships as one file, and Obsidian Sync
refuses a single file over 5 MB. Measured on this tree:

| Stage | `dist/main.js` |
|---|---|
| before Anthropic | 5,006,087 B |
| with the real SDK | 5,658,476 B — **over the hard limit** |
| with `anthropic-sdk-shim.ts` | 5,097,060 B — still over the 4.8 MiB budget |
| after also stubbing unused pi model catalogs | 4,125,799 B |
| after removing the Google/Gemini provider | 3,162,611 B |

The first four rows are measurements taken at points during the #58 work, not a
chain of immediate predecessors. The tree this change starts from (`main`) builds to
4,137,811 B, and removing the Google provider brings it to 3,162,611 B (-975,200 B,
-23.6%) — see `tools/provider-settings-shots/metrics/nogoogle-bundle-size.metrics.md`
for the per-module attribution.

So `esbuild.config.mjs` aliases `@anthropic-ai/sdk` to
`src/runtime/pi/anthropic-sdk-shim.ts`, which implements only the surface pi
actually uses. A build-time usage check (`verifyAnthropicSdkUsage`) fingerprints
that surface and **fails the build** if pi-ai starts using something the shim does
not implement, rather than shipping a broken bundle.

The shim is wire-equivalent to the real SDK for this surface (URL, headers, body,
error mapping, timeout precedence), with one deliberate divergence: it does not send
`?beta=true` or the `X-Stainless-*` headers. Those are SDK-internal routing and
telemetry markers with no effect on the Messages protocol.

## Model listing and reachability

`model-catalog-service.ts` keeps listing, liveness and capability separate from
inference.

- **Anthropic**: `GET {baseUrl}/v1/models` with `x-api-key` and `anthropic-version`.
- **404 / 405 / 501** from that endpoint means *the endpoint does not offer a model
  list*, which is a capability gap, not a failure. It is surfaced as
  `ModelListingUnsupportedError` → `listingUnsupported: true, reachable: true`, and
  the panel prompts for a manually typed model id instead of reporting a connection
  error.
- **Other non-200** (401, 429, 5xx) and network errors are real failures →
  `reachable: false` with the underlying reason.

`AvailableModelsResult.listed` is the authoritative answer to "did the endpoint
actually advertise these models?". It is `true` **only** when the endpoint returned
a non-empty list, computed *before* any fallback substitution and cached alongside
the rest of the verdict. Without it the panel cannot distinguish a real listing from
the built-in fallback list, and would present — and auto-fill — model names the
endpoint never claimed. Gateways that cannot list models therefore still work, via
manual entry.

## Thinking

Thinking is capability-gated per model and driven by the project's `thinkingLevel`.
It is never sent as OpenAI's `reasoning_effort`.

- `thinkingLevel: 'off'` → the request contains **no** `thinking` field at all
  (not `thinking: {type: "disabled"}`).
- Models that support adaptive thinking (`supportsAdaptiveThinking()`) → the effort
  tier is sent as `output_config.effort` with `thinking: {type: "adaptive"}`.
- Other Claude models → `thinking: {type: "enabled", budget_tokens}`, with the budget
  clamped inside `max_tokens` by pi so `budget_tokens >= max_tokens` cannot occur.

`max_tokens` is required by the Messages API and defaults to 8192
(`ANTHROPIC_MAX_TOKENS`), which every Claude model accepts.

## Prompt caching

Caching is opt-out through pi's `cacheRetention` option. When a request is issued
with `cacheRetention: 'none'`, no `cache_control` is emitted — so an endpoint that
does not support prompt caching can be used without sending invalid fields. With the
default retention, pi marks cache breakpoints itself and reports cache reads/writes
through usage.

**Limit:** the plugin does not currently expose a caching toggle in settings, and it
does not add `cache_control` on its own. Caching is pi's default behaviour, gated by
the option the caller passes.

## Images

`buildAnthropicModel` declares `input: ['text', 'image']`, so image content is passed
through to Anthropic's image blocks for models that accept them. Capability is
declared per model, not per provider; text is always supported.

## Known limits

- **Custom headers are not forwarded on the stateless generation path.**
  `createNativeCompleteFn()` only injects the api key (and the opencode session
  header); unlike `createNativeStreamFn()`, it has no `getHeaders` hook. This is
  pre-existing and affects both protocols equally, not just Anthropic. Chat and
  streaming are unaffected.
- **`deps` injection is Anthropic-only.** `model-catalog-service.ts` threads the
  injectable `requestUrl` only into the Anthropic listing path, so the
  OpenAI-compatible lister cannot be driven by an injected fake in tests.
- **`stubUnusedPiModelCatalogs`** (`esbuild.config.mjs`) reclaims ~973 KB by
  emptying the model catalogs of the 41 pi providers Baizer does not use. If a future
  change needs pi's static catalog for one of those providers, that plugin must be
  narrowed — see the comment in the build config.
