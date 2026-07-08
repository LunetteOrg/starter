---
name: product-decision
description: Scaffold a product/design decision (PDR) and its Storybook review page together — a markdown record in docs/product/decisions/ plus a Product/*.mdx page that renders it and embeds the prototype. Use when asked to record a product or design decision, add a PDR, or prepare a decision for stakeholder review. This one WRITES files (unlike the report-only checks); confirm the title and content with the user first.
---

# Scaffold a product decision

Create a **PDR** (product decision record) and the **Storybook page** that renders
it for review, keeping the markdown as the single source of truth (see
[ADR-0007](../../../docs/adr/0007-product-and-reference-spaces.md) and
[the product-decisions guidance](../../../docs/guidances/product-decisions.md)).

## Procedure

1. **Confirm intent.** Get the decision title and the gist (context, the choice,
   why). If the user is only exploring, stop — a PDR records a *made* decision.

2. **Pick the number.** List `docs/product/decisions/NNNN-*.md`, take the next free
   `NNNN` (zero-padded to 4). Never reuse or renumber existing ones (append-only
   once scaffolded — check the `.lunette-template` marker: if absent you are in a
   derived project and immutability applies).

3. **Write the PDR.** Copy `docs/product/decisions/template.md` to
   `docs/product/decisions/NNNN-short-kebab-title.md` and fill Status/Date/
   Reviewers, Context, Decision, Rationale, Consequences. Use today's date. Keep it
   short and in active voice. Link any `reference/` material it draws on by relative
   path.

4. **Write the Storybook page.** Copy the shape of
   `apps/design-system/src/Product/Example.mdx` to
   `apps/design-system/src/Product/<TitleInPascalOrKebab>.mdx`:
   - `import pdr from '../../../../docs/product/decisions/NNNN-….md?raw'`
   - `<Meta title="Product/<Human Title>" />` — one page per decision under the
     `Product/` hierarchy.
   - `<Markdown>{pdr}</Markdown>` to render the record (do **not** duplicate the
     prose into the MDX — render it).
   - Add the prototype `iframe` (ask the user for the URL, or leave the dashed
     placeholder) and, where useful, screenshots from `reference/` and real
     component stories.

5. **Update the index.** Add the decision to any list/timeline the project keeps in
   `docs/product/README.md` if it maintains one. Do not invent a project-specific
   narrative that isn't there.

6. **Report.** Tell the user the two files created and how to review: build the
   Storybook (`pnpm --filter <design-system> dev`) and open `Product/<title>`; for
   stakeholder comments, the guidance's Chromatic path.

## Guardrails

- The markdown is the source of truth; the MDX **renders** it. Never let the two
  diverge — if you must add narration, add it in the MDX around the `<Markdown>`
  block, not by copying the record.
- Stay generic only in the *template itself* (marker present). In a real project,
  write the actual decision.
