---
name: obsidian-bases
description: Create and edit Obsidian Bases (.base files) with views, filters, formulas, properties, and summaries.
triggers:
  keywords: ["bases", ".base", "table view", "card view", "cards view", "list view", "filter", "filters", "formula", "formulas", "database"]
tools: ["read_file", "create_file", "update_file", "search_vault", "open_file", "validate_base_yaml"]
---

# Obsidian Bases

Use this workflow when creating or editing `.base` files. Base files are YAML documents that define database-like views over notes.

## Workflow

1. Read the existing `.base` file when editing.
2. Define global `filters` to scope which notes appear.
3. Add `formulas` only when a computed property is needed.
4. Configure `properties` display names when the raw property names are not user-friendly.
5. Add one or more `views` with `type`, `name`, and `order`.
6. Run `validate_base_yaml` before writing.
7. Use `create_file` or `update_file` to write the exact `.base` path.
8. Use `open_file` when the user wants to inspect the rendered base.

## Schema

```yaml
filters:
  and: []

formulas:
  formula_name: 'expression'

properties:
  property_name:
    displayName: "Display Name"
  formula.formula_name:
    displayName: "Formula Display Name"

summaries:
  custom_summary_name: 'values.mean().round(3)'

views:
  - type: table
    name: "View Name"
    limit: 10
    order:
      - file.name
      - property_name
      - formula.formula_name
```

Valid view types: `table`, `cards`, `list`, `map`.

## Filters

Filters can be a string:

```yaml
filters: 'status == "done"'
```

Or a recursive filter object:

```yaml
filters:
  and:
    - 'status == "done"'
    - 'priority > 3'
```

Common file predicates:

```yaml
filters:
  or:
    - file.hasTag("book")
    - file.hasTag("article")
```

## Formulas

Use single quotes around formulas that contain double quotes:

```yaml
formulas:
  days_until_due: 'if(due, (date(due) - today()).days, "")'
  is_overdue: 'if(due, date(due) < today() && status != "done", false)'
```

Duration arithmetic returns a Duration, not a number. Access a field first:

```yaml
formulas:
  days_old: '(now() - file.ctime).days'
```

## Example

```yaml
filters:
  and:
    - file.hasTag("task")
    - 'file.ext == "md"'

formulas:
  days_until_due: 'if(due, (date(due) - today()).days, "")'

properties:
  formula.days_until_due:
    displayName: "Days Until Due"

views:
  - type: table
    name: "Active Tasks"
    filters:
      and:
        - 'status != "done"'
    order:
      - file.name
      - status
      - due
      - formula.days_until_due
```

## YAML Quoting Rules

- Quote strings containing `:`, `{`, `}`, `[`, `]`, `,`, `&`, `*`, `#`, `?`, `|`, `<`, `>`, `=`, `!`, `%`, `@`, or backticks.
- Wrap formulas containing double quotes in single quotes.
- Every `formula.name` reference in `views`, `properties`, or summaries must have a matching `formulas.name` definition.
