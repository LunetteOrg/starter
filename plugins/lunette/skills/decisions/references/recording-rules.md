# Recording rules

The rules every Lunette decision log follows. A project's own values (which logs,
where, which language, what each one is for) are in the `recording` section of
`.agents/config.*`; the longer reasons a project has for them are in its
`docs/process/recording.md`, when it has one.

## A record is a subject, corrected in place

- **One file per subject**, named after it in kebab-case (`scaffolding-contract.md`).
  The file name is the id: no numbers, no dates in the name. The title is the subject
  too: no `ADR NN`, no `1.` or `0003` before it; a title that opens on a count, a
  version or a time (`# 3 retries`, `# 2.0 migration`) is words.
- **The file states what holds now.** When a decision changes, its file is rewritten
  and the change lands as a commit. The history of a subject is
  `git log --follow -- <file>`, not a chain of files.
- **No amendment markers**: no `superseded by`, no struck-through text, no "Update
  (date)" sections, no "until yesterday this said".
- **Describe the state, not how it was reached.** A reader was not in the discussion
  that produced the record. Write "X is Y because Z", not "it stays Y because" or
  "the alternative was dropped".
- **Discarded directions** close the file: each option not taken, with the reason it
  does not hold, so a reader does not propose it again. They live there and nowhere
  else in the prose.
- **Cite by file and heading anchor** (`scaffolding-contract.md#placeholders`), never
  by a number.
- **State a rule once**, where it belongs. A record that repeats what the README, a
  guidance or the configuration already says spends the reader's attention twice;
  cite the source instead. A configuration value is cited by its key
  (`recording.language`), never copied.

## The shape of a record

Use the log's `template` when the configuration names one. The comment beside its
`status:` lists the statuses the log allows (`proposed | accepted`), and
`lntt check decisions` checks every record against it. The default, for ADRs and PDRs,
is MADR with YAML frontmatter:

```markdown
---
status: proposed # proposed | accepted
date: YYYY-MM-DD # when the decision last changed
deciders: [] # optional
tags: [] # searchable keywords, kebab-case
---

# Subject

## Context
## Decision
## Consequences
### Positive
### Negative / accepted risks
### When to deviate (revisit triggers)
## Discarded directions
```

Keep it short. A record is read in one sitting; if it grows past that, it probably
holds two subjects.

## Which log

- **ADR**: a technical decision about the system (architecture, tooling, contracts).
- **PDR**: a product or design decision (what the product does, for whom, how it looks).
- **Process description**: how the team works, see
  [`process-descriptions.md`](./process-descriptions.md). Never inside an ADR.

When a project has more than one ADR log (a system and the templates it ships, for
example), each log's `scope` says which decisions it holds.

## Why these rules

- **In place, not append-only:** a decision spread over an original and its
  amendments has to be reconciled by every reader; a file that states the current
  state is read once. Git already keeps the history, with authors and dates.
- **No numbers:** a counter is a contended resource between concurrent pull requests,
  and the collision is silent (two different file names, no git conflict). A subject
  name collides only when two people record the same subject, which is the collision
  worth seeing.

## Discarded directions

- **Numbered, append-only records that supersede rather than rewrite.** The two
  reasons above.
- **Atomic dated files, one per decision.** Collision-free and chronological, but a
  subject's current state is then spread over many files, and a new reader cannot
  read the foundation in one sitting.
