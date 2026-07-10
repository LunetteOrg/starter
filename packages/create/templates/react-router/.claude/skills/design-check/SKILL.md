---
name: design-check
description: Audit the design/UX discipline — tokens vs raw values, light+dark theming, AA contrast, focus/keyboard, motion, tooltips — and report violations with path:line. Report-only, never edits files. Use when asked to verify design-system adherence, visual/UX quality or accessibility, AND automatically as part of every code review and PR review (see CLAUDE.md).
---

# Design & UX check

Produce a **report** on how well the UI and its styles respect the project's
design discipline: tokens as the single source of truth, light+dark theming,
accessibility and consistency (see the *Design tokens* and *Dark theme*
decisions in [`docs/adr/`](../../../docs/adr/README.md), anchored
`#design-tokens` / `#dark-theme`). Do **not** edit files — output violations
and recommended actions only, ordered by severity.

The natural scope is `packages/ui/**` (the CSS Modules catalogue) and
`packages/ui-tokens/**`. App views under `apps/**` are in scope only if the
request includes them.

## What to check

### 1. Token discipline

- **Raw values where a token exists**: in `*.module.css` files and inline
  `style=` props, look for colours (`#hex`, `rgb(`, `hsl(`, names like
  `red`/`white`/`black`) and `px` for spacing/radius/font sizes that should use
  `var(--spacing-*/--radius-*/--font-size-*)`. Allowed: `color-mix()` of
  tokens only, `currentColor`, `0`, `1px` borders, percentages, and values
  with no matching token (flag those as "missing token" instead).
- **Undefined tokens**: `var(--x)` used but absent from
  `packages/ui-tokens/tokens.css` and `fonts.css` (exclude local custom
  properties defined in the same file).
- **Utility classes in the catalogue**: any utility-CSS class (e.g. Tailwind)
  inside `packages/ui` is a violation — the catalogue is pure CSS Modules.

### 2. Theming (light + dark)

- The `[data-theme="dark"]` scope in `tokens.css` must remap **only** the
  semantic tokens (`--color-bg*`, `--color-fg*`, `--color-border`, …).
  Semantic tokens must never be redefined inside components (consumed only).
- Components must consume **semantic** names, not raw neutrals — a component
  hardcoded on `--color-neutral-*` won't theme.
- Known limitation (recorded in the ADR): `--shadow-*` and the feedback
  colours are not yet dark-remapped — mention it only if a component actually
  relies on them in dark.

### 3. Accessibility

- **AA contrast** (≥ 4.5:1 normal text, ≥ 3:1 large text/UI) of the
  text/surface and on-colour/background pairs, **in both themes**. Compute it
  from the real token values (read the hex values in `tokens.css`); report the
  pairs below threshold.
- **Visible focus**: every interactive element has `:focus-visible` with a
  token-based outline; no `outline: none` without a replacement.
- **Keyboard**: clickable non-native elements have proper keyboard handling
  and roles; prefer native elements.
- **Native tooltips**: `title=` used as an informative tooltip → recommend an
  accessible `Tooltip` component.
- Labels associated with controls; correct `aria-*` on dialogs/tabs/toggles.

### 4. Interaction & motion

- Do `transition`/`animation` rules respect `prefers-reduced-motion: reduce`?
- Hover/active states present and consistent across sibling components (no
  drift).

### 5. Consistency & hierarchy

- Spacing/radius/typography scales used consistently across components that
  play the same role.
- Muted-text hierarchy: flag places where levels of emphasis collapse into a
  single muted colour and the hierarchy is lost.

## Procedure

1. Read `packages/ui-tokens/tokens.css` and `fonts.css`: build the list of
   defined tokens and their values (needed for contrast and for the
   "raw vs token" check).
2. Scan the `*.module.css` files and inline `style=` props in scope: apply
   checks 1–5.
3. For contrast, run the bundled validator — it parses `tokens.css`, resolves
   `var()` chains per theme and prints PASS/FAIL for every fg×bg pair in light
   and dark (exit 1 on failures):

   ```sh
   node .claude/skills/design-check/scripts/contrast.mjs
   ```

   For pairs it can't resolve (e.g. `color-mix()`) or component-local colours,
   fall back to computing the WCAG ratio inline.
4. **Handle the empty case.** `packages/ui` ships empty in the starter. If
   there are no components yet, say so and audit only the token set itself
   (contrast of the semantic pairs in both themes, dark-scope completeness).
5. Aggregate and order by severity (a11y blockers > token drift > consistency).

## Output format

```
# Design & UX check

## Token discipline
- <file:line> — raw value <value> where <--token> exists.

## Theming
- <semantic token redefined in <file> | component on raw neutrals: <file:line>>.

## Accessibility
- Contrast <pair> = <ratio>:1 (< AA) in <light|dark> theme. Evidence: tokens.css.
- <file:line> — <title= used as tooltip | focus not visible | …>.

## Interaction & consistency
- <file:line> — <hover/motion/hierarchy drift>.
```

Lead with accessibility blockers, then token drift, then consistency. Be
concrete with `path:line`. End by stating it's aligned if there's nothing to
report.

> A **runtime** audit (axe-core, real states, viewports) needs the app or
> Storybook running — Storybook already ships `@storybook/addon-a11y` for
> that. This check is static and complements it.
