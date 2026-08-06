# Baizer Glossary

The words this codebase uses, defined. Read an issue, a file, or a prompt string
and know what is being talked about.

This is a glossary and nothing else — no architecture, no implementation detail.
For how the pieces fit together, see [`docs/architecture/`](./docs/architecture/)
and [`CLAUDE.md`](./CLAUDE.md).

Where a word is used inconsistently in the code, the canonical meaning is given
and the other usage is named as one to avoid.

---

## The two distinctions that matter most

Get these wrong and nothing else will make sense.

### Tool vs Skill

**Tool** — a single named capability the model can call, with a JSON-schema
parameter list. A tool *does* something: reads or writes a note, fetches a URL,
runs another plugin's command. **Tools are the only things that execute.** Each
declares a risk category (`read`, `write`, `plugin-control`, `network`,
`unknown`), and that category is what the permission layer reads.

**Skill** — a named bundle of behavior instructions: a Markdown document telling
the model how to approach a class of task. **A Skill executes nothing.** It has
no path to the vault or the network. The only thing it changes is what the model
reads, and therefore which Tools the model chooses to call.

> Said once more: a Tool is a verb the model can invoke. A Skill is advice the
> model can read.

Skills come in three kinds, and the kind decides who owns the file:

| | **Built-in** | **User** | **Derived** |
|---|---|---|---|
| written by | us, in the repo | you, by hand | Baizer, from something already installed |
| on-disk copy is | a cache, overwritten every launch | the original | a cache, rewritten when its source moves |
| exists as long as | the plugin is installed | you keep the file | its source and its permission both hold |

**Derived skill** — a Skill generated *from* something else already present, and
named after it. The only ones today are the `plugin-<id>` skills written from
another installed Obsidian plugin. Two properties set them apart, and both are
consequences of being derived rather than authored:

- **The file is a cache; the truth is the current state of the source.** A
  derived skill is reconciled at every launch against its source. If the source
  is gone, disabled, excluded, or unpermitted, the skill is not offered — the
  file stays on disk, but it does not count.
- **Their existence is gated on a permission**, so they are the one exception to
  the availability/permission orthogonality below. A `plugin-*` skill is only
  generated, and only offered, while plugin control is granted. Advice for
  calling a tool the model may not call is not advice.

### Memory vs Knowledge Wiki

Two completely separate stores, and the pair most often confused. Nothing flows
between them.

| | **Memory** (Hindsight) | **Knowledge Wiki** |
|---|---|---|
| a unit is | one short statement | one Markdown article |
| about | you — your facts, preferences, past turns | your notes' content |
| written by | Baizer, automatically | Baizer, by compiling notes you chose |
| lives | hidden under `.obsidian/`, never a vault note | a visible vault folder |
| reaches the model by | injection into the prompt | the model reading an index, then articles |

**Recall** always means memory. **Compile**, **query**, and **article** always
mean the wiki. Clearing a conversation clears neither.

---

## Conversation and history

**Turn** — one user request plus everything the assistant does in response, up
to the point it stops. The unit that gets prepared, executed, persisted, and
remembered.

**Run** — a single in-flight execution of a turn. At most one is active at a
time. A run is what can be interrupted or steered while it is happening; an
interrupted turn still had a run.

**Conversation** — one user-visible chat thread, one Workbench tab.
Conversations are isolated: history in one is invisible to the others.

**Session** — the durable transcript one conversation accumulates: the ordered
on-disk record that survives restarts and is what the model sees as history. One
session per conversation. A session's history is a **tree**, not a list.

**Entry** — one append-only item in a session. Most entries are messages, but not
all: a compaction summary is also an entry. "Entry" is the unit of the history
tree; "message" is one kind of entry.

**Branch** — the single path through a conversation's history tree currently in
effect, oldest entry to newest. The next turn builds on the current branch.
Unrelated to git branches.

**Branch projection** — flattening the current branch of the session tree into a
list of messages the UI can render. Reads the durable session; produces a fresh
list. This is what happens when you switch between siblings.

**Message projection** — the per-tab read-only copy of the message list the
Workbench renders from. It is *received*, never authored: `ChatController` owns
the list, and the projection follows. Writing to a projection directly is how the
two copies drift apart.

> Both are called "projection" in code (`projectBranchToMessages`,
> `getBranchProjection`). They are different: a **branch projection** is derived
> from the session tree and answers "what does this branch look like"; a
> **message projection** is a mirror of the owning list and answers "what should
> this tab render". Say which one you mean.

**Fork / edit / retry** — going back to an earlier point and continuing from
there. Fork and edit leave the original continuation intact as a **sibling**,
navigable in the UI. Retry marks the replaced branch superseded, so it is not
offered as a sibling. All three are the same underlying move with different
inputs.

**Compaction** — shrinking a conversation's history once it outgrows the context
window, by replacing older material with a summary. Happens after a turn
finishes, invisible, and **deletes nothing** from the record. Not the same as
clearing history.

---

## Running a turn

**Prepared turn** — a turn after everything the model needs has been assembled
around the request, and before any of it is executed.

**Decoration** — the part of a turn sent to the model every time but never kept
as history: recalled memory, current time, workspace context, the skill list, the
slash-command contract, the generation plan. Kept out of the persisted prompt so
history stays clean.

**Ambient context** — background about what the user happens to be looking at
right now (the open note, its backlinks) that nobody asked to include. Labelled
to the model as possibly irrelevant, and dropped when the user's message is only
a short confirmation.

**Short confirmation** — a reply so short it can only be answering the previous
turn ("yes", "继续", "用第二个") rather than starting something new. Recognising
these is what keeps the open note from hijacking the intent. Only treated this
way when the conversation already has history.

**Generation plan** — a per-turn decision about what shape of output the request
calls for, checked against the result afterwards.

**Active tool set** — the tools in play for the current turn. The full registry
by default; narrowed to a Skill's declared subset only when that Skill was
force-activated. `read_skill` is always added back.

**Force-activation** — the user naming a Skill for this turn, by typing its slash
command. This is the *only* thing that narrows the active tool set, and the only
thing that replaces the skill list with one skill's full instructions. Nothing
Baizer infers counts as force-activation.

**Keyword hint** — a Skill matched by a keyword in the user's message. A hint is
a *suggestion to the model*, nothing more: the full skill list stays in the
prompt and every tool stays available. Distinct from force-activation, which the
user asked for; a hint is a guess, and a guess must not take capabilities away.

**read_skill** — the ordinary Tool that returns a Skill's full instruction text
by name. This is the mechanism that makes Skills do anything: the text lands in
the conversation and the model follows it. Always available, so the model can
never be trapped inside one Skill.

**Progressive disclosure** — the arrangement where the system prompt carries only
a *list* of skills, and full instructions are fetched on demand. What makes a
large skill library nearly free per turn.

**Steering** — adding instructions to a run already in flight instead of waiting
for it to finish. If nothing is running there is nothing to steer — steering is
not a queue.

**Approval** — a tool refusing to act until the user says yes, returning a
structured request with the action, target, arguments, and a preview. Asking for
approval **ends the turn**; the user's answer arrives as the next one.

**Harness** — the vendor (pi) engine that drives a run: decides when to call the
model, when to call tools, and emits the events the UI renders. A borrowed word,
not a Baizer concept. Baizer supplies the pieces and consumes the events; it does
not own the loop.

**Provider** — the service an inference request goes to, plus the credentials and
address needed to reach it. One provider offers many models; exactly one is
active at a time. Two shapes exist: Gemini and OpenAI-compatible.

**Model handle** — everything needed to talk to the model for one run, rebuilt
fresh at the start of each one. This is why a settings change takes effect on the
next turn rather than needing a restart.

**Thinking level** — how much deliberation to ask the model for: `off`,
`minimal`, `low`, `medium` (default), `high`, `xhigh`. A dial set per turn. Do
not confuse it with the *thinking timeline*, which is the UI element that shows
the model's reasoning as it streams.

---

## Generated artefacts

Two subsystems write files *from* other files — the wiki compiles notes into
articles, and plugin control writes derived skills from installed plugins. They
share this vocabulary.

**Staleness** — whether a generated file still matches what it was generated
from. Always decided by **content hash**, never by timestamps: a file touched
without being changed is not stale, and a clock that disagrees does not matter.

**Local edit** — a generated file the user has since changed by hand, detected by
the same hash the generator recorded when it wrote the file. Staleness and local
edit are independent, and both being true is the interesting case: the source
moved *and* the user has work in the file. Regenerating would destroy the work,
so that case is reported and nothing is overwritten.

> The rule this expresses: **regeneration may overwrite what we wrote, never what
> you wrote.**

---

## Permissions

**Write scope** — *where* writes may land: `read-only`, `current-note`,
`configured-folders`, or `all-vault`. `.obsidian` is always blocked regardless.

**File capability** — *what kind* of write is permitted at all, independent of
where it points: creation and modification are separate switches.

Scope and capability are **orthogonal**; a write must satisfy both.

**Risk** — a category each Tool declares about itself (`read`, `write`,
`plugin-control`, `network`, `unknown`). It is what decides whether an action
needs approval, not a judgement made per call.

**Skill availability** — whether a Skill is offered to the model at all. This is
**orthogonal to permissions**: disabling a Skill hides advice, it does not revoke
a capability. The model can still call the underlying Tool directly.

The orthogonality is about *availability*, not *existence*, which is why derived
skills do not contradict it: a permission does not silence them, it is the
precondition for there being one at all.

---

## Guardian (the inline co-writer)

**Guardian** — the mode that suggests continuations inline as you write, as
opposed to the Workbench where you converse.

**Ghost text** — the greyed inline suggestion itself. Tab accepts, Esc dismisses.

**Fast path / deep path** — two independently cancellable completion routes. The
fast path is lightweight and abandoned on every keystroke. The deep path is
manual or auto-escalated, reads knowledge-base context, and is *not* interrupted
by typing.

**Anchor** — the cursor position a suggestion belongs to. Moving away
invalidates it. Each anchor escalates to the deep path at most once.

**Dwell** — pausing at one anchor long enough for the deep path to be worth
starting. What distinguishes "still typing" from "stuck".

**Escalation** — promoting a weak or absent fast suggestion to the deep path
after a dwell.

---

## Knowledge Wiki

**Article** — one compiled output document. Distinct from the **source note** it
was compiled from: the note stays yours and untouched, the article is generated
and safe to delete.

**Compilation** — turning source notes into articles. Runs map-reduce over a
note's parts, so a long note does not have to fit in one context window.

**Staleness** — see the general definition under *Generated artefacts*. For the
wiki it means a source note changed after its article was built.

**Compile status** — per-note progress: `pending`, `processing`, `done`,
`failed`. Lives in the source note's frontmatter, so it is visible in Obsidian.

**Ontology** — the schema describing what kinds of things your notes talk about
and which properties they carry. Discovered from your vault, then used to drive
extraction, which is what makes articles comparable to each other.

**File-back** — taking an answer Baizer already gave in chat and filing it into
the wiki as an article, instead of compiling it from a note.

**Index** — the searchable listing of all articles, materialized as a `.base`
file so Obsidian's own Bases feature can query it.

---

## Memory (Hindsight)

**Memory record** — one stored statement, of exactly one of three kinds:

- **world** — a durable fact about you or your setup ("prefers Chinese replies")
- **experience** — something that happened in a past turn
- **observation** — a generalisation Baizer derived from several of the above

**Recall** — retrieving records relevant to the current request and injecting
them into the prompt.

**Consolidation** — periodically compressing raw records into observations. Each
observation keeps evidence pointers to the records it came from, so a surprising
one can be traced back.

**Retirement** — marking an old fact superseded when a conflicting newer one
arrives, so recall does not serve both. Retired records are flagged, not deleted.

---

## Workbench UI

**Workbench** — the main chat view. In code it is the `ShellView`; **Workbench**
is the user-facing name and the one to use in docs and UI text.

**Timeline** — the foldable trace of tool calls and model thinking shown
alongside an answer.

**Already rendered** — a message that reached the screen through stream events as
it arrived, so recording it must not draw it a second time. Recording and drawing
are separate acts: recording always happens, drawing is conditional on this fact.
Conflating the two is what let a streamed reply exist in one list and not the
other.

**Context item / context chip** — a note or selection the user explicitly
attached to the request, shown as a removable chip. Explicit, unlike ambient
context.

**Slash command** — a `/`-prefixed command in the input. Built-in ones are
handled by the chat controller; skills contribute more; users can add their own
by dropping a Markdown template into the commands folder.

**Approval card** — the UI rendering of an approval request, with the action, its
target, and a preview of the change.

**Selection menu** — the floating menu that appears when text is selected in a
note, offering AI actions on that selection.
