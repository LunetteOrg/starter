# ADR-0017: Dark theme via semantic-token scope

- Status: accepted
- Date: 2026-06-29

## Context

Design tokens live as CSS custom properties (ADR-0014) with a semantic layer
(`--color-bg`, `--color-fg`, `--color-border`, …) mapped onto raw neutrals.
Until now the tokens existed only under `:root`, i.e. a single light theme.
Adding a second theme later — once components already consume tokens — means
retrofitting a scope across every consumer, which is costly. Defining the scope
up front is structure, not a design commitment.

## Decision

Ship a `[data-theme="dark"]` scope in `tokens.css` that re-maps **only** the
semantic color tokens onto existing neutrals. The project stays light by
default; dark is opt-in by setting `data-theme="dark"` on a root element.
Nothing is forced — no automatic `prefers-color-scheme` switch, no mandated
toggle, no new raw values.

```css
[data-theme="dark"] {
  --color-bg: var(--color-neutral-900);
  --color-bg-muted: var(--color-neutral-700);
  --color-fg: var(--color-neutral-0);
  --color-fg-muted: var(--color-neutral-300);
  --color-border: var(--color-neutral-700);
}
```

Because components consume semantic names (never raw values), they theme
automatically.

Out of scope for this first pass: the `--shadow-*` tokens (hardcoded
`rgb(15 23 42 …)`, near-invisible on a dark surface) and the feedback colors
(`--color-success/-warning/-danger`) are **not** remapped. They should be
revisited when a component actually relies on them in dark mode.

## Consequences

- \+ Theming is available from day-0 without retrofitting consumers.
- \+ Light remains the default; adopting projects opt in deliberately.
- − The dark neutrals are a starter default the project should tune to its brand.
- − No `prefers-color-scheme` wiring is provided; the project decides how to
  toggle `data-theme`.
- − Shadows and feedback colors are not yet dark-aware (see above).
