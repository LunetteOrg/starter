# Product decisions

The **granular log of product & design decisions** — one file per call. This is
deliberately what the [ADRs](../adr/README.md) are *not*: ADRs are a small,
thematic *foundation to start aligned*, not a per-decision log
([ADR-0001](../adr/0001-recording-decisions.md) — "a small, coherent set … not a
long list of granular records"). Product choices are many and frequent, so they
get their own space.

| Space | Holds | Nature |
|---|---|---|
| [`../adr/`](../adr/README.md) | architectural decisions | few, thematic, immutable once scaffolded |
| **`decisions/`** | product/design decisions (PDR) | many, granular, the source of truth |
| [`../../reference/`](../../reference/README.md) | raw input (legacy, dumps, prototypes) | read-only history, quarantined |

## Writing a PDR

1. Copy [`decisions/template.md`](./decisions/template.md) to
   `decisions/NNNN-short-kebab-title.md` (next free number). Or let the
   `product-decision` skill scaffold it.
2. Keep it short: Context, Decision, Rationale, Consequences. Link the
   `reference/` material it draws on.
3. Once a project is scaffolded, PDRs are **append-only** — don't rewrite an
   accepted decision to mean something else; write a new one and mark the old
   `superseded by PDR-NNNN`. (Same rule as ADRs.)

## Reviewing a PDR (with non-technical stakeholders)

The `.md` is the source of truth; **Storybook is the review surface**. Each PDR
gets a page under `Product/` in the design system that renders the markdown and
puts the interactive prototype and the "before" next to the rationale — one
screen, no markdown reading required. Stakeholders review and comment there. See
[the product-decisions guidance](../guidances/product-decisions.md) for how to
wire the review (Chromatic by default).

> The *shape* — a PDR log rendered for review — ships ready to use; the decisions
> themselves are your project's content.
