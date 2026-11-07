---
name: product-check
description: Check that product decisions (docs/product/decisions/ PDRs) and their Storybook Product/ review pages stay aligned, and report drift plus decisions that lack a review surface. Report-only — never edits files. Use when asked to verify product-decision coverage or find product drift, AND automatically as part of every code review and PR review (see CLAUDE.md).
---

# Product-decision alignment

Produce a **report** on how well the PDR log and its Storybook review surface
agree (see [product & reference spaces](../../../docs/adr/product-and-reference-spaces.md) and
[the product-decisions guidance](../../../docs/guidances/product-decisions.md)). Do
**not** scaffold pages or edit files — output divergences and recommended actions
only. This is the product-side sibling of `adr-check` and `story-check`.

## Procedure

1. **Enumerate PDRs.** List `docs/product/decisions/*.md` (ignore `template.md`) —
   one file per product subject. Note each file, title, and `Status`.

2. **Map pages to PDRs.** For each `apps/design-system/src/Product/*.mdx` (ignore
   `Overview.mdx`), read its `?raw` import path. Flag:
   - **Missing page** — an `accepted` PDR with no `Product/*.mdx` that imports it.
   - **Broken import** — a page importing a `docs/product/decisions/*.md` that does
     not exist (renamed/deleted PDR).
   - **Orphan page** — a `Product/` page whose imported PDR is gone.
   - **Duplicated prose** — a page that pastes the decision text instead of
     rendering it with `<Markdown>{pdr}</Markdown>` (the markdown must stay the
     single source of truth).

3. **Check the sources.** A PDR cites `docs/` and `compliance/`, never `reference/`
   ([the rule on sources](../../../docs/adr/product-and-reference-spaces.md#the-rule-on-sources)).
   Flag:
   - **A PDR citing `reference/`** — a relative link or a path in its text, with its
     `path:line`; the fact it needs is to be written in the PDR, in words. A PDR in
     the cleanup list of `packages/test-utils/src/meta-pdr-sources.spec.ts` is
     reported too, as waiting to be cleaned.
   - Links from a PDR to `docs/` or `compliance/` material that **no longer exists**.
   - An external law cited **without its official link or the date** of the version
     the decision rests on.

4. **Check the review pages' material.** For each `Product/` page, resolve every
   `reference/…` path and prototype asset it embeds (the page, unlike the PDR, may
   embed from `reference/`). Flag:
   - Embeds of `reference/` material that **no longer exists**.
   - `<iframe>` still pointing at the dashed placeholder on an `accepted` decision
     (never wired to a real prototype).

5. **Check the records' shape.** Flag a PDR that carries amendment markers
   (`superseded by`, struck-through text, an "update" section) instead of stating
   what holds now, a dated or numbered file name, and two files on the same subject.

6. **Report.** For each finding: `path:line`, one-line explanation, and the
   recommended action (scaffold a page via `product-decision`, fix an import, wire
   the prototype, write the cited fact into the PDR, rewrite the PDR in
   place). If everything aligns, say so.

## Notes

- Report-only. Recommend `product-decision` for anything that needs a file written.
- `reference/` and `compliance/` are quarantined input — check that they are *cited*
  correctly, never that they lint or build (they are excluded from the toolchain by
  design).
