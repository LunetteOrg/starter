# Design approach

- Status: guidance

> **Recommended, not enforced.** The template mechanically enforces *structural
> boundaries* (see [Architecture & boundaries](../adr/0002-architecture-and-boundaries.md)).
> Everything below is design vocabulary we recommend inside those boundaries — it
> is modelling discipline, not something a linter can check. Use it where it earns
> its keep; ignore it where it doesn't.

## The one rule above the rest: YAGNI / KISS

The boundaries are strict *because* they let the code inside stay simple. Do **not**
add abstraction for its own sake. The composition root already gives you dependency
injection, so you rarely need Factory/Builder/Singleton boilerplate. Reach for a
pattern when the pain is real, not in anticipation.

## Functional core, imperative shell

This is the same idea as hexagonal, said in FP terms: keep the **domain** a pure
functional core (data in → data out, no I/O), and push side effects to the
**shell** (use-cases orchestrate, adapters at the edges perform I/O). If a domain
function needs the network or the clock, that's a smell — inject a port.

## Errors as values (railway-oriented)

Prefer typed error *values* over thrown exceptions: a use-case returns
`Success | TypedError`, and callers handle the union exhaustively. This is a
functional-programming stance ("railway-oriented programming"). Here it is not just
recommended — the template **concretizes it into an enforced rule**: `throw` is
banned, `errore` typed errors are the contract (that promotion from guidance to
rule is exactly the pattern described in the monorepo's philosophy ADR).

## Tactical DDD — when the domain has real invariants

Reach for aggregates, entities, and value objects when the domain has genuine
invariants to protect (an Order that must stay internally consistent). Skip it for
CRUD — a typed row is fine. Value objects are cheap and high-value (a `Email` that
can't be constructed invalid); aggregates and domain events are heavier — earn them.
Strategic DDD (bounded contexts, a shared **ubiquitous language** in names) matters
as the app grows across teams; the single-context default is fine until it isn't.

## Gang-of-Four & SOLID — defaults, not dogma

SOLID as sensible defaults (small interfaces, depend on abstractions — the ports
already push you there). GoF patterns only when they solve the problem in front of
you; naming a class `AbstractStrategyFactory` before you have two strategies is the
over-engineering YAGNI warns about. Composition over inheritance, almost always.

## Clean Code — the boring parts that pay off

Intention-revealing names, small functions, no dead code, tests that read as specs.
None of this is novel; it's the baseline the enforced boundaries assume.
