---
name: json-canvas
description: Create and edit JSON Canvas files (.canvas) with nodes, edges, groups, mind maps, flowcharts, and visual canvases.
triggers:
  keywords: ["canvas", "json canvas", "mind map", "mindmap", "flowchart", "diagram", "board", ".canvas"]
tools: ["read_file", "create_file", "update_file", "search_vault", "open_file", "validate_json_canvas"]
---

# JSON Canvas

Use this workflow when creating or editing Obsidian `.canvas` files. Canvas files are JSON documents with two top-level arrays:

```json
{
  "nodes": [],
  "edges": []
}
```

## Workflow

1. Read the existing `.canvas` file when editing.
2. Generate unique 16-character lowercase hexadecimal IDs for all nodes and edges.
3. Add nodes with required fields: `id`, `type`, `x`, `y`, `width`, and `height`.
4. Add edges only after both endpoint node IDs exist.
5. Run `validate_json_canvas` before writing or after producing updated content.
6. Use `create_file` or `update_file` to write the exact `.canvas` path.
7. Use `open_file` when the user wants to inspect the result in Obsidian.

## Nodes

Common node fields:

```json
{
  "id": "6f0ad84f44ce9c17",
  "type": "text",
  "x": 0,
  "y": 0,
  "width": 400,
  "height": 200,
  "color": "5"
}
```

Valid node types:

- `text`: requires `text`
- `file`: requires `file`; optional `subpath`
- `link`: requires `url`
- `group`: optional `label`, `background`, and `backgroundStyle`

Text node example:

```json
{
  "id": "6f0ad84f44ce9c17",
  "type": "text",
  "x": 0,
  "y": 0,
  "width": 400,
  "height": 200,
  "text": "# Main Idea\n\nThis is **Markdown** content."
}
```

Use `\n` for line breaks in JSON strings. Do not use literal `\\n`, because Obsidian renders those as backslash and n characters.

## Edges

Edges connect nodes through `fromNode` and `toNode`:

```json
{
  "id": "0123456789abcdef",
  "fromNode": "6f0ad84f44ce9c17",
  "fromSide": "right",
  "toNode": "a1b2c3d4e5f67890",
  "toSide": "left",
  "toEnd": "arrow",
  "label": "leads to"
}
```

Valid sides: `top`, `right`, `bottom`, `left`.
Valid ends: `none`, `arrow`.

## Layout

- Coordinates can be negative.
- `x` increases right, `y` increases down.
- Leave 50-100px between nodes.
- Leave 20-50px padding inside groups.
- Align coordinates to multiples of 10 or 20 for cleaner layouts.

Suggested sizes:

- Small text: 200-300 by 80-150
- Medium text: 300-450 by 150-300
- Large text: 400-600 by 300-500
- File preview: 300-500 by 200-400
- Link preview: 250-400 by 100-200

## Validation Checklist

Before writing a canvas file, ensure:

1. JSON parses successfully.
2. All IDs are unique across nodes and edges.
3. Every edge endpoint references an existing node.
4. Each node type has its required fields.
5. Side and end values are valid.
6. Newline characters inside node text are valid JSON escapes.
