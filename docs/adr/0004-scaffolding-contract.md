# ADR-0004: The scaffolding contract

- Status: accepted
- Date: 2026-07-02

## Context

One CLI must scaffold *any* template (ADR-0003). That only works if every template
honours the same conventions for what gets rewritten, what marks the template, and
how dotfiles survive npm. This is the contract a template author must follow.

## Decision

Every Lunette template MUST honour the following, and `@lntt/create` implements the
matching rewrite:

- **Package scope placeholder `@starter`.** Shared packages use the `@starter/*`
  scope; the CLI rewrites `@starter` → `@<project-name>` when it prefixes a path
  (plain `/` or a regex-escaped `\/`). Do not use `@starter` for anything that
  should survive scaffolding.
- **`"name": "starter"`** in the root and devcontainer `package.json` → the project
  name. Nested package names ride on the scope rewrite.
- **Credentials placeholder `starter`** in `compose.yaml`, `render.yaml`, and the
  CI DB URL (`POSTGRES_*`, `databaseName`/`user`, `postgresql://starter:starter@…`)
  → the project name.
- **The `.lunette-template` marker** at the template root. Present = you are editing
  the template (ADRs may be renumbered); the CLI **strips it** on scaffold, so its
  absence marks a scaffolded project (ADRs append-only). See the template's own
  `docs/adr/0001-recording-decisions.md`.
- **Dotfiles npm would mangle** are stored `_`-prefixed (`_gitignore`, `_npmrc`,
  `_env`) and the CLI restores the leading dot on scaffold. (Applied at publish
  time; a template checked out for development may keep real dotfiles.)
- **Text-file coverage.** The rewrite runs over a known set of text extensions
  (including `.editorconfig` and dotless config basenames). A template must not
  hide a placeholder in a file type outside that set.

After copying and rewriting, the CLI runs `git init -b main` + an initial commit.

## Consequences

- \+ A single CLI scaffolds every present and future template with no per-template
  logic.
- \+ The rules are explicit, so a template author knows exactly what is a
  placeholder and what is preserved.
- − The contract is a coupling point: changing a placeholder or the marker means
  changing every template *and* the CLI together (they live in one repo, so it is
  one PR).
- − Text-file coverage is a list; a new config file type needs adding to it (the
  `.editorconfig` miss was exactly this).
