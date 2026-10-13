# Recording: how the starter keeps its decisions

The rules for writing a record are the decisions skill's
([`.claude/skills/decisions/references/recording-rules.md`](../../.claude/skills/decisions/references/recording-rules.md)).
The logs, their paths and their language are in `recording` of
[`.agents/config.jsonc`](../../.agents/config.jsonc). This page holds what is
particular to this repo.

## Two levels of decision log

This repo holds the templates *system* (the CLI, the template model, the scaffolding
contract) and the templates themselves. Each level has its own log:

- **The system's ADRs** are `recording.logs.adr`. They decide what every template must
  be and how the CLI treats it. They never ship.
- **A template's ADRs** live inside the template
  (`packages/create/templates/<framework>/docs/adr/`) and travel into every project
  scaffolded from it. They decide that template's application architecture. They are
  not listed in this repo's configuration: they belong to the project the template
  becomes, and its own configuration lists them.

A decision is filed by what it governs, not by where it was discussed: a change to
the scaffolding contract is a system ADR even when it was found while working on a
template. Two `CLAUDE.md` files are in scope inside this repo; the root one says
which rules a template's files follow while the template is drafted here.

What a template hands to its generated projects (the shape of their logs) is itself a
system decision: [decision logs in generated projects](../adr/decision-logs-in-generated-projects.md).

## Discarded directions

- **One log for both levels.** Every template decision would sit next to the CLI's,
  and nothing would travel with the template into the projects that need it.
- **Numbered, append-only system ADRs.** The reasons against them are the decisions
  skill's, and they hold here as in every log.
