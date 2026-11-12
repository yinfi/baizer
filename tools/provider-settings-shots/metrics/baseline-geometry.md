# Baseline geometry (`154e483`) across the capture viewports

Why this file exists: baseline field truncation is **not monotonic in viewport width**, so a single
"narrow" capture cannot characterise the pre-rework layout. These are the raw numbers behind the
before/after metric tables, taken from the committed `.layout.json` reports.

Reproduce with:

```bash
node -e "for(const l of ['before-wide','before-narrow','before-narrow520','before-mobile']){const r=require('./docs/assets/provider-settings-2026-11-03-'+l+'.layout.json');console.log(l, r.viewport.innerWidth, JSON.stringify(r.settingsPageBox), JSON.stringify(r.alignment.connectionGridTemplateColumns), JSON.stringify(r.alignment.distinctGridTemplates), r.overflow.offenderCount, JSON.stringify(r.verdict.fieldsWithTextOverflow))}"
```

| viewport | page width | connection grid | value column | fields truncated | subtitle ellipsized | help block | offenders |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1353x1053 `-wide` | 688 | `314px 314px` (2 col) | 150.67 | **3** — apiEndpoint, apiKey, model | **yes** (316/390, 74px) | 151px / 8 lines | 6 |
| 600x900 `-narrow` | 324 | `272px` (1 col) | **250.67** | **0** | no | 251px / 5 lines | 2 |
| 520x900 `-narrow520` | 244 | `192px` (1 col) | 170.67 | **3** — apiEndpoint, apiKey, model | no | 171px / 8 lines | 5 |
| 400x800 `-mobile` | 124 | `72px` (1 col) | 50.67 | **5** — + providerName, protocol | yes (card labels) | 51px / 23 lines, overflows-x | 22 |

Two things worth carrying into the PR:

1. **The desktop layout is the worst case for field width, not the narrow one.** At 1353px the
   connection grid splits into two `314px` columns, squeezing the value column to 150.67px — narrower
   than the single 250.67px column the same page gets at 600px. So "wide screen" did not mean "roomy
   field" in the pre-rework layout.
2. **600px sits in a sweet spot and therefore passes everything on the baseline.** The two-column grid
   has already collapsed to one column there, but that column is still wide enough (250.67px) for the
   longest value (apiKey needs 219.27px). A 600px before/after pair consequently shows *no verdict
   change*; it demonstrates "no regression at the app's declared minimum width", while the 520px
   stress pair is where the baseline actually fails and the fix shows up.

Also note the settings page does not start at the window edge: at 520/600/400 the settings nav occupies
the first 232px, so a 600px window leaves the plugin page 324px. The popout declares
`minWidth: 600` (`Setting#getPopoutOptions()`), so 600px is the narrowest window the app itself
produces; 520px and 400px are forced viewport overrides and are diagnostic only.
