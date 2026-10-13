---
status: accepted
date: 2026-07-23
tags: [scaffolding, contract, cli]
---

# The scaffolding contract

## Context

One CLI scaffolds *any* template ([template model](./template-model.md)). That
only works if every template honours the same conventions for what gets rewritten
and how dotfiles survive npm. This is the contract a template author follows.

## Decision

Every Lunette template MUST honour the following, and `@lntt/create` implements the
matching rewrite:

### Placeholders

- **Package scope placeholder `@starter`.** Shared packages use the `@starter/*`
  scope; the CLI rewrites `@starter` → `@<project-name>` when it prefixes a path
  (plain `/` or a regex-escaped `\/`). Do not use `@starter` for anything that
  should survive scaffolding.
- **`"name": "starter"`** in the root and devcontainer `package.json` → the project
  name. Nested package names ride on the scope rewrite.
- **Credentials placeholder `starter`** in `compose.yaml`, `render.yaml`, and the
  CI DB URL (`POSTGRES_*`, `databaseName`/`user`, `postgresql://starter:starter@…`)
  → the project name.

### Dotfiles

Dotfiles npm would mangle are stored `_`-prefixed (`_gitignore`, `_npmrc`, `_env`)
and the CLI restores the leading dot on scaffold. This applies at publish time; a
template checked out for development may keep real dotfiles.

### Text-file coverage

The rewrite runs over a known set of text extensions (including `.editorconfig`
and dotless config basenames). A template must not hide a placeholder in a file
type outside that set.

### After the copy

After copying and rewriting, the CLI runs `git init -b main` and an initial commit.

### A template carries no mode marker

Nothing in a template tells "template" from "scaffolded project" by its presence or
absence, and nothing needs to: a template's files follow the same rules while it is
drafted here as in the project it becomes. Inside this monorepo the path says which
log you are in.

### Verified in CI

A scaffold-smoke check (`SCAFFOLD_SMOKE=1`) installs a generated project and runs
its own lint + typecheck. A template-tooling regression (a malformed grit, a broken
Biome override, a missed `@starter` in a newly covered file type) fails here, not
only later in a scaffolded project's own CI.

## Consequences

### Positive

- A single CLI scaffolds every present and future template with no per-template
  logic.
- The rules are explicit, so a template author knows exactly what is a placeholder
  and what is preserved.
- A rule that differs between template and project is a sentence its reader sees,
  not a file whose absence must be noticed.

### Negative / accepted risks

- The contract is a coupling point: changing a placeholder means changing every
  template *and* the CLI together (they live in one repo, so it is one PR).
- Text-file coverage is a list; a new config file type needs adding to it.
- Both `CLAUDE.md` files are in scope when working here, so the root one must say
  explicitly that the template's rules address derived projects.

### When to deviate (revisit triggers)

- A placeholder starts colliding with real content in a template (a dependency or
  a word that legitimately contains `starter`).
- A template needs a file type the rewrite cannot treat as text.

## Discarded directions

- **A `.lunette-template` marker file** whose presence meant "template" and whose
  absence meant "scaffolded project". Downstream the signal was the *absence* of a
  file, readable only by someone who already knew to look for it, which is
  knowledge that arrives through the same `CLAUDE.md` that can state the rule
  directly. Upstream it was redundant with the path. Its one advantage, that a
  template folder copied out of this monorepo still declares what it is, covers a
  workflow nobody follows.
- **A path rule alone** ("under `packages/create/templates/` → template"). It keys
  on where the checkout sits rather than on what the content is, and `templates` is
  a generic directory name: `packages/test-utils/templates/` exists inside every
  generated project. The path stays an informal cue, not the recorded rule.
