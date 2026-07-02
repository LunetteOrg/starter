---
name: story-check
description: Check that packages/ui components and their Storybook stories/Foundations stay aligned, and report divergences plus stories that should be added. Report-only — never edits files. Use when asked to verify Storybook coverage or find story drift, AND automatically as part of every code review and PR review (see CLAUDE.md).
---

# Storybook spec alignment

Produce a **report** on how well `packages/ui` components and their Storybook
coverage agree (see [ADR-0006 — Storybook showcase](../../../docs/adr/0006-design-system.md#storybook-showcase)). Do **not** scaffold
stories or edit files — output divergences and recommended actions only.

## Procedure

1. **Enumerate components.** List the components exported from
   `packages/ui/src/index.ts` and the component folders under
   `packages/ui/src/**`. Note the convention: one folder per component with
   `X.tsx` + `X.module.css` + `X.stories.tsx`.

2. **Map stories to components.** For each component find its co-located
   `*.stories.tsx`. Flag:
   - **Missing story** — an exported component with no `*.stories.tsx`.
   - **Orphan story** — a story whose component no longer exists or is no longer
     exported.

3. **Compare spec ↔ story.** For components that have a story, read the
   component's public props (the `Props`/`*Props` type or the function
   signature) and compare against the story's `argTypes` / `args` / rendered
   variants. Flag:
   - Props/variants the component supports but **no story exercises**.
   - Story `args`/`argTypes` referencing props the component **no longer has**.
   - Required props missing from the default story args.

4. **Check tokens & Foundations.** Cross-check design tokens:
   - `var(--token)` used in component `*.module.css` that is **not defined** in
     `@starter/ui-tokens/tokens.css`.
   - Token groups in `tokens.css` (the `@tokens <Group>` blocks) **not shown**
     in any Foundations page, or Foundations referencing a `categoryName` that no
     longer exists in `tokens.css`.

5. **Handle the empty case.** `packages/ui` ships empty in the starter. If there
   are no components yet, say so and report only the Foundations/token coverage
   (Welcome + Foundations against `tokens.css`) rather than inventing findings.

## Output format

```
# Storybook spec alignment

## Components without stories
- <Component> (path) — recommended: add <Component>.stories.tsx.

## Spec divergences
- <Component> — <prop/variant> supported but not in any story. Evidence: path:line.
- <Component> — story arg "<x>" references a removed prop. Evidence: path:line.

## Tokens & Foundations gaps
- var(--x) used in <file> not defined in tokens.css.
- Token group "<Group>" not shown in Foundations.
```

Lead with missing stories, then spec divergences, then token gaps. Be concrete
with `path:line`. End by stating it's aligned if there's nothing to report.
