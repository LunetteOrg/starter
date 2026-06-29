# ADR-0014: Design tokens as CSS custom properties

- Status: accepted
- Date: 2026-06-29

## Context

Componenti e app hanno bisogno di valori condivisi (colori, spacing, radius, tipografia, ombre) con un'unica fonte di verità. Le opzioni vanno da pipeline di build (style-dictionary, generazione multi-formato) a CSS custom properties scritte a mano. Lo starter privilegia il minor numero di build step e zero tooling da mantenere finché non serve davvero.

## Decision

I design token vivono nel package `@starter/ui-tokens` come **CSS custom properties pure** in `tokens.css` — nessuna pipeline, nessun build step, nessun formato intermedio.

- I componenti referenziano i token via `var(--token-name)` e **non duplicano mai** valori grezzi.
- App e Storybook importano `@starter/ui-tokens/tokens.css` (e `fonts.css`).
- I font default sono lo **stack di sistema** (`fonts.css`); per font self-hosted si installa `@fontsource/*` e si ridefiniscono `--font-sans-stack` / `--font-mono-stack`.
- I gruppi di token sono annotati con commenti `@tokens <Gruppo>` / `@presenter <Tipo>` / `@tokens-end`, parsati da `storybook-design-token` per generare le pagine Foundations (ADR-0015).

```css
/**
 * @tokens Colors
 * @presenter Color
 */
--color-brand-500: #3b82f6;
/* @tokens-end */
```

Il set di token versionato è **neutro**: è un punto di partenza da sovrascrivere col brand del progetto derivato, mantenendo i nomi dei token.

## Consequences

- \+ Zero build step e zero dipendenze per i token; modifica un valore e tutto si aggiorna.
- \+ I token sono nativi del browser (cascade, theming via `:root`, override per scope).
- \+ Le pagine Foundations si generano dalle annotazioni: nessuna doc da tenere allineata a mano.
- − Niente generazione multi-piattaforma (iOS/Android) né tipi TypeScript sui nomi dei token: se servono, andrà introdotta una pipeline e questo ADR superato.
- − Le annotazioni `@tokens` vanno mantenute quando si aggiungono token, altrimenti spariscono dalle Foundations.
