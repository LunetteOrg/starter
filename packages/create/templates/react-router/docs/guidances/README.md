# Guidances

Recommendations for the app you build **on** the starter — all `status: guidance`,
none of it mechanically enforced. Two kinds, each opening with a banner that says
which:

- **Not shipped** — features the template deliberately omits (auth, infrastructure).
  Adopt when your app needs them, and record the choice as an [ADR](../adr/README.md).
- **Recommended, not enforced** — design practices the template can't mechanize
  (the design vocabulary), to apply within the enforced boundaries.

| Guidance | Kind | Covers |
|---|---|---|
| [Design approach](./design-approach.md) | recommended | Tactical DDD, GoF/SOLID, Clean Code, FP — when they earn their keep |
| [Product decisions](./product-decisions.md) | recommended | Writing PDRs (`docs/product/`), rendering them for stakeholder review in Storybook |
| [Auth](./auth.md) | not shipped | Own your auth as a domain module (sessions, OTP, email) |
| [App infrastructure](./app-infrastructure.md) | not shipped | Feature flags, secrets, jobs & cron, graceful shutdown |

See [ADR-0001](../adr/0001-recording-decisions.md) for how guidances relate to ADRs.
