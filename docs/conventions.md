# Project Conventions

Operational conventions for the starter template. This is the source of truth — `CLAUDE.md` references this file.

## Branch Naming

```
story/<epic>.<story>-<short-description>
```

**Examples:**
- `story/0.1-turbo-scaffold`
- `story/4.2-otp-flow`

## Commit Messages

Conventional commits enforced via commitlint + Lefthook.

```
feat: add session management
fix: handle expired OTP gracefully
chore: update dependencies
```

## Story Types

| Type | Merge Strategy | UAT |
|---|---|---|
| Tech Story | Merge freely to main — no user surface | None |
| User Story | Merge behind feature flag | Flag on staging → PO sign off → flag on prod |

## Workflow

- Trunk-based development — all branches max 1-2 days
- One PR per story
- PRs target `main`
