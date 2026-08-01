# 0002 — A keyword match hints, it never narrows the tool set

**Status:** Accepted
**Date:** 2026-07-31

## Context

`SkillRegistry.resolveByIntent` scores a message against each Skill's declared
keywords: one point per keyword found as a substring, highest score wins, any
score above zero is a match. `BaseChatRuntime.prepareTurn` then treated that
match exactly as it treated a slash command:

```ts
const skillName = request.forcedSkillName
  ?? this.deps.skillRegistry.resolveByIntent?.(request.userMessage)?.name;
```

Three things followed from a match, and the third is the one that bites:

1. the active tool set was narrowed to the Skill's declared `tools` subset,
2. `allowedToolNames` became a hard gate in `pi-tool-adapter`, so anything
   outside the subset could not be called even if the model tried,
3. the `<available_skills>` listing was **replaced** by that one Skill's full
   instructions — so the model could no longer see what other skills existed,
   and `read_skill` had no names left to ask for.

Substring scoring is loose enough that this fires on ordinary requests.
"帮我搜索一下 vault 里关于 X 的笔记" contains `搜索`, so it matched `web-search`,
whose declared tools are `["web_search"]`. For that turn the model could not read
a note — the user asked about their vault and the only tool left pointed at the
internet.

Two things made it worse over time. Derived `plugin-*` skills carry up to eight
keywords each, extracted from English plugin descriptions with only stop-words
filtered, so words like `note`, `file`, `search`, `table` and `editor` enter the
keyword space; the more plugins installed, the more often a match fires. And
`CONTEXT.md` already documented the intended behaviour — "narrowed to a Skill's
declared subset **only when that Skill was force-activated**" — so the code was
the thing out of line, not the glossary.

## Decision

Only force-activation narrows. Force-activation means the user typed the Skill's
slash command; nothing Baizer infers qualifies.

A keyword match becomes a **hint**: the full skill list stays in the prompt,
every tool stays available, and the match contributes at most a line suggesting
the Skill may be relevant. The model decides whether to `read_skill` it.

## Consequences

The worst case for a wrong guess is now one wasted line of prompt, rather than a
turn the model cannot complete. This is the whole point: scoring stays
deliberately dumb — as `docs/architecture/skills.md` says, predictable over smart
— and dumb scoring is only safe when being wrong is cheap.

A keyword match no longer *guarantees* the model follows that skill. It never
reliably did: `read_skill` was always in the tool set precisely so the model
could escape a narrowed scope, so narrowing was never a hard commitment anyway —
it just removed the other tools on the way.

### Why not the alternatives

*Deleting keyword routing outright* is tempting and nearly right. Progressive
disclosure already handles discovery: the model reads the list and picks. But the
list carries only one-line descriptions, and a keyword is a cheap way to surface
a Skill whose description does not obviously cover the phrasing the user used.
Keeping the mechanism costs one line of prompt now that it cannot remove tools.

*Raising the match threshold* — word-boundary matching, a minimum score, a
minimum keyword length — treats a loose guess as fixable by tuning. It is not:
any threshold is still a guess, and the failure mode it leaves in place is the
severe one. It also does nothing about the third consequence above, the
`<available_skills>` listing disappearing. Tuning the guess is worth doing only
if being wrong is already survivable, which is what this decision establishes.
