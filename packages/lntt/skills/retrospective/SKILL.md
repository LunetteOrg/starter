---
name: retrospective
description: Carry the friction met while working to where it gets fixed — a `Retro:` trailer on the commit, the retrospective block of the pull request body (between `<!-- retro:start -->` and `<!-- retro:end -->`), the candidate's retrospective comment for the batch's friction (`lntt retro add`), a harvest of the merged pull requests' blocks into proposals, published where `cycle.retrospective` says, and the friction that comes from Lunette itself (items marked with the upstream repository, `[<owner/name>]`) reported upstream with `lntt dump` and `lntt issue`, on the operator's approval. Use when opening a pull request (to fill the block), before marking one ready (`lntt check body`), when an orchestrator or a coordinator meets friction that belongs to the batch or squashes into the candidate, and when a theme or a release ends (the harvest and the upstream reports).
---

# Retrospective

Friction met during the work (a step harder than it should be, a rule found again, a
check that failed for reasons outside the change) reaches nobody unless it is written
where the next person reads it. Three stages: **capture** it while working, **absorb** it
into the pull request body, **harvest** the bodies when a theme or a release ends. The
values come from the project configuration; this skill is the procedure, never edited to
fit one project.

## 0. Read the values

```sh
lntt pr block                      # the empty block: heading, markers, one label per line
lntt get delivery.pullRequest      # the template, the language of the body's prose
lntt get cycle.retrospective       # where a harvest is published, the targeted review, the upstream
lntt get delivery.commits          # whether Retro is one of the trailers
```

`lntt pr block` prints the block with the schema's defaults for what
`delivery.pullRequest.retrospective` leaves out. `lntt get` fails on a key the
configuration does not have. Without `cycle.retrospective.target`, a harvest stops
before publishing and proposes the section to the person (`kind`, `category` for a
Discussion, `title` with `{window}`); it never picks a place to publish. Labels are
written exactly as the configuration gives them, in its language; the values in the
language of `delivery.pullRequest.language`. `cycle.retrospective.upstream.repository`
is the upstream repository, `<upstream>` below (`LunetteOrg/starter` in a project
scaffolded from Lunette).

## 1. Capture, while working

- **A `Retro:` trailer** on the commit where the friction was met, one sentence: what
  was harder than it should be, what a hook, a skill or a check could do instead. It is
  a capture aid: a squash collapses the commits, and the pull request body is the store.
- **A subagent or a child** returns its friction in its final report, one line per item.
  Whoever opens the pull request writes it into the block.
- **The batch's friction**, which belongs to no single pull request, goes into the
  candidate's retrospective comment the moment it is met (section 3):

  ```sh
  lntt retro add --label <label> "<one sentence>"     # the open candidate; --pr <n> for another
  ```

- **Friction that comes from Lunette itself** (`lntt`, a shared skill, the scaffolder, a
  template: what the project cannot fix on its own) starts with the upstream in
  brackets, in the trailer and in the block:
  `Retro: [<upstream>] lntt review lost its state on git switch`. It is fixed upstream
  (section 5), never worked around in silence.

## 2. Absorb, when the pull request opens

The body comes from the template (`delivery.pullRequest.template`, default
`.github/pull_request_template.md`), which carries the empty block. Fill every label:

```sh
git log "origin/<base>..HEAD" --format=%B | grep -i '^Retro:' | sed 's/^[Rr]etro: *//'
```

(Not `%(trailers)`: git does not read the last paragraph as trailers when a line of it,
such as `Refs #91`, has no colon.)

- Each trailer, and each item a subagent returned, goes under the label it fits. Several
  items under one label are sub-bullets on the lines below it.
- **An item from upstream keeps its `[<upstream>]`** at the start, followed by a space:
  `- **Friction:** [<upstream>] …`, or a sub-bullet `  - [<upstream>] …`. In the middle
  of a sentence it is no marker.
- **`none` is an answer** (the configured `none`): write it where nothing applies. A label
  left empty means the block was not filled in, and the harvest counts it apart.
- **A line about the review's cost**, when the configuration has one: the rounds of
  `lntt review` on the branch, the sum of their `tokens` and of their `cost` (USD), from
  each round's JSON; a round whose agents reported no cost says so.
- What surfaces after the pull request is open goes into the body's block, or into a
  comment that holds a block of its own: the harvest reads both.

Before the pull request is marked ready:

```sh
lntt check body          # the current branch's pull request; --pr <n>, or - for stdin
```

It fails naming a missing block, or a label missing, written twice or left empty, or a
marker with no sentence after it, or a bracketed `owner/name` at an item's start that is
not the upstream (or with no upstream configured). CI
reports the same on the pull request. The template's block is the one `lntt pr block`
prints (`lntt check body template`): a label added to the configuration goes into the
template in the same change.

## 3. The candidate's retrospective comment

The friction of an orchestrator or a coordinator belongs to the batch: the coordination,
the machine, the account's limits, siblings that conflicted, a candidate whose full CI
fails. It goes in the **candidate's retrospective comment**, which the candidate
automation opens every candidate with (the empty block of `lntt pr block`) and never
rewrites, unlike the body it rebuilds at every squash. Written at the end, it would be
written from memory, after the context was compacted or the session gone; so it is
written as it happens, one sentence each:

```sh
lntt retro add --label friction "the full CI failed on a runner out of disk; rerun"
```

`--label` is the configured label, or the start of only one (`to` for `To automate
(hook/skill/agent)`). An empty label or `none` takes the item on its line, a label with
a value gets sub-bullets; the markers and the other labels stay. With no candidate open,
it fails: name the pull request with `--pr <n>` (a theme with no candidate writes on its
last pull request). A candidate opened before the comment existed gets one at the first
`lntt retro add`.

**When to append:**

- a child reports friction that is the theme's, not its own pull request's;
- a review round or a CI run costs more than expected (a review that does not converge,
  a full CI run again);
- the orchestrator or the coordinator works around something by hand (a permission, a
  step a tool did not do);
- at each squash into the candidate: what the squash cost beyond the pull request's own
  block (a rebase, a conflict, a run again), or nothing.

**Before the candidate is marked ready**, every label holds a value or `none`:

```sh
lntt check body --pr <candidate>    # on a candidate it reads the retrospective comment
```

It fails on a missing comment, a label missing, written twice or left empty.

## 4. Harvest, when a theme or a release ends

**Report-only.** The harvest proposes, the person chooses, and nothing is built or
published without the person's go.

1. **The window.** The merged pull requests of the release (its candidates and the
   hotfixes) or of the theme, or the dates since the previous retrospective. The
   previous ones are found at the target, by the title of `cycle.retrospective.target`
   with `{window}` as any text; the window starts where the last one ended.
2. **The blocks.** For each merged pull request, the text between the markers, in its
   body and in its comments:

   ```sh
   gh pr list --state merged --search "merged:<from>..<to>" --json number,title,body --limit 200
   gh pr view <n> --json comments --jq '.comments[].body'
   ```

   A candidate's block is its retrospective comment (section 3). A label with a value
   is a signal; `none` is an answer with no signal; an empty label,
   or a pull request with no block, is counted apart and the count is reported. Friction
   collected outside the bodies (an issue gathering a theme's friction) is read with them
   and cited.
3. **Cluster** the signals by theme and weigh them by frequency and by rework cost. A
   cluster that **recurs** from a previous retrospective says so and weighs more: its
   proposal was not built and the cost was paid again.
4. **Check the repository too**, not only the bodies: CI runs, branches left on the
   remote, drift between configuration files. Friction always worked around by hand
   leaves no trace in a body.
5. **The previous proposals**, each with its state (adopted, partial, superseded, not
   adopted) and its proof: a `path:line`, a command and its output, a pull request or
   issue number.
6. **One concrete mechanism per cluster**: a skill or a change to one, a hook, a CI
   check, a decision record, an `AGENTS.md` rule, or an `lntt` command. Each cites the
   pull requests (and issues) it comes from.
7. **The targeted review**, when `cycle.retrospective.targetedReview` is set: count its
   `line` on its own. When the same test or cause comes back in `minPullRequests`
   pull requests of the window (default 2), propose a targeted review of the suite,
   titled with `target.targetedTitle` when the configuration has it.
8. **The draft goes to the person** (or to the orchestrator, from a coordinator) before
   it is published.
9. **Publish** at `cycle.retrospective.target` (section 0 when it is missing), with
   `{window}` replaced in the title:
   - `discussion`: a GitHub Discussion in `category`, with the `createDiscussion`
     mutation; the repository and category ids are read with `gh api graphql`, never
     written down.
   - `issue`: an issue with the proposals as a checklist, on the board (the
     `github-board` skill).

A cluster made of `[<upstream>]` items is not built in the project: section 5 takes it
upstream.

**Every proposal the person adopts becomes an issue** of its own (the `github-board`
skill), citing the retrospective and its cluster. A proposal left only in a retrospective is
never built.

## 5. Report upstream what comes from Lunette

At the end of a harvest, and at the end of a coordinator's theme, each cluster of
`[<upstream>]` items becomes a report for the upstream repository. **Nothing is sent without
the operator's approval, report by report.**

1. **The repository** is read, never written here: `lntt issue` sends to
   `cycle.retrospective.upstream.repository`, and fails naming the key when the
   configuration does not set it; its dry run names it on its first line.
2. **No duplicates.** Search the open issues there for the cluster's subject:

   ```sh
   lntt issue search <a few words of the subject>
   ```

   When one is the same subject, the report is a comment on it (`--comment <n>`), not a
   new issue.
3. **The draft**, one file per cluster, in English (the Lunette repository's language):

   ```markdown
   # <what fails, in one line>

   ## What happened
   <the friction, from the items, in English>

   ## Pull requests
   <the pull requests the items come from>

   ## Proposal
   <what lntt, the skill or the template could do instead>
   ```

4. **The dump**, the environment collected by the command, never by hand:

   ```sh
   lntt dump --json --model <the model you run on> [-- <the failing command>] > <dump.json>
   ```

   `--` runs the failing command again, when there is one and running it again is
   harmless. The dump is redacted (home path, remotes, emails, tokens, secrets); read it
   anyway, and take out what the project would not publish.
5. **Show the operator each report whole**, as it would be sent:

   ```sh
   lntt issue <draft.md> --dump <dump.json> [--comment <n>]
   ```

   The dry run prints everything that leaves the machine. The operator approves each
   report on its own, or changes it; one not approved stays in the retrospective.
6. **Send the approved ones**, the same command with `--send`. It opens the issue (or
   the comment) with `gh`, under the operator's account, and prints its URL: write the URL
   beside the cluster in the retrospective.

## Guardrails

- The pull request body is the store, and a candidate's retrospective comment; commit
  trailers, reports and `lntt retro add` are how friction gets there.
- Keep the markers exactly `<!-- retro:start -->` and `<!-- retro:end -->`, each on a line
  of its own: the check and the harvest read them as text.
- A harvest creates no skill, hook or issue by itself: it proposes.
- An upstream report goes through `lntt issue`, never `gh` directly, and only with
  `--send` after the operator approved that report.
