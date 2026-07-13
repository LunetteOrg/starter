# Product decisions

The **granular log of product & design decisions** — one file per call, each an
atomic, dated record (`YYYY-MM-DD-title.md`). It sits next to the
[ADRs](../adr/README.md) but is split by *subject matter*, not by structure:
architecture there, product/design here. The ADR log ships a small thematic
*seed* to start aligned and then grows as dated files; the PDR log has no seed —
product choices are all your project's content — so it is dated files from the
first one.

| Space | Holds | Nature |
|---|---|---|
| [`../adr/`](../adr/README.md) | architectural decisions | thematic seed + atomic dated evolution |
| **`decisions/`** | product/design decisions (PDR) | atomic dated log, the source of truth |
| [`../../reference/`](../../reference/README.md) | raw input (legacy, dumps, prototypes) | read-only history, quarantined |

## Writing a PDR

1. Copy [`decisions/template.md`](./decisions/template.md) to
   `decisions/YYYY-MM-DD-short-kebab-title.md` (today's date — no shared counter to
   contend, so concurrent PRs don't collide). Or let the `product-decision` skill
   scaffold it.
2. Keep it short: Context, Decision, Rationale, Consequences. Link the
   `reference/` material it draws on.
3. Once a project is scaffolded, PDRs are **append-only** — don't rewrite an
   accepted decision to mean something else; write a new one and mark the old
   `superseded by YYYY-MM-DD-…`. (Same rule as ADRs.)

## Reviewing a PDR (with non-technical stakeholders)

The `.md` is the source of truth; **Storybook is the review surface**. Each PDR
gets a page under `Product/` in the design system that renders the markdown and
puts the interactive prototype and the "before" next to the rationale — one
screen, no markdown reading required. Stakeholders review and comment there. See
[the product-decisions guidance](../guidances/product-decisions.md) for how to
wire the review (Chromatic by default).

> The *shape* — a PDR log rendered for review — ships ready to use; the decisions
> themselves are your project's content.
