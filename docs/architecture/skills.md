# Skills And Tools

**A Tool is a verb the model can invoke. A Skill is advice the model can read.**

If something writes a file, it is a Tool. If something tells the model *how* to
write files, it is a Skill. A Skill has no path to the vault or the network — the
only thing it changes is what the model reads, and therefore which Tools the
model decides to call. This is the distinction newcomers get wrong most often.

## Layering

The plugin uses two orchestration layers:

### Atomic Tools

Atomic tools are registered in `ToolRegistry`.

They should:

- do one thing
- stay stateless
- return structured results
- avoid shell/UI concerns

Examples:

- vault operations
- web search
- webpage save helpers
- plugin inspection
- knowledge query and file-back

A tool may declare `visibility: 'feedback-session'`, which keeps it out of the
tool list every conversation sees. `ToolRegistry.getAllDefinitions()` **excludes**
those tools by default (`includeFeedbackTools` opts them back in), so the default
is fail-closed: a tool added later with that visibility cannot leak into ordinary
chats by someone forgetting to update a call site. Only the feedback session's
assembly point opts in. This is deliberately stronger than an execution-time gate
like `allowPluginControl` — the model never sees the tool at all, rather than
seeing it and being refused.

### Skills

Skills are registered in `SkillRegistry`.

They provide:

- workflow discovery
- slash command mapping
- keyword-based intent routing
- tool subsets plus workflow instructions

Eight built-in skills are registered in `main.ts`, each from a
`src/skills/builtin/<name>/SKILL.md`:

- `web-search`
- `web-clipper`
- `obsidian-markdown`
- `json-canvas`
- `obsidian-bases`
- `plugin-ctrl`
- `knowledge`
- `feedback`

`feedback` is the odd one out: it is never discovered. It carries
`disable-model-invocation` and is excluded from `<available_skills>`, because it
is only ever force-activated inside a dedicated feedback tab (`forcedSkillName`).
Listing it in ordinary conversations would invite the model to read it and then
run a turn with neither its clarification policy nor its four tools.

User-defined `SKILL.md` files can also be loaded from the vault, out of
`.obsidian/baizer/skills/`.

### Progressive disclosure

Skill instructions are **not** in the system prompt. Only a list of names and
one-line descriptions is, under `<available_skills>`. The model pulls a skill's
full text on demand by calling `read_skill(name)` — an ordinary tool, registered
by `registerSkillReadTool` and always available even when the active tool set
has been narrowed, so the model can never get trapped inside one skill.

This is why a large skill library costs almost nothing per turn: the prompt
carries the index, not the content.

> There is no `use_skill` meta-tool. It was removed in favour of the
> `<available_skills>` listing plus `read_skill`. If you find a doc or comment
> mentioning `use_skill`, it is stale.

Built-in `SKILL.md` files are *materialized* to a hidden vault directory on load
(`SkillRegistry.materializeBuiltins`), which is what lets `read_skill` treat
built-in and user skills identically.

The materialized copy is a cache, not the original: built-in skills are
**overwritten from the bundle on every launch**. Built-ins are code-owned, so a
hand-edit to a materialized built-in `SKILL.md` does not survive a restart —
change the file in `src/skills/builtin/<name>/SKILL.md` instead. Hand-authored
user skills in `.obsidian/baizer/skills/` are the opposite: those files are the
original and are never written by the plugin. The one exception in that directory
is the derived `plugin-<id>/SKILL.md` files, which the plugin generates and may
rewrite when their source plugin moves.
## Slash Commands

Slash commands should not be hardcoded when they are really workflow commands.

Current direction:

- local commands stay in controller/UI
- workflow commands come from `SkillRegistry.listCommandEntries()`

This powers both:

- slash command routing in `ChatController`
- command suggestions in `ShellView`

## Intent Routing

`SkillRegistry.resolveByIntent(...)` performs lightweight keyword scoring. It is intentionally simple and should stay predictable rather than “smart”.
