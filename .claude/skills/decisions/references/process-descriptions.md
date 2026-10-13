# Process descriptions

How a team works (its GitHub board, its CI, how a pull request is delivered, its
planning cycle, where prototypes and spikes live) is described separately from its
technical decisions. It has two parts:

- **Values** in the configuration (`.agents/config.*`), one section per area. A skill
  reads them; a short reason sits in a comment next to the value.
- **Prose** in `docs/process/<area>.md`, for what a value cannot express: the
  project's own mechanisms (how a deploy gate is unblocked, when a prototype is
  archived, the Definition of Ready) and the longer reasons. A process description is
  **optional**: an area whose values speak for themselves has none.

## The areas

The names are fixed, so a skill finds an area's values and prose without being told
where they are.

| Area | What it covers |
|---|---|
| `recording` | Which decision logs exist, where, in which language, what each holds |
| `board` | The GitHub project: fields and options, iterations, track labels, owners |
| `ci` | Providers, what runs on drafts, pull requests and the main branch, deploy gates, cost rules |
| `delivery` | Pull request body and its language, review rounds, merge rules, hand-off |
| `cycle` | Planning, grooming and retrospective cadence, where a retrospective is published |
| `spaces` | Reference material, prototypes, spikes, personal notes: where they live and when they are archived |
| `team` | Handles, roles and ownership that other people need (never personal profiles) |

A skill working in an area reads `docs/process/<area>.md` when it exists, and the
area's section of the configuration always.

## Rules

- **Prose only.** A process description cites configuration keys (`board.scope`) and
  never repeats their values: a value lives in one place.
- **Kept apart from ADRs.** A process rule inside an ADR is a finding.
- **Corrected in place**, like every record ([`recording-rules.md`](./recording-rules.md)),
  with *Discarded directions* at the end.
- **No frontmatter values.** The configuration is the only place a skill reads values
  from.

## Shape

```markdown
# <Area>: how <project> <does it>

What a newcomer needs to work this way, in prose: the mechanisms, the reasons, the
exceptions. Cite configuration keys, never copy their values.

## Discarded directions

- **An option not taken.** Why it does not hold.
```
