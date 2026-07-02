# Spike: `@lntt/create` in the create-vite shape

**Throwaway.** This branch explores merging the scaffolder and the template into
one monorepo, using the model `create-vite` / `create-next-app` use: **template
variants are folders bundled inside the CLI package**, copied verbatim. No
runtime `git clone`, and — crucially — **no "exclude myself"** problem, because
the CLI's own files never live among the template files.

## What's here

```
packages/create/
  package.json            # @lntt/create — files: [bin, templates]
  bin/index.mjs           # discover variants → select (--template or prompt) → copy → rename
  templates/
    default/              # demo stand-in for the FULL starter monorepo
    minimal/              # a second variant = just another folder
  test/scaffold.test.mjs  # scaffolds each variant into a temp dir, asserts invariants
```

Run it: `node packages/create/bin/index.mjs my-app --template default`
Test it: `pnpm --filter @lntt/create test` (3/3 green).

## How it maps to reality

- `templates/default/` here is a **stand-in**. In the real thing it holds the
  entire current starter tree (packages/, apps/, turbo.json, docs/adr, …).
- `templates/minimal/` shows a variant is **just an extra folder** — this is the
  whole point, and it's exactly what [issue #3](../../../) (multi-template +
  interactive prompt) asked for. The prompt + `--template` flag are already wired.
- The scaffolder copies the chosen folder, restores dotfiles, and rewrites the
  `@starter/*` scope + `"name": "starter"` to the project name (same rules the
  standalone CLI uses today).

## The three gotchas (all handled or noted)

1. **npm mangles dotfiles.** Published tarballs drop/rename `.gitignore` etc., so
   templates store them as `_gitignore` / `_npmrc` / `_env` and the CLI restores
   them on scaffold. (Demonstrated + tested.)
2. **Nested monorepo → workspace exclusion.** Each variant is itself a pnpm
   monorepo. The outer workspace globs (`packages/*`, `apps/*`) must NOT reach
   inside `templates/**`, or pnpm would try to install template packages as
   members. Here they don't (templates are 3 levels deep), but a real move needs
   this asserted.
3. **Template DX.** You develop/test a variant *inside* `templates/<name>/`
   (its own `pnpm install`), not from the outer root — the create-vite price.

## Where this should really live

NOT inside the `starter` repo (that reintroduces the "template = repo root"
confusion). The clean home is a **dedicated tooling monorepo** (the current
`create-lunette` repo, restructured): the CLI at the package level, the starter
content moved under `templates/default/`. The standalone `starter` repo then
either retires or becomes the canonical source that syncs into `templates/default/`.

This `packages/create/` placement is only for the spike, to demonstrate the
mechanism without a cross-repo move.

## Publish flow (vs today)

- Today: CLI `git clone`s `LunetteOrg/starter@main` at runtime → always latest,
  but a template change that needs a CLI change is two coordinated repos.
- This model: templates ship IN the npm tarball (`files: [templates]`) → the
  template is **versioned with the CLI** (reproducible, offline), and one PR
  changes both. Cost: a template change requires publishing a new CLI version.

## Verdict

The create-vite shape is the right one *if we want variants* — it's proven and
it directly delivers issue #3. The real cost is the one-time restructure (move
starter → `templates/default/`, wire workspace exclusion, dotfile renames) and
the shift from "live-from-main" to "versioned templates". Worth an ADR before
committing to it.
