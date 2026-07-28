# 0001 — Publish the full git history as-is

**Status:** Accepted
**Date:** 2026-07-27

## Context

Baizer was developed for eight months in a private repository before being open
sourced. At the point of publication the history contained 268 commits and the
`.git` directory was 22 MB. Three things in that history gave us pause:

1. **A `node_modules` commit.** An early commit tracked the full dependency
   tree, including `typescript/lib/tsserver.js` (11 MB) and
   `@esbuild/win32-x64/esbuild.exe` (9 MB). Those blobs are the reason the
   repository is 22 MB rather than roughly 3 MB.
2. **94 internal workflow files.** Planning notes, agent instruction files, and
   personal to-do lists (`.planning/`, `FORYF.md`, `AGENTS.md`, `TODOS.md`) were
   tracked at various points before being removed and gitignored. They are
   reachable via `git show`.
3. **Two personal email addresses** in commit metadata, as in any git history.

We verified before deciding:

- **No credentials anywhere.** Every commit was scanned for provider key shapes
  (`sk-`, `AIza`, `ghp_`); zero matches across the full history.
- **No AI conversation content.** The `.omc/session/*.json` files that were
  briefly tracked contain only metadata — session id, timestamp, agent counts.
  A tracked `.claude/settings.local.json` blob held only tool-permission
  allowlists.

The alternatives were to squash to a single initial commit, or to run
`git filter-repo` to strip the offending paths while preserving commit
structure.

## Decision

Publish the history unchanged.

## Consequences

**What we get.** `git blame` and `git bisect` work across the whole codebase.
For 30,000 lines across 115 files, that is the difference between a contributor
being able to ask "why is this line here?" and not. The eight months of
development are also legible as a record of how the design arrived where it did.

**What we accept.**

- A 22 MB clone instead of ~3 MB. Measurable, but not an obstacle.
- Internal planning notes in Chinese are readable by anyone who goes looking,
  including one spec file with a marketing-style title. Mildly embarrassing,
  not harmful.
- Two email addresses are public. Open sourcing a git history means publishing
  its metadata; there is no version of this that avoids that.

**Why not the alternatives.**

*Squashing* would have thrown away all 268 commits to save 19 MB and hide some
planning notes — trading a permanent, daily-felt loss of provenance for a
one-time cosmetic gain.

*`git filter-repo`* would have preserved blame while stripping the paths, but it
rewrites every commit SHA. Twenty-one branches would have needed rewriting or
discarding, and local worktrees would have broken. That is real work and real
risk, and with no credentials in the history, it buys only a smaller clone and
less-visible planning notes.

Neither cost was worth paying for what it bought.

## Note for future readers

If you are looking at this repository wondering why it is larger than a plugin of
this size should be, this is why, and it was deliberate. Rewriting the history
now would be strictly worse than it would have been at launch: every fork, every
issue referencing a commit SHA, and every external link would break. The answer
to "should we clean up the history?" is no.
