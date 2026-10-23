---
name: retrospective
description: Carry the friction met while working to where it gets fixed — a `Retro:` trailer on the commit, the retrospective block of the pull request body (between `<!-- retro:start -->` and `<!-- retro:end -->`), and a harvest of the merged pull requests' blocks into proposals, published where `cycle.retrospective` says. Use when opening a pull request (to fill the block), before marking one ready (`lntt check body`), when a coordinator closes a theme, and when a theme or a release ends (the harvest).
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
lntt get cycle.retrospective       # where a harvest is published, the targeted review
lntt get delivery.commits          # whether Retro is one of the trailers
```

`lntt pr block` prints the block with the schema's defaults for what
`delivery.pullRequest.retrospective` leaves out. `lntt get` fails on a key the
configuration does not have. Without `cycle.retrospective.target`, a harvest stops
before publishing and proposes the section to the person (`kind`, `category` for a
Discussion, `title` with `{window}`); it never picks a place to publish. Labels are
written exactly as the configuration gives them, in its language; the values in the
language of `delivery.pullRequest.language`.

## 1. Capture, while working

- **A `Retro:` trailer** on the commit where the friction was met, one sentence: what
  was harder than it should be, what a hook, a skill or a check could do instead. It is
  a capture aid: a squash collapses the commits, and the pull request body is the store.
- **A subagent or a child** returns its friction in its final report, one line per item.
  Whoever opens the pull request writes it into the block; a coordinator collects its
  children's in the theme's notes for the end of the theme (section 3).

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

It fails naming a missing block, or a label missing, written twice or left empty. CI
reports the same on the pull request. The template's block is the one `lntt pr block`
prints (`lntt check body template`): a label added to the configuration goes into the
template in the same change.

## 3. A coordinator, when the theme ends

The children's friction about their own issue is in their pull requests. What belongs
to the theme (the coordination, the machine, the account's limits, siblings that
conflicted) the coordinator writes, when the last child's pull request is merged, as a
**comment on the candidate pull request** holding the block (`lntt pr block`, filled).
A comment, not the candidate's body: the candidate automation rewrites that body at
every squash into it. A theme with no candidate puts the comment on its last pull
request.

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

   A label with a value is a signal; `none` is an answer with no signal; an empty label,
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

**Every proposal the person adopts becomes an issue** of its own (the `github-board`
skill), citing the retrospective and its cluster. A proposal left only in a retrospective is
never built.

## Guardrails

- The pull request body is the store; commit trailers and reports are how friction gets
  there.
- Keep the markers exactly `<!-- retro:start -->` and `<!-- retro:end -->`, each on a line
  of its own: the check and the harvest read them as text.
- A harvest creates no skill, hook or issue by itself: it proposes.
