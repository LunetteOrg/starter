---
name: product-check
description: Check that product decisions (docs/product/decisions/ PDRs) and their Storybook Product/ review pages stay aligned, and report drift plus decisions that lack a review surface. Report-only — never edits files. Use when asked to verify product-decision coverage or find product drift, AND automatically as part of every code review and PR review (see CLAUDE.md).
---

# Product-decision alignment

Produce a **report** on how well the PDR log and its Storybook review surface
agree (see [ADR-0007](../../../docs/adr/0007-product-and-reference-spaces.md) and
[the product-decisions guidance](../../../docs/guidances/product-decisions.md)). Do
**not** scaffold pages or edit files — output divergences and recommended actions
only. This is the product-side sibling of `adr-check` and `story-check`.

## Procedure

1. **Enumerate PDRs.** List `docs/product/decisions/*.md` (ignore `template.md`) —
   each is a dated `YYYY-MM-DD-*.md` record. Note each id, title, and `Status`.

2. **Map pages to PDRs.** For each `apps/design-system/src/Product/*.mdx` (ignore
   `Overview.mdx`), read its `?raw` import path. Flag:
   - **Missing page** — an `accepted` PDR with no `Product/*.mdx` that imports it.
   - **Broken import** — a page importing a `docs/product/decisions/*.md` that does
     not exist (renamed/deleted PDR).
   - **Orphan page** — a `Product/` page whose imported PDR is gone.
   - **Duplicated prose** — a page that pastes the decision text instead of
     rendering it with `<Markdown>{pdr}</Markdown>` (the markdown must stay the
     single source of truth).

3. **Check reference links.** For each PDR and its page, resolve every
   `reference/…` path and prototype asset referenced. Flag:
   - Links to `reference/` material that **no longer exists**.
   - `<iframe>` still pointing at the dashed placeholder on an `accepted` decision
     (never wired to a real prototype).

4. **Check immutability & status.** Flag any PDR whose `## Decision` appears to
   have been rewritten in meaning rather than superseded (compare against git
   history where available). Flag `superseded by YYYY-MM-DD-…` pointing at a
   missing PDR.

5. **Report.** For each finding: `path:line`, one-line explanation, and the
   recommended action (scaffold a page via `product-decision`, fix an import, wire
   the prototype, write a superseding PDR). If everything aligns, say so.

## Notes

- Report-only. Recommend `product-decision` for anything that needs a file written.
- The `reference/` tree is quarantined input — check that it is *linked* correctly,
  never that it lints or builds (it is excluded from the toolchain by design).
