# Architecture Decision Records

One file per subject, corrected in place, in [MADR](./template.md) format. How the log
is kept, and how it relates to the product decisions and the
[`../guidances/`](../guidances/README.md) recommendations, is in
[recording decisions](./recording-decisions.md).

| ADR | Subject | Status |
|---|---|---|
| [recording-decisions](./recording-decisions.md) | How decisions are recorded | accepted |
| [architecture-and-boundaries](./architecture-and-boundaries.md) | Layering, import boundaries, typed errors, serialization boundary | accepted |
| [build-and-tooling](./build-and-tooling.md) | Tech stack, monorepo tooling, module resolution | accepted |
| [testing](./testing.md) | Testing strategy, test database, component tests | accepted |
| [data-and-migrations](./data-and-migrations.md) | Data access and migration safety | accepted |
| [design-system](./design-system.md) | Design tokens, Storybook showcase, themes | accepted |
| [product-and-reference-spaces](./product-and-reference-spaces.md) | Product decisions and quarantined reference input | accepted |

## Recording a decision

1. **Find the subject.** If a file above covers it, rewrite the part that changed in
   that file. A new file, copied from [`template.md`](./template.md) and named after
   its subject, only for a new subject.
2. State what holds now; options not taken go in *Discarded directions*.
3. Add a new file to the table above.
