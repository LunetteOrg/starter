# Product decisions

The **log of product & design decisions** (PDRs): one file per product subject,
corrected in place, the same rules as the [ADRs](../adr/README.md)
([recording decisions](../adr/recording-decisions.md)). The two logs are split by
*subject matter*: architecture there, product and design here.

| Space | Holds | Nature |
|---|---|---|
| [`../adr/`](../adr/README.md) | architectural decisions | one file per subject, corrected in place |
| **`decisions/`** | product/design decisions (PDR) | one file per product subject, corrected in place; the source of truth |
| [`../../reference/`](../../reference/README.md) | raw input (legacy, dumps, prototypes) | read-only history, quarantined |

## Recording a product decision

1. **Find the subject** (`onboarding.md`, `pricing.md`, …). If a file covers it,
   rewrite the part that changed there. A new file, copied from
   [`decisions/template.md`](./decisions/template.md) and named after its subject,
   only for a new subject. The `product-decision` skill does both.
2. Keep it short: Context, Decision, Consequences, and the options not taken in
   *Discarded directions*. Link the `reference/` material it draws on.
3. Show it to the reviewers on its Storybook page before it is accepted.

## Reviewing a PDR (with non-technical stakeholders)

The `.md` is the source of truth; **Storybook is the review surface**. Each PDR file
gets a page under `Product/` in the design system that renders the markdown and puts
the interactive prototype and the "before" next to the rationale: one screen, no
markdown reading required. Stakeholders review and comment there. See
[the product-decisions guidance](../guidances/product-decisions.md) for how to wire
the review (Chromatic by default).

> The *shape* (a PDR log rendered for review) ships ready to use; the decisions
> themselves are your project's content.
