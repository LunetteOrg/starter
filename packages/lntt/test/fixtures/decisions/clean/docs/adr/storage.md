---
status: accepted
date: 2026-10-01
tags: [storage]
---

# Storage

## Decision

Data lives in Postgres. How the API answers is [api-shape](./api-shape.md#decision),
and how it is reviewed is [review](../process/review.md).

A record never carries `Superseded by`; the rule is quoted, not applied:

```md
Superseded by another-subject.md
```

## Consequences

About 45% of the requests read one row.
