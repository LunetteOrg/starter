# Guidances

Recommended patterns for the app you build **on** the starter. Everything here is
`status: guidance` — **the template ships none of it**. Each guidance opens with a
"not shipped" banner; adopt one when your app needs that concern, and record the
choice as an [ADR](../adr/README.md) in your project once you do.

| Guidance | Covers |
|---|---|
| [Auth](./auth.md) | Own your auth as a domain module (sessions, OTP, email) |
| [App infrastructure](./app-infrastructure.md) | Feature flags, secrets, jobs & cron, graceful shutdown |

See [ADR-0001](../adr/0001-recording-decisions.md) for how guidances relate to ADRs.
