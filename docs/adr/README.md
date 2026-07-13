# Architecture Decision Records — the Lunette starter

Decisions about the **templates system** — `@lntt/create` and how templates are
defined, organized, and scaffolded. A single template's *own* application
architecture is recorded inside that template (e.g.
`packages/create/templates/react-router/docs/adr/`), not here. See
[ADR-0001](./0001-recording-decisions.md) for the scope split.

| ADR | Title | Status |
|---|---|---|
| [0001](./0001-recording-decisions.md) | Recording decisions | accepted |
| [0002](./0002-what-is-a-lunette-template.md) | What a Lunette template is | accepted |
| [0003](./0003-create-vite-monorepo-model.md) | Templates as bundled folders (the create-vite model) | accepted |
| [0004](./0004-scaffolding-contract.md) | The scaffolding contract | accepted |
| [0005](./0005-publish-compiled-cli.md) | Ship the CLI as compiled JavaScript | accepted |
| [0006](./0006-decision-logs-in-generated-projects.md) | Decision logs in generated projects (thematic seed, atomic dated evolution) | accepted |
| [0007](./0007-explicit-ts-import-extensions.md) | Explicit `.ts` import extensions for Node-executed code | accepted |

New ADR: copy [`template.md`](./template.md) (MADR: frontmatter with
`status`/`date`/`deciders`/`tags`, then Context / Decision / Alternatives
considered / Consequences with revisit triggers) to `NNNN-short-kebab-title.md`,
keep it short, add a row above.
