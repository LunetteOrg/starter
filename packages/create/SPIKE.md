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

## Real de-risk (not just the toy)

The `templates/{default,minimal}` folders in THIS package are small stand-ins to
keep the diff readable. But the real question — *does a full monorepo survive as a
template folder?* — was tested separately by building the actual tooling monorepo
and copying the **whole current starter** into `templates/default/`. Results:

- **Outer workspace exclusion holds at scale.** With `packages: ["packages/*"]`,
  the outer `pnpm install` sees only `@lntt/create` — the template's 7 inner
  packages + the design-system app are NOT members (they're `packages/create/templates/default/**`, too deep for the glob). No collision.
- **Scaffold produces a complete, correct starter**: all 7 packages, `apps/design-system`, the 6 consolidated ADRs, `.lunette-template` removed, `@starter/*` → `@<name>/*`, `"name": "starter"` → the project name, branch `main`.
- **The generated project actually works**: `pnpm install` clean, workspace
  members correctly `@<name>/*`, `pnpm turbo typecheck` → 4/4 green.
- **One gap found**: `.editorconfig` is not in the rename's text-file set, so a
  comment `@starter/biome-config` survives. One-line fix (add the extension) —
  same class of coverage gap we've hit before.

Conclusion: the model works end-to-end with the real monorepo. The nested-monorepo
fear (workspace pickup) is a non-issue given `packages/*` doesn't recurse.

## How it maps to reality

- `templates/default/` here is a **stand-in**. In the real thing it holds the
  entire current starter tree (packages/, apps/, turbo.json, docs/adr, …), exactly
  as de-risked above.
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
