<!-- lunette:start — managed by lntt sync: edit the source, not this block -->
# Working in a Lunette project

- **Where things are.** Project values: `.agents/config.jsonc` (or `.yml`), read with
  `lntt get <key>`, never parsed by hand: it has comments. How the team works:
  `docs/process/`. Decisions: the logs in `recording` (ADRs, PDRs), one file per
  subject, corrected in place, written and checked with the `decisions` skill. Who
  you are talking to: `lntt operator` (personal, from `.agents/local/` or
  `~/.agents/`; with no profile, a developer).
- **Shared decisions live in the repo.** A decision that matters to more than one
  person goes in a record, a process description or a comment in the affected file,
  never only in a private or agent-local note.
- **Give criteria before options.** Lead with the axes that decide between
  alternatives, drawn from verifiable constraints. Recommend where they converge;
  where they don't, present the choice with the criteria beside it.
- **Claims carry their proof.** "It works", "it passes", "it is faster" comes with
  the command and its outcome, a `path:line` or a commit; what was not run is
  written as deduced, from what.
- **Never write an issue or pull request number before its title, in the same message.**
  A title given in an earlier message, or a label of your own, does not count.
- **An agent never merges on its own.** A merge needs an explicit go from a person.
- **Before a commit, follow the `commit-message` skill.**
- **A review is `lntt review`, with the `review` skill:** reviewers with no context
  of the conversation, the decision records among their lenses, on the agents the
  project configures; a round is repeated until it finds nothing.
<!-- lunette:end -->

# The Lunette starter

This repo holds `@lntt/create` (the scaffolder), the Lunette templates it ships, and
the shared pieces they use. It is **not** itself a Lunette template: it is the system
that ships them. The layout and the commands are in the [README](./README.md).

- **Two levels, never confused.** This repo's [`docs/adr/`](./docs/adr/README.md)
  decides the templates *system*: the CLI, the [template model](./docs/adr/template-model.md),
  the [scaffolding contract](./docs/adr/scaffolding-contract.md). Each template
  (`packages/create/templates/<framework>/`) is a self-contained project with its own
  tooling, decisions and agent files: template content. Do not "fix" it to match
  this repo, and do not bring this repo's conventions into it. A decision is filed by
  what it governs, not by where it came up.
- **A change to the scaffolding contract changes the CLI and every template in the
  same pull request.**
- **Releases are published by CI, never by hand** ([delivery](./docs/process/delivery.md)).
