# reference/

Raw source material the project is built **from**, kept in one place so the whole
evolution is explorable from a single clone: legacy code (any language), database
dumps, exported prototypes, design references, screenshots.

This is **input, not a decision** — the decisions it informs live in
[`docs/product/`](../docs/product/README.md) (product/design) and
[`docs/adr/`](../docs/adr/README.md) (architecture). A reference item is *read-only
history*: you don't edit it to change the project, you write a decision that
supersedes it.

## Rules

- **Quarantined from the toolchain.** Nothing here is a workspace package. It is
  ignored by Biome, never type-checked, never built, never tested. Drop a PHP app,
  a `.sql` dump or a prototype export in and CI won't touch it.
- **Committed, on purpose.** It ships in the repo so the reference travels with the
  code. Be deliberate: large binaries and multi-MB SQL dumps live in git history
  forever. If a dump is huge or sensitive, keep it out and link to where it lives
  instead.
- **Organize by kind, date what you drop.** Suggested (not mandated) layout —
  group by kind and stamp each item so "which snapshot is this" is never a guess:

  ```
  reference/
    <legacy-source>/     # the old app's code
    db-dumps/            # YYYY-MM-DD-<name>.sql
    prototypes/          # exported/interactive prototypes, design refs
  ```

- **Sunset it.** When a reference has been fully digested into decisions and code,
  it can be archived or removed — say so in the decision that closes it out.

> This folder ships empty on purpose — fill it with your project's material.
