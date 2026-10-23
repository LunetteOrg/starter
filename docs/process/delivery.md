# Delivery: how a change reaches `main` and npm

A short-lived branch per change and one pull request each. Pull requests reach
`main` together, through a **candidate**: a branch that collects them, checked once
by the full CI and merged into `main` in one go. The candidate's prefix, its base and
the hotfix markers are `delivery.candidate` in
[`.agents/config.jsonc`](../../.agents/config.jsonc). Every merge, into the candidate or
into `main`, has a person's go: an agent never merges on its own.

## Branch names

`<type>/<issue>/<slug>`, or `<type>/no-issue/<slug>` for work without an issue:
`feat/77/worktree-branch-names`, `docs/no-issue/version-numbering`. The types are
`delivery.branches.types`, plus the hotfix prefix; the slug is one to four lower-case
words joined by `-`. The base, the candidates and Dependabot's branches are exempt.

The rules live in `lntt branch`, so the tool that creates a branch does not decide its
name:

- `lntt branch name --issue <n>` prints the name for an issue: the type from its issue
  type or labels, a slug from its title.
- A new Orca worktree renames its branch in setup (`orca.yaml`, `lntt branch rename`):
  Orca's `<user>/<name>` becomes the convention, read from the name or from the issue
  linked to the worktree. Orca keeps the worktree, its issue and its terminals on the
  renamed branch.
- `lntt branch check` stops a branch outside the convention before push (lefthook) and
  on the pull request (CI), with the name it should have.

Starting work on an issue in its own worktree, with an agent in it, is one command:
`lntt worktree start --issue <n>`, on Orca, Herdr or plain git
([`packages/lntt`](../../packages/lntt/README.md#starting-work-on-an-issue)). The agent
stops at the draft pull request.

## One pull request

1. **Draft.** A pull request opens as a draft. A draft runs no CI in the cloud
   ([CI](./ci.md)); a pull request opened ready into `main` runs the full CI once on
   its `opened` event, before the automation moves it onto the candidate.
2. **Review on the machine.** The review runs on the local branch with `lntt review`
   (the `review` skill), and fixes are local commits. Reviewers start with no context
   of the conversation that wrote the change, each lens on the agents and models of
   `delivery.review`; verifiers try to refute every blocker and warning; later rounds
   read only the new commits. The branch reaches GitHub when a round finds nothing:
   every push is a full run. A branch takes at most `delivery.review.maxRounds` rounds;
   at the limit the person decides on what is still open: the pull request as it is,
   more rounds for that branch, or an issue
   ([review agents](../adr/review-agents.md)).
3. **`pnpm ci:local` green** on the head about to be published, then one push, then
   `lntt check body` clean on the body, then `gh pr ready`. A red `ci:local` goes back
   into the review.
4. **On the candidate.** When the pull request is opened or marked ready, the candidate
   automation moves it onto the open candidate, creating one when none is open, and
   leaves a comment saying where it went. Marking it ready starts the minimal CI.
5. **Squash into the candidate**, with the review closed, `ci:local` and the minimal
   CI green, and the person's go. The squash message keeps the pull request's
   `Closes #N` lines.

**Merge methods are enforced** by repository rulesets: candidate branches
(`refs/heads/candidate/*`) take squash merges only, `main` takes rebase merges only, and
both take changes through pull requests only, with no required approval. The
repository admin role bypasses both: the release bump is a direct commit on `main`,
and rewriting a candidate (a rebase on `main`) is a force push an
admin makes.

## The pull request body

The body starts from [`.github/pull_request_template.md`](../../.github/pull_request_template.md)
and is written in `delivery.pullRequest.language`:

- **`Closes #N`** for the issue it completes, `Part of #N` for one piece of it.
- **Why** and **What changes**: what a reviewer cannot see in the diff.
- **Definition of done**: the issue's entries, each checked, or left open with the
  reason.
- **Review**: the rounds of `lntt review`, what each found and how it ended, and the
  findings left open.
- **Checks**: `pnpm ci:local` on the commit pushed, with its outcome.
- **The retrospective block**: the labels of `delivery.pullRequest.retrospective`
  between `<!-- retro:start -->` and `<!-- retro:end -->`, each with a value or the
  configured `none`. The `retrospective` skill fills it from the branch's `Retro:`
  trailers and what the agents reported. A squash collapses the commits; the body
  survives it, so it is what the harvest reads. `lntt check body` reports a block
  missing or a label left empty: the author runs it before `gh pr ready`, and CI shows
  each problem as a warning on the pull request. `lntt check` keeps the template's
  block equal to the configuration's.

## The retrospective

**A harvest runs when a release's last candidate merges into `main`**, and when a theme
run by a coordinator ends, on the pull requests of that theme. The `retrospective`
skill reads the blocks of the window's merged pull requests (bodies and comments; a
theme's coordinator leaves its block as a comment on the candidate), clusters them,
checks the proposals of the previous retrospectives and proposes one mechanism per
cluster. The person reads the draft before it is published.

It is published where `cycle.retrospective.target` says. Each proposal the person
adopts becomes an issue of its own (the `github-board` skill), citing the retrospective and
its cluster, so the board holds only the work a retrospective adopts.

## The candidate

The candidate is `<prefix><N>`, with N incremental. The automation creates it when a
pull request needs it: a branch from `main` with an empty commit (GitHub opens no pull
request between identical branches) and a draft pull request into `main`. No
candidate exists on a day without pull requests.

- **Its body is the release list.** At every squash into it, the automation rebuilds
  two lists in the candidate's body from every pull request merged into it, in merge
  order: one line per pull request, and one `Closes` line per issue they close. A line
  written by hand that no pull request accounts for stays. Each open issue gets one
  comment saying that the candidate's merge will close it.
- **Into `main`**, once a day or when the batch is worth it: `pnpm ci:local` on the
  candidate's head; with it green, the candidate pull request is marked ready and the
  full CI runs once on the whole batch; with the full CI green and the person's go,
  it merges with a **rebase**, so `main` gets one commit per pull request and one push.
  Squashes into the candidate happen before it is marked ready: a push to a ready
  candidate starts the full CI again.
- **The board follows.** An open issue that a pull request squashed into the candidate
  closes moves to the Status `delivery.candidate.status.inRelease`: merged into the open
  candidate, waiting for the candidate's merge. The automation moves it in the same run
  that rebuilds the lists; on the candidate's merge every issue of the `Closes` lines
  moves to `delivery.candidate.status.done`, an issue closed by hand in between
  included. One status
  serves overlapping candidates: the issue's comment says which candidate holds it. A
  hotfix merges into `main` and closes its issue at once, so it never has the status.
  The status is an option of the Project's Status field that the Project's owner adds
  (the `github-board` skill, `references/github-project.md`, "Changing a field's options"); the automation never creates or
  renames one. A Project without it, an issue on no Project, or an app without the
  Projects permission leave the board as it is, and the run says so in a `::notice`; a
  refusal on one of an issue's Projects after another was written leaves it moved on
  the first. A status name that is not an option of the Project (a mistyped
  `delivery.candidate.status`, or the option not added yet) gets the same notice, which
  lists the options the Project has.
- **Issues close on the candidate's merge.** GitHub ignores closing keywords in a pull
  request that targets a branch other than the default, and keywords the automation
  writes into the candidate's body link nothing. On the candidate's merge the
  automation closes, as completed, the open issues of its `Closes` lines. The squash
  messages are the safety net: their `Closes` lines reach `main` with the rebase, and
  GitHub closes issues from commits on the default branch.
- **Pull requests left behind** on a merged candidate move onto the next candidate,
  created for them. That covers both cases: still on the merged branch, or moved onto
  `main` by GitHub when it deletes the branch.
- **A red candidate is fixed forward.** The fix comes in a pull request of its own into
  the candidate, with its CI and its squash, and the candidate's full CI runs again on
  the new head. The candidate may be what a preview or pre-production environment runs:
  no merged commit is taken out of it, and the pull requests already merged keep their
  `Closes`.
- **When `main` moves** (a hotfix), the candidate rebases on `main` and `ci:local` runs
  again.
- **Stranded pull requests.** A pull request left on a candidate that is no longer open
  (closed without merging, or a merge whose event the workflow dropped) moves onto the
  open candidate at the automation's next run, whatever event starts it.

**Hotfixes** stay on `main`: a branch named with the hotfix prefix, or the hotfix
label, keeps the pull request on `main`, where it gets the full CI and merges on its
own. A pull request moved by mistake goes back with the label and
`gh pr edit <n> --base main`.

**Pull requests from forks and from Dependabot** stay on `main`: the runs they start
get no repository secrets, so no app token. A maintainer moves one onto the candidate with
`pnpm exec lntt ci candidate --pr <n>`, or merges it on `main` as a hotfix. A
Dependabot pull request runs the CI once an owner, member or collaborator approves it
([CI](./ci.md#dependabot-pull-requests)).

The automation runs from a terminal too: `pnpm exec lntt ci candidate --pr <n>` does
what the workflow would do on that pull request's event (move it, rebuild a
candidate's lists, or close and carry over on a merged candidate), and `--dry-run`
prints the writes instead of making them. A terminal run moves the board too, with the
login of `gh`, which needs the `project` scope (`gh auth refresh -s project`). A terminal run is outside the workflow's
concurrency group: run one at a time, and not while the workflow is running.

## The candidate automation

`.github/workflows/candidate.yml` runs `lntt ci candidate` (`@lntt/lntt`) on three
`pull_request` events (`opened`, `ready_for_review`, `closed`), drafts included, never
on a push. One run at a time across the repository, so two pull requests opened
together find the same candidate. The script and the configuration are read from the
default branch.

It writes with the token of a **GitHub App of the organization**, generated in the job
by `actions/create-github-app-token`. `GITHUB_TOKEN` cannot open a pull request while
the repository keeps *Allow GitHub Actions to create and approve pull requests* off,
and turning it on would let any workflow approve one. The app's edits trigger the
other workflows like a person's: the candidate opens as a draft, so the CI skips it.

Until the app's credentials exist the workflow ends at its first step with a notice,
and pull requests stay where they are opened. To turn it on:

1. **Create the app** in the organization (Settings → Developer settings → GitHub
   Apps → New GitHub App):
   - **Repository permissions:** Contents *read and write* (the candidate branch and
     its empty commit), Pull requests *read and write* (create the candidate, move a
     pull request, edit the body, comment), Issues *read and write* (comment on and
     close issues). Metadata *read* comes with them. Nothing else on the repository, and
     the organization permission Projects of the board (below): no approvals, no
     administration, no workflows.
   - **Homepage URL** (required by the form): this repository's URL.
   - **Webhook:** off. **Events:** none; the workflow brings the events.
   - **Where it can be installed:** only this account.
2. **Install it** with *Repository access: only select repositories*, and select this
   repository only.
3. **Store its credentials** in the repository (Settings → Secrets and variables →
   Actions): the app's **Client ID** in the variable `CANDIDATE_APP_CLIENT_ID`, and a
   generated **private key** (the whole `.pem`) in the secret
   `CANDIDATE_APP_PRIVATE_KEY`.

   For the board, grant the app the organization permission **Projects** *read and
   write*, and let the installation reach the Project. It is requested by a step of its
   own, so an app without it still runs the candidate; the board stays put, with a
   notice.
4. **Add the app as a bypass actor of the candidates ruleset** (*candidates: squash
   merge only*): it creates `candidate/<N>` with a commit, which the ruleset's
   pull-request rule otherwise blocks.
5. **Repository settings:** rebase merge and squash merge allowed (the rulesets narrow
   each branch to one). *Automatically delete head branches* may stay as it is: the
   automation finds the pull requests left behind either way.
6. **Create the hotfix label**, the one named by `delivery.candidate.hotfix.label`,
   which the steps above do not create: `gh label create <name> --description "Stays
   on main, not on the candidate"`. Without it the label cannot be put on a pull
   request that must stay on `main`.

**Rotating the key.** A pull request from this repository runs its own copy of the
workflow file, with the app's key in reach, so anyone with write access can use the
token in a run. When someone loses write access, generate a new private key in the
app, replace `CANDIDATE_APP_PRIVATE_KEY`, and delete the old key.

## The shared skills

A skill's guide is edited in `packages/lntt/skills/<skill>/` and ships with the next
release of `@lntt/lntt`. This repo installs its own stubs like any project: when a
change adds, removes or redescribes a skill (its frontmatter), `pnpm exec lntt sync`
runs on that branch and the stubs' diff goes in the same pull request; `lntt check`
fails in CI until it does. A project gets a new version of every guide with the bump of
`@lntt/lntt`, and runs `lntt sync` in that pull request when `lntt check skills` fails
([agent layer](../adr/agent-layer.md)).

## The Lunette plugin

The plugin holds the Claude Code hooks (the `lntt review` band, the issue titles on
screen). A change under `plugins/lunette/` raises the version in its
`.claude-plugin/plugin.json`: installed copies update only when the version changes.
CI checks it on every pull request (`scripts/check-plugin-version.sh`), and validates each
plugin with `claude plugin validate`, which refuses a hooks module the engine would not
load.

## Releasing

npm publishing happens in CI only, never from a machine, with the one exception of a
new package's placeholder (below). One release publishes every
package of `packages/` that is not private, all at one version
([CLI runtime and publishing](../adr/cli-runtime-and-publishing.md)).

**Choosing the version.** Until 1.0.0 every release is a patch (`0.6.N`), one per
milestone, and the milestone is named after the version it ships. 1.0.0 is declared
only after months of intensive use across several projects, not when a piece of work
ends.

1. `node scripts/packages-version.mts set X.Y.Z` and commit
   `chore(release): X.Y.Z` directly on `main`; a release does not go through a pull
   request.
2. `gh release create vX.Y.Z --generate-notes`. The tag matches the packages'
   version, and every release ships the generated notes (the merged pull requests
   since the previous tag).
3. Add by hand what the generator misses: it lists merged pull requests only, so a
   user-facing change that landed as a direct commit (`git log vPREV..vX.Y.Z
   --no-merges`) goes in with `gh release edit vX.Y.Z --notes …`. The release bump
   and repo-internal commits stay out.

Publishing the GitHub Release starts `.github/workflows/release.yml`: it checks that
the tag is every package's version, runs lint, typecheck and the tests with the
scaffold smoke, and publishes each package through npm trusted publishing (OIDC,
`--provenance`, no npm token), skipping a version npm already has. Each package is
packed with `pnpm pack`, so its `publishConfig` applies, and npm publishes the tarball.

**A dry run** is a pre-release: set a pre-release version on a branch
(`node scripts/packages-version.mts set X.Y.Z-rc.N`, commit, push), then
`gh release create vX.Y.Z-rc.N --prerelease --target <branch>`. The workflow runs every
check, packs each package and passes the tarball to `npm publish --dry-run`; nothing
reaches npm. Delete the pre-release, its
tag and the branch afterwards.

Promoting a pre-release to a full release publishes nothing: the promotion fires
`released`, and the workflow runs on `published`. Release the version as its own tag.

**A new package** reaches npm by hand once, before the release that first carries it,
because npm configures a trusted publisher only on a package that exists:

1. Publish a `0.0.0` placeholder of every package npm lacks, with
   `node scripts/placeholder-publish.mts`, logged in to npm with publish rights on the
   `@lntt` scope. `--dry-run` prints which packages it would publish and writes
   nothing. A package npm already has, at any version, is skipped; `package.json` is
   restored after each publish. The placeholder only reserves the name and is never
   installed: published from the directory, npm ignores `publishConfig.bin` and
   `publishConfig.exports`, so a package that points its published `bin` and
   `exports` at `dist/` there ships its source entries in the placeholder.
   It is the only publish ever made from a machine
   ([CLI runtime and publishing](../adr/cli-runtime-and-publishing.md)); the version
   set by the release bump is untouched.

   **Run it in a terminal a person can answer.** `npm publish` asks for 2FA through a
   browser prompt and waits for it; from an agent's shell or a `!` command in Claude
   Code it fails with `EOTP`, and the script refuses to start without a terminal. A
   failed attempt may still leave a `0.0.0-stage` placeholder ("Temporary package
   placeholder for staged publishing") on the registry with nothing in *Staged
   Packages* to approve. That placeholder is enough to configure the trusted
   publisher (step 2), and the script skips it because `npm view` returns it.
2. On the package's page on npmjs.com, Settings → Trusted publishing: repository
   `LunetteOrg/starter`, workflow `release.yml`, with **allow `npm publish`**
   ticked; a configuration created after 2026-09-03 otherwise allows only
   `npm stage publish`. npm's form discourages *Allow npm publish*; the
   release process ticks it on purpose (*Discarded directions*).
3. Run the CI release within two days: an unused trusted publisher configuration
   expires.

## Discarded directions

- **Publishing from a developer machine.** The token would live on a laptop, and
  nothing would check that the tests ran on the published code.
- **Staged publishing for every release** (leave *Allow npm publish* unchecked, as npm
  recommends). Each release would wait for a maintainer's 2FA approval on npmjs.com,
  and `release.yml` would publish with `npm stage publish` (npm ≥ 11.15) instead of
  `npm publish`. A release is already gated by the tag, the tests and the person's go
  to publish the GitHub Release, and the approval would only add a second wait on the
  same decision.
- **The body's retrospective block as a gate in CI.** Editing a body starts no run, so
  a red check would stay red after the block is filled, until the next push.
- **A retrospective published as an issue.** The board would hold the report beside
  the work it proposes; the report is a Discussion, and only the adopted proposals are
  issues.
- **Release pull requests.** A version bump has nothing to review that CI does not
  already check.
- **GitHub's merge queue.** It is the mechanism built for this. The flow here is the
  one the templates ship to their projects, which are private and on plans without a
  merge queue, and this repository exists to try that same flow: a merge queue here
  could not be tested for them.
- **Taking the culprit's commits out of a red candidate.** It rewrites a branch that a
  preview or pre-production environment may be running, removing from it what people
  are looking at, and turns the merged pull request's `Closes` into `Refs` by hand.
- **A fixed `candidate` branch, or one created every day by a cron.** A cron opens
  candidates on days without work, and a pull request opened before it has nowhere to
  go; a fixed branch has to be reset after every merge. A numbered candidate created
  when needed exists only with work in it.
- **Squashing the candidate into `main`.** One commit per batch: a revert, a blame or a
  bisect would land on the whole batch instead of the pull request.
- **Keeping pull requests in draft until the squash.** GitHub does not merge a draft:
  it would be marked ready right before the squash, starting the CI at that moment.
- **`Closes` lines in squash messages as the only way to close issues.** They depend on
  each message being written right and on a merge method that keeps them; the
  automation closes issues whatever the method, and the messages stay as the net.
- **`GITHUB_TOKEN` with *Allow GitHub Actions to create and approve pull requests*.**
  The same setting lets any workflow approve a pull request.
- **Creating the `In release` option from the automation.** Adding an option to a
  single-select field with `updateProjectV2Field` rewrites the whole option set and
  regenerates every option id, so every item of the Project, on every repository that
  shares it, loses its Status. A missing option is a notice.
- **One status per candidate** (`In candidate 3`). The options would multiply with the
  candidates and every move would rewrite one; the candidate's number is already in the
  issue's comment.
- **A personal access token.** The writes would be one person's, with that person's
  rights on every repository they see, and they stop when the person leaves.
