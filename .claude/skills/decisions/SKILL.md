---
name: decisions
description: Write, update and check a Lunette project's decision records (ADRs, PDRs) and process descriptions. Reads which logs exist, where and in which language from the `recording` section of `.agents/config.jsonc` or `.agents/config.yml`. Use when a decision is taken or changed, when asked to record or document one, when asked to check alignment with the ADRs or find drift, AND as part of every code review and PR review (check mode, report-only).
---

# Decision records

One skill for every record a Lunette project keeps: architecture decisions (ADRs),
product decisions (PDRs) and process descriptions. The rules for *how* a record is
written are the same everywhere and live in this skill
([`references/recording-rules.md`](./references/recording-rules.md)). *Which* logs a
project has, where and in which language, is the project's own, in its configuration.
This skill is installed unchanged in every project: never edit it to fit one.

## 1. Locate the logs

Read the `recording` section through the configuration reader, never by parsing the
file yourself (it has comments):

```sh
lntt-config get recording        # or: pnpm exec lntt-config get recording
```

It returns `language` and `logs`: one entry per log (`adr`, `product`, `process`, …)
with its `path`, and optionally `index`, `template` and `scope`. `scope` says what
belongs in that log; use it to file a decision in the right one.

- **No configuration file, or no `recording` section:** stop. Propose the section to
  add (the logs you can see in the repo, their paths, the language their records are
  written in) and let the person confirm it. Never guess paths and carry on.
- A `logs` entry whose `path` does not exist is a finding (check mode) or a question
  (write mode), not something to create silently.

## 2. Write or update a record

Follow [`references/recording-rules.md`](./references/recording-rules.md). In short:

- **Pick the log** by its `scope`. A technical decision is an ADR; a product or design
  decision a PDR; how the team works (board, CI, delivery, cycle) is a process
  description ([`references/process-descriptions.md`](./references/process-descriptions.md)).
  Process descriptions are never mixed into ADRs.
- **Find the subject first.** A decision about a subject that already has a file is
  written *into that file*, rewriting what changed. A new file only for a new subject.
- **Write the state, not the history.** The file says what holds now; git keeps how it
  got there. No `superseded by`, no struck-through text, no amendment sections.
- **Options not taken** go in *Discarded directions* at the end, each with its reason.
- **Copy the log's `template`** for a new file, and add it to the log's `index`.
- Write in the configured `language`.
- Show the person the record (or the diff of a rewritten one) before saving it.

## 3. Check (report-only)

Compare the repo with what its records say. Do **not** edit files, write records or
apply fixes: output findings and recommended actions only.

1. **Load the records now.** Read each log's index and the `##` sections of every
   record. Build the checks from what they say today; never recite from memory.
2. **Derive the checks from the records.** Each decision that can be checked in code
   or config becomes a check, tied to its file and heading anchor. Respect each log's
   `scope`: a decision filed in the wrong log is a finding.
3. **Prefer the project's tests.** When a test or a lint rule already asserts a
   decision, a passing run is a passing check, not a finding. Run what the project's
   scripts provide rather than re-deriving it by hand.
4. **Find unrecorded decisions.** A choice visible in the code that no record covers
   (a new capability, a new convention, a changed contract): propose the record to
   write, in the log its scope says.
5. **Check the records themselves** against the recording rules: a numbered or
   superseded-by record, a struck-through amendment, a process rule inside an ADR, a
   value repeated from the configuration instead of citing its key.

Output:

```
# Decision check

## Violations of existing records
- [severity] <file>#<anchor> — <rule>. Evidence: path:line. Recommended action: …

## Unrecorded decisions (records to write)
- <log>: <proposed subject> — <why>.

## Records out of shape
- <file> — <which recording rule>. Recommended action: …

## Passing checks (brief)
- <file>#<anchor> — <rule>: holds (enforced by <test / config>).
```

Severities: **blocker** (contradicts an accepted record), **warning** (drift or
partial), **note** (worth recording, not yet wrong). Lead with blockers; end clean if
clean.
