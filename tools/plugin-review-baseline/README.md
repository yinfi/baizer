# plugin-review-baseline

Reproducible measurement harness for the Obsidian community-plugin **Review**
scan of this plugin (issue #69).

The Obsidian scorecard reports a number of findings ("warnings") produced by
its own type-aware linter. That linter is not published, so the counts on the
scorecard cannot be recomputed directly. This harness reproduces them locally
with a type-aware ESLint config that mirrors the scanner's ruleset, so that
progress on issue #69 is measurable in the repo instead of on a web page.

## Run it

```bash
npm run lint:review
```

Runs type-aware ESLint over `main.ts` and `src/` using
`eslint.review.config.mjs`, then writes:

- `metrics/lint-review.json` — full machine-readable report
- `metrics/lint-review.md` — same data as tables

and prints the totals plus the top rules.

### Freeze a baseline from a captured ESLint run

```bash
node tools/plugin-review-baseline/report.mjs --from <eslint-json> --name <basename>
```

`--from` aggregates an already-captured ESLint JSON formatter output instead of
running ESLint. Use it when `src/` is being edited concurrently and you need the
"before" numbers to stay stable. `metrics/baseline-pristine.json` /
`metrics/baseline-pristine.md` were produced this way.

Options: `--from <file>`, `--name <basename>` (default `lint-review`),
`--out <dir>` (default `tools/plugin-review-baseline/metrics`).

## What it reproduces

Captured on the pristine checkout (before any fix for #69):

| metric | value |
| --- | ---: |
| files linted | 127 |
| files with problems | 88 |
| errors | 90 |
| warnings | 2972 |
| **problems** | **3062** |

Problems per rule (pristine):

| count | rule |
| ---: | --- |
| 1194 | `@typescript-eslint/no-unsafe-member-access` |
| 564 | `@typescript-eslint/no-explicit-any` |
| 486 | `@typescript-eslint/no-unsafe-assignment` |
| 396 | `@typescript-eslint/no-unsafe-call` |
| 162 | `@typescript-eslint/no-unsafe-argument` |
| 75 | `@typescript-eslint/no-unsafe-return` |
| 63 | `@typescript-eslint/no-unnecessary-type-assertion` |
| 38 | `@typescript-eslint/require-await` |
| 18 | `@typescript-eslint/no-unused-vars` |
| 14 | `@typescript-eslint/no-misused-promises` |
| 11 | `@typescript-eslint/no-unused-expressions` |
| 10 | `@typescript-eslint/no-redundant-type-constituents` |
| 8 | `@typescript-eslint/no-floating-promises` |
| 7 | `no-useless-escape` |
| 4 | `prefer-const` |
| 4 | `@typescript-eslint/ban-ts-comment` |
| 3 | `@typescript-eslint/no-base-to-string` |
| 2 | `no-case-declarations` |
| 2 | `@typescript-eslint/unbound-method` |
| 1 | `no-irregular-whitespace` |

The full per-rule, per-rule+file and per-file breakdown is in
`metrics/baseline-pristine.json`.

### Agreement with the scorecard

For `@typescript-eslint/no-unsafe-member-access` — the largest category on the
scorecard — the local run and the scorecard agree on the shape of the problem:

| | scorecard | local (pristine) |
| --- | ---: | ---: |
| reported issues | 1150 | 1194 |
| distinct files | 61 | 61 |
| listed locations | 953 (unique) | 1194 |

The **same 61 files** are flagged on both sides, with a closely matching
per-file ordering. The absolute counts differ because the scanner's exact rule
options, ESLint/`typescript-eslint` versions and file set are unknown. This
harness is therefore a faithful *relative* instrument (is this file/rule getting
better or worse?), not an exact predictor of the scorecard number.

## Known limitations

1. **Not the scanner.** The Obsidian scanner's ruleset is closed-source. This
   config was assembled from the scorecard's own category list. Rules the
   scorecard reports that ESLint cannot express are absent here (all
   `obsidianmd/*` rules, the CSS checks, `no-console`, `fetch` usage checks,
   artifact attestations, malware/network scans). Conversely this config reports
   rules the scorecard does not list (`@typescript-eslint/require-await`,
   `@typescript-eslint/no-unused-expressions`, `ban-ts-comment`,
   `no-base-to-string`, `prefer-const`).
2. **Counts are not comparable one-to-one.** `3062` (local problems) and `3002`
   (scorecard issues) are different measurements. Do not present one as the
   other.
3. **Numerical coincidence, not identity.** The pristine local run happens to
   report 2972 severity-`warn` messages, which is also the scorecard's
   "Warnings" badge. The two numbers are computed from different rule sets and
   different file sets; treat the equality as a coincidence.
4. **Type-aware linting needs a clean type graph.** `parserOptions.projectService`
   uses the repo's `tsconfig.json`. If `src/` has type errors, results shift.
   `npx tsc --noEmit` should be clean before trusting a run.
5. **`src/` is edited concurrently during #69.** A live `npm run lint:review`
   reports the working tree at that moment, not the released code. Use `--from`
   against a captured run for stable "before"/"after" comparisons.
6. **Scope.** Only `main.ts` and `src/**/*.ts` are linted. `test/`, `scripts/`
   and `tools/` are ignored, matching the scanner's view of the shipped plugin.
   `styles.css` is not linted at all, so the CSS categories on the scorecard
   (e.g. `!important`, `:has`, duplicate declarations) have no local
   counterpart.
7. **CI is unaffected.** This config is *not* loaded by `eslint.config.mjs`.
   `npx eslint .` continues to use the repo's non-type-aware config and must
   stay clean.

## Files

| path | role |
| --- | --- |
| `eslint.review.config.mjs` | the type-aware config (copy of the repo-root `.eslint-typed.probe.mjs` prototype) |
| `report.mjs` | runs ESLint / aggregates a capture, writes the JSON + Markdown report |
| `extract-scorecard.mjs` | one-off provenance tool: turns the captured scorecard page payload into `docs/plugin-review/scan-inventory.json` |
| `metrics/baseline-pristine.{json,md}` | frozen pre-fix baseline, aggregated from a captured run |
| `metrics/lint-review.{json,md}` | most recent live run over the working tree |

See also `docs/plugin-review/` for the full classification of the scorecard's
findings and the batch plan.
