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

### Skills

Skills are registered in `SkillRegistry`.

They provide:

- workflow discovery
- slash command mapping
- keyword-based intent routing
- tool subsets plus workflow instructions

Seven built-in skills are registered in `main.ts`, each from a
`src/skills/builtin/<name>/SKILL.md`:

- `web-search`
- `web-clipper`
- `obsidian-markdown`
- `json-canvas`
- `obsidian-bases`
- `plugin-ctrl`
- `knowledge`

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
