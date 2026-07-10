---
name: design-explore
description: Scaffold 2–3 design directions as prototype pages in Storybook (palette + typography + signature element) to compare on screen before choosing. The chosen direction is then formalised with the product-decision skill. This one WRITES files (throwaway prototypes) — confirm the brief and the number of directions with the user first.
---

# Explore design directions

Create 2–3 **prototype pages** in Storybook, one per visual direction, so that
palette, typography and the signature element are compared **on screen**
instead of in words (see the *Design tokens* decision in
[`docs/adr/`](../../../docs/adr/README.md) and, if available, the
`frontend-design` skill). They are **throwaway** prototypes for deciding: not
catalogue components, not final tokens.

> Prototypes may use raw inline values: here we are *choosing* the palette and
> the typography, so the "only `var(--token)`" discipline does not apply until
> the direction is formalised. They live under `Explorations/`, separate from
> the component catalogue and the `Product/` pages.

## Before writing — confirm

1. **Subject and job** of the page (if unclear, pin it down: what is the
   protagonist of the screen, what should a viewer feel/do).
2. **How many directions** (2 or 3) and, if the user has them in mind, the
   starting cues (one per line: dominant palette, display face, signature
   element). If they don't, propose 3 **distinct** directions yourself — avoid
   the three AI defaults (cream+serif, near-black+acid, broadsheet) unless the
   brief asks for them.
3. **Fonts stay bundleable**: no remote font CDNs in prototypes meant to
   become real — use the system stack (`fonts.css`) or note the
   `@fontsource/*` package to install (ADR-0006).

## Procedure

For each direction `<slug>` create
`apps/design-system/src/Explorations/<slug>.stories.tsx` with
`title: "Explorations/<Direction name>"` and `tags: ["autodocs"]`, and one
`Overview` story showing, in a single view:

- **Palette**: swatches of the 4–6 named colours (with hex and role labels:
  bg/surface/text/muted×N/accent/positive/negative), light **and** dark side
  by side.
- **Typography**: a specimen of the roles (display, body, numeric/mono) with
  the type scale, and tabular figures on a sample value if numbers matter.
- **Signature element**: the memorable moment of the direction, sketched (the
  one component or composition that makes this direction recognisable).
- A **note** (2–3 lines) stating the direction's thesis and its risk choice,
  so the review reads well.

Add/update an index page `Explorations/README.mdx` listing the directions with
a link and a one-line summary, for side-by-side comparison.

Keep each page **self-contained** (styles inline in the file), so directions
don't contaminate each other and are easy to delete after the choice.

## After

1. The user picks a direction on screen.
2. Formalise it with the **`product-decision`** skill (PDR + `Product/*.mdx`
   page).
3. Carry the chosen palette/typography into the **tokens**
   (`packages/ui-tokens/tokens.css` + `fonts.css`, with the
   `[data-theme="dark"]` scope) and update the Foundations; then build the
   components on those tokens. Remove the `Explorations/` that weren't chosen.

## Verify

After scaffolding, build Storybook
(`pnpm --filter @starter/design-system build`) and confirm the directions show
up under `Explorations/` and render correctly.
