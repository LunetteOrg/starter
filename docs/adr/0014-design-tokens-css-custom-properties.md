# ADR-0014: Design tokens as CSS custom properties

- Status: accepted
- Date: 2026-06-29

## Context

Components and apps need shared values (colours, spacing, radius, typography, shadows) with a single source of truth. Options range from build pipelines (style-dictionary, multi-format generation) to hand-written CSS custom properties. The starter favours the fewest build steps and zero tooling to maintain until it's genuinely needed.

## Decision

Design tokens live in the `@starter/ui-tokens` package as **plain CSS custom properties** in `tokens.css` — no pipeline, no build step, no intermediate format.

- Components reference tokens via `var(--token-name)` and **never duplicate** raw values.
- Apps and Storybook import `@starter/ui-tokens/tokens.css` (and `fonts.css`).
- The default fonts are the **system stack** (`fonts.css`); for self-hosted fonts, install `@fontsource/*` and redefine `--font-sans-stack` / `--font-mono-stack`.
- Token groups are annotated with `@tokens <Group>` / `@presenter <Type>` / `@tokens-end` comments, parsed by `storybook-design-token` to generate the Foundations pages (ADR-0015).

```css
/**
 * @tokens Colors
 * @presenter Color
 */
--color-brand-500: #3b82f6;
/* @tokens-end */
```

The versioned token set is **neutral**: a starting point to override with the derived project's brand, keeping the token names.

## Consequences

- \+ Zero build steps and zero dependencies for tokens; change a value and everything updates.
- \+ Tokens are browser-native (cascade, theming via `:root`, per-scope overrides).
- \+ The Foundations pages are generated from the annotations: no docs to keep in sync by hand.
- − No multi-platform generation (iOS/Android) nor TypeScript types on token names: if needed, a pipeline must be introduced and this ADR superseded.
- − The `@tokens` annotations must be maintained when adding tokens, otherwise they disappear from the Foundations.
