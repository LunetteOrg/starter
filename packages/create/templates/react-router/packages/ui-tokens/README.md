# @starter/ui-tokens

Shared design tokens: colours, spacing, radius, typography, shadows.

Empty scaffold. Define the tokens in `tokens.css` as CSS custom properties on `:root` and import the file from the apps.

```css
/* apps/<app>/app/root.css */
@import '@starter/ui-tokens/tokens.css';
@import '@starter/ui-tokens/fonts.css';
```

## Conventions

- Naming: `--color-*`, `--space-*`, `--radius-*`, `--font-*`, `--shadow-*`.
- Components in `@starter/ui` consume the tokens via `var(--token-name)` — don't duplicate the values.
