# Component accessibility coverage

- Status: guidance

> **Recommended, not enforced.** The *decision* — every story runs in a real
> browser and an axe violation fails the build — lives in
> [ADR-0004 → Component tests](../adr/0004-testing.md#component-tests). This page
> is about the opposite: what that gate **does not** catch, so a green run isn't
> mistaken for "this component is accessible".

## What the gate actually covers

`pnpm test` renders every story in Chromium and runs axe on it. That catches the
static, markup-level failures — missing accessible names, bad roles, invalid ARIA,
insufficient contrast between the colours actually painted.

It runs on **one render**: the default state, in the **light** theme, with no
interaction. Everything outside that render is uncovered.

## The three gaps, and when to close them

### 1. The dark theme

The template ships a `[data-theme="dark"]` scope
([ADR-0006 → Dark theme](../adr/0006-design-system.md#dark-theme)) but **nothing
forces a project to adopt it**, and stories render light unless you say
otherwise. So axe checks light only.

**Close this if your app actually ships dark mode.** If it doesn't, this gap
costs you nothing — don't pay for coverage of a theme you don't have.

To close it, render stories under the dark scope as well. The cheapest version is
a Storybook global + decorator that sets `data-theme` on the story container, so
each story can be checked in both themes:

```tsx
// .storybook/preview.tsx — sketch, adapt to your setup
export const globalTypes = {
  theme: { toolbar: { items: ['light', 'dark'] } },
}

export const decorators = [
  (Story, context) => (
    <div data-theme={context.globals.theme}>
      <Story />
    </div>
  ),
]
```

Be deliberate about cost: checking both themes for every story roughly doubles
the component-test run. A common middle ground is a single dark story per
component that carries the risky surfaces, rather than a blanket doubling.

Note that the starter's dark neutrals are a **starting point, not a validated
palette**: ADR-0006 records the `--shadow-*` and feedback colours
(`--color-success/-warning/-danger`) as deliberately *not* remapped for dark. Turn
the dark check on and those will surface as real contrast failures — that is the
check working, and the signal to tune the palette to your brand.

### 2. Focus, hover and motion

Axe inspects markup, not interaction styling. It cannot tell you whether a
control has a visible focus ring, and it will pass a component whose focus
indicator doesn't exist.

The exemplar in `packages/ui/src/_example/` styles through an inline `style`
object, which **structurally cannot express** `:focus-visible`, `:hover`,
`:active` or `prefers-reduced-motion`. That is fine for a one-property exemplar
and wrong for a real component.

**Use a CSS Module** as soon as a component needs any state styling, and keep
consuming tokens (`var(--token)`) inside it:

```css
/* Button.module.css */
.button:focus-visible {
  outline: 2px solid var(--color-brand-700);
  outline-offset: 2px;
}
```

### 3. Interaction and the keyboard path

A component that is reachable, operable and announced by keyboard is not
something axe can verify — it only sees the DOM at rest.

**Assert it in a `play` function.** The exemplar demonstrates the shape: Tab to
the control, assert focus landed on it, activate with Enter, assert the handler
fired. Do the keyboard assertions *before* any mouse click, or the click will
have moved focus already and the reachability assertion proves nothing.

## The rule of thumb

Treat a green axe run as *"no obvious markup defect"*, never as *"accessible"*.
The gate exists to make regressions loud, not to certify the component. The three
gaps above are where human judgement still does the work.
