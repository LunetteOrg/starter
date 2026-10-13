# Working in a Lunette project

- **Where things are.** Project values: `.agents/config.jsonc` (or `.yml`), read with
  `lntt-config get <key>`, never parsed by hand: it has comments. How the team works:
  `docs/process/`. Decisions: the logs in `recording` (ADRs, PDRs), one file per
  subject, corrected in place, written and checked with the `decisions` skill. Who
  you are talking to: `lntt-config operator` (personal, from `.agents/local/` or
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
- **An agent never merges on its own.** A merge needs an explicit go from a person.
- **Before a commit, follow the `commit-message` skill.**
- **Every review runs the `decisions` skill in check mode**, before the line-by-line
  pass, and reports its findings with the review.
