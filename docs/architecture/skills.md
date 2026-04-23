# Skills And Tools

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

Built-in skills currently cover:

- `web-search`
- `web-clipper`
- `knowledge`
- `plugin-ctrl`

User-defined `SKILL.md` files can also be loaded from the vault.

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
