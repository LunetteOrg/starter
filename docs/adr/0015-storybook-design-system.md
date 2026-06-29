# ADR-0015: Storybook as the showcase for `packages/ui`

- Status: accepted
- Date: 2026-06-29

## Context

I componenti condivisi vivono in `packages/ui` e i token in `packages/ui-tokens` (ADR-0014). Serve un posto per svilupparli in isolamento, documentarli e verificarne l'accessibilità, senza accoppiare questa vetrina a un'app di dominio (lo starter è un template: le app restano generiche).

## Decision

Storybook vive in `apps/design-system` come **app di tooling generica**, su `@storybook/react-vite` (Storybook 10, Vite).

- Le **storie sono co-locate** in `packages/ui` (`packages/ui/src/**/*.stories.tsx`); l'app design-system le aggrega via glob — aggiungere un componente con la sua story lo fa comparire senza altra configurazione.
- Le **Foundations** (token) sono generate da `storybook-design-token` leggendo le annotazioni `@tokens` di `@starter/ui-tokens` (ADR-0014); i valori non sono duplicati nelle docs.
- **A11y**: `@storybook/addon-a11y` con `a11y.test: 'todo'` — le violazioni axe sono segnalate ma non bloccanti; si passa a `'error'` per renderle bloccanti.
- `reactDocgen: 'react-docgen-typescript'` documenta automaticamente le props dei componenti.
- `pnpm --filter @starter/design-system build` produce la Storybook statica in `build/` (cache Turbo, gira nella pipeline `build`).

```ts
// apps/design-system/.storybook/main.ts
stories: [
  '../src/**/*.mdx',
  '../../../packages/ui/src/**/*.stories.@(ts|tsx)',
]
```

## Consequences

- \+ I componenti si sviluppano in isolamento; le storie stanno accanto al codice che documentano.
- \+ La build di Storybook gira in CI: una story rotta o un import mancante fa fallire il build.
- \+ La vetrina è disaccoppiata dalle app di dominio: resta valida in ogni progetto derivato dallo starter.
- − Una dipendenza pesante in più (Storybook + Vite) nel monorepo, solo per il dev/docs.
- − La convenzione "story accanto al componente in `packages/ui`" va rispettata, altrimenti le storie non vengono aggregate.
