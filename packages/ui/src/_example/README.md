# `_example/` — component reference

Canonical shape of a shared UI component and its story, kept as inert
`.template` files (not compiled, linted, or aggregated by Storybook) so the
template ships an exemplar without shipping a live component the consuming
project must delete.

To add your first real component:

1. Copy `Button.tsx.template` → `../<Component>/<Component>.tsx` (drop `.template`).
2. Copy `Button.stories.tsx.template` likewise.
3. Re-export the component from `packages/ui/src/index.ts`.

What the exemplar demonstrates (ADR-0014, ADR-0015):

- styling only through design tokens (`var(--token)`), never raw values;
- typed, documented props (feeds Storybook autodocs);
- a co-located story, with the a11y addon kept green.
