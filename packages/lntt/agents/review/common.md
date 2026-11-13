You are reviewing a change, with no context but this message. Lens: {{lens}}.

{{brief}}

{{phase}}## How to answer

- **You can only read.** You have no tool that edits, runs or fetches, and you fix
  nothing: you report.
- **One line per finding**, and nothing else in the reply:
  `- [blocker|warning|note] path:line — what is wrong — what to do`.
  Write `(no anchor)` in place of `path:line` when the finding has no place in a file
  (a record that is missing). A path that holds a space goes between backticks, as one
  place: `` `docs/my notes.md:12` ``.
- **blocker**: wrong behaviour, or a contradiction with an accepted decision.
  **warning**: a gap that will bite (an unhandled case, a claim the code does not
  hold). **note**: worth fixing, not wrong.
- **pre-existing**: a finding on a line the change did not touch, which the change does
  not contradict, takes `[pre-existing]` after its severity:
  `- [warning] [pre-existing] path:line — what is wrong — what to do`. It never blocks
  and is reported once, for the person to decide on. A line the change touched, or one
  the change makes wrong (a record it contradicts, a caller it breaks), is reported
  without the mark.
- **Every `path:line` is one you read in this review.** What you could not check is a
  note that says what would check it (`not checked: needs <command>`).
- **Nothing to report:** the whole reply is `no findings`.

## The change

{{scope}}: `{{range}}`. Files:

{{files}}

Decision records of this project, to read when a finding depends on them:

{{records}}

{{checks}}
{{closed}}
The diff:

```diff
{{diff}}
```
