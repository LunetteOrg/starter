---
status: accepted
date: 2026-07-23
deciders: []
tags: [scaffolding, templates, adr, process, claude-md]
---

# ADR-0008: Drop the `.lunette-template` marker — state the rule instead of inferring it

## Context

Template content and a project scaffolded from it are near-identical trees, but
their ADR logs follow opposite rules: in the template ADRs are consolidated and
renumbered freely while it is being drafted; in a derived project they are
append-only and immutable in meaning.

Nothing in the content itself distinguishes the two, so
[ADR-0004](./0004-scaffolding-contract.md#decision) made presence
of a `.lunette-template` file at the template root the discriminator, and the CLI
stripped it on scaffold: present → template, absent → derived project.

Two things have since become clear.

**The signal downstream is the absence of a file.** To read it you must already
know the file exists and that you were supposed to look for it — knowledge that
only reaches a derived project through the same `CLAUDE.md` that could simply
state the rule outright. An absent file is a weaker carrier than a present
sentence.

**The marker is redundant upstream.** Inside this monorepo the path already says
which log you are in: `packages/create/templates/*/docs/adr/` is a template's log,
`docs/adr/` at the root is this system's. Both `CLAUDE.md` files are in scope when
working here, so the rule can be stated in each, at the level it applies to.

## Decision

Remove the `.lunette-template` marker. It is no longer part of the scaffolding
contract, the CLI no longer strips it, and no file's presence encodes ADR
mutability. This supersedes the marker clause of
[ADR-0004](./0004-scaffolding-contract.md#decision); the rest of
that contract is unaffected.

The rule is stated positively, in the file each audience actually reads:

- **The template's `CLAUDE.md`** (ships into every generated project) says its
  ADRs are append-only: change a decision by writing a new dated ADR that
  supersedes the old one.
- **This repo's `CLAUDE.md`** (never ships) says the root `docs/adr/` is
  append-only, that everything under `packages/create/templates/` is template
  content still being drafted and may be consolidated freely, and — explicitly —
  that the append-only sentence in a template's own `CLAUDE.md` addresses derived
  projects, not work done here.

That last clause is load-bearing. Both `CLAUDE.md` files are in scope inside this
monorepo, so without it the more specific one (the template's) would be read as
authoritative and give exactly the wrong answer.

## Alternatives considered

### A — Keep the marker

Status quo. Its one genuine advantage is that it travels *with the content*: a
template folder copied out of this monorepo still declares what it is, whereas a
`CLAUDE.md` copied along with it would claim append-only. Rejected because that
scenario is not a real workflow, and its failure mode is conservative — you would
write one dated ADR too many, not destroy history — while the marker costs a file,
a CLI step, two test assertions and a contract clause on every path that *is*
real.

### B — Replace the marker with a path rule alone

"Under `packages/create/templates/` → mutable" is true here, but keys on where the
checkout sits rather than on what the content is, and `templates` is a generic
directory name — `packages/test-utils/templates/` already exists *inside* every
generated project. Tightening it to the full path couples the rule to this
monorepo's layout, so moving `packages/create/` would break it silently. Kept as
the informal cue it already is, not as the recorded rule.

## Consequences

### Positive

- One fewer file, CLI step, contract clause and pair of test assertions.
- The rule is affirmed where it is read, instead of inferred from an absence.
- A derived project learns its ADR discipline from a sentence in `CLAUDE.md`, with
  nothing to know in advance.

### Negative / accepted risks

- Template content detached from this monorepo (copied elsewhere) carries a
  `CLAUDE.md` that claims append-only, which is wrong for template content.
  Accepted: not a real workflow, and the error is conservative.
- Correctness now rests on prose precedence between two `CLAUDE.md` files rather
  than on a file's existence. Mitigated by stating the precedence explicitly, but
  it is softer than a binary signal — if that sentence is ever dropped or
  reworded loosely, the ambiguity returns silently.

### When to deviate (revisit triggers)

- A contributor (or agent) consolidates a template's ADRs while believing they are
  in a derived project, or writes dated superseding ADRs inside the template —
  either means the prose precedence is not carrying, and a machine-readable
  discriminator should come back.
- A template is stored outside `packages/create/templates/`, so the path rule in
  the root `CLAUDE.md` no longer names every template correctly.
