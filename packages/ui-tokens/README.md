# @starter/ui-tokens

Design tokens condivisi: colori, spacing, radius, tipografia, ombre.

Scaffold vuoto. Definisci i token in `tokens.css` come CSS custom properties su `:root` e importa il file dalle app.

```css
/* apps/<app>/app/root.css */
@import '@starter/ui-tokens/tokens.css';
@import '@starter/ui-tokens/fonts.css';
```

## Convenzioni

- Naming: `--color-*`, `--space-*`, `--radius-*`, `--font-*`, `--shadow-*`.
- I componenti in `@starter/ui` consumano i token via `var(--token-name)` — non duplicare i valori.
