# Architecture Decision Records — the Lunette starter

Decisions about the **templates system** — `@lntt/create` and how templates are
defined, organized, and scaffolded. A single template's *own* application
architecture is recorded inside that template (e.g.
`packages/create/templates/react-router/docs/adr/`), not here. How this log is
kept is in [recording decisions](./recording-decisions.md).

| ADR | Subject | Status |
|---|---|---|
| [recording-decisions](./recording-decisions.md) | How this repo records its decisions, and the scope split with template logs | accepted |
| [template-model](./template-model.md) | What a Lunette template is; templates as folders bundled inside the CLI | accepted |
| [scaffolding-contract](./scaffolding-contract.md) | Placeholders, dotfiles and text-file coverage every template honours | accepted |
| [cli-runtime-and-publishing](./cli-runtime-and-publishing.md) | The CLI runs as TypeScript in-repo, ships compiled; explicit `.ts` imports | accepted |
| [decision-logs-in-generated-projects](./decision-logs-in-generated-projects.md) | The decision logs templates ship to generated projects | accepted |

A new subject gets its own file: copy [`template.md`](./template.md) to
`<subject>.md` and add a row above. A changed decision is rewritten in its file.
