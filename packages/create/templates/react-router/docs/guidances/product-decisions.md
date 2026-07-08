# Product decisions — writing & reviewing

> **Recommended, not enforced.** The template ships the *shape* — a granular PDR
> log ([`docs/product/`](../product/README.md)) rendered for review in Storybook's
> `Product/` section, and a quarantined [`reference/`](../../reference/README.md)
> for the raw material. How you run the review is up to you; this is the path we
> recommend. See [ADR-0007](../adr/0007-product-and-reference-spaces.md) for why
> these spaces exist.

## The mechanism

- **Source of truth:** one markdown PDR per decision in `docs/product/decisions/`.
  Greppable, versioned, append-only once scaffolded.
- **Review surface:** one Storybook page per PDR under `Product/`. It imports the
  markdown `?raw` and renders it with the `Markdown` block, then embeds the
  interactive prototype and the "before" from `reference/`. **No duplication** —
  the `.md` is rendered, not copied.
- **One space, whole evolution:** legacy (in `reference/`) → explored prototype
  (embedded) → the decision (the PDR) sit on one screen for a stakeholder who
  never opens the repo.

Use the [`product-decision`](../../.claude/skills/product-decision/) skill to
scaffold a PDR + its page, and [`product-check`](../../.claude/skills/product-check/)
to catch drift (a PDR with no page, a page importing a missing file, an `iframe`
pointing at absent `reference/` material).

## Reviewing with non-technical stakeholders

The point of rendering in Storybook is that stakeholders review *choices* without
touching markdown or the repo. Enable comments with the least friction they'll
tolerate:

### Default — Chromatic (free tier)

[Chromatic](https://www.chromatic.com/) (by the Storybook team) hosts the built
Storybook and provides **native review + commenting** on any story or page:
reviewers open a link, comment on the decision page, and sign off. Set-up lives in
*your* project, not the template — publish on CI and share the library link:

```jsonc
// package.json — add to the design-system app
"scripts": { "chromatic": "chromatic --project-token=$CHROMATIC_PROJECT_TOKEN" }
```

```sh
pnpm add -D chromatic --filter @<project>/design-system
```

Add a CI step (or a manual `pnpm --filter @<project>/design-system chromatic`) and
put `CHROMATIC_PROJECT_TOKEN` in the repo secrets. Commenting happens in
Chromatic's UI — nothing to embed in the page. The free tier is usually enough to
start; move on if you outgrow the snapshot budget.

### Evolution — anonymous in-page comments

If stakeholders balk at *any* login, drop a lightweight comment widget straight
into the decision pages so they leave a name + comment, no account:

- **[Cusdis](https://cusdis.com/)** — tiny, SaaS free tier or self-hosted.
- **[Isso](https://isso-comments.de/)** / **[Remark42](https://remark42.com/)** —
  self-hosted, anonymous allowed.

Embed the widget's snippet in a shared MDX component and render it at the bottom of
each `Product/*` page. This trades Chromatic's review *workflow* (assignees,
approval) for the lowest possible friction.

> For non-technical stakeholders a GitHub account (Discussions, PR comments) is
> already too much friction — hence Chromatic first, anonymous widget as the
> fallback.
