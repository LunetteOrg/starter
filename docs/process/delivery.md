# Delivery: how a change reaches `main` and npm

A short-lived branch per change and one pull request each. Pull requests reach
`main` together, through a **candidate**: a branch that collects them, checked once
by the full CI and merged into `main` in one go. The candidate's prefix, its base and
the hotfix markers are `delivery.candidate` in
[`.agents/config.jsonc`](../../.agents/config.jsonc). Every merge, into the candidate or
into `main`, has a person's go: an agent never merges on its own.

## One pull request

1. **Draft.** A pull request opens as a draft, or at the final push. A draft runs no
   CI in the cloud ([CI](./ci.md)).
2. **Review on the machine.** The review runs on the local branch (the `decisions`
   skill in check mode, then the line-by-line pass), and fixes are local commits. The
   branch reaches GitHub when a review round finds nothing: every push is a full run.
3. **`pnpm ci:local` green** on the head about to be published, then one push, then
   `gh pr ready`. A red `ci:local` goes back into the review.
4. **On the candidate.** When the pull request is opened or marked ready, the candidate
   automation moves it onto the open candidate, creating one when none is open, and
   leaves a comment saying where it went. Marking it ready starts the minimal CI.
5. **Squash into the candidate**, with the review closed, `ci:local` and the minimal
   CI green, and the person's go. The squash message keeps the pull request's
   `Closes #N` lines.

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
- **Issues close on the candidate's merge.** GitHub ignores closing keywords in a pull
  request that targets a branch other than the default, and keywords the automation
  writes into the candidate's body link nothing. On the candidate's merge the
  automation closes, as completed, the open issues of its `Closes` lines. The squash
  messages are the safety net: their `Closes` lines reach `main` with the rebase, and
  GitHub closes issues from commits on the default branch.
- **Pull requests left behind** on a merged candidate move onto the next candidate,
  created for them. That covers both cases: still on the merged branch, or moved onto
  `main` by GitHub when it deletes the branch.
- **A red candidate.** Commits come out one at a time on a local copy until it is
  green, and the candidate branch is rewritten without the culprit's. That pull request
  stays listed as merged; its `Closes` becomes `Refs` and the matching line in the
  candidate's body is removed by hand. The fix comes in a new pull request.
- **When `main` moves** (a hotfix), the candidate rebases on `main` and `ci:local` runs
  again.

**Hotfixes** stay on `main`: a branch named with the hotfix prefix, or the hotfix
label, keeps the pull request on `main`, where it gets the full CI and merges on its
own. A pull request moved by mistake goes back with the label and
`gh pr edit <n> --base main`.

The automation runs from a terminal too: `pnpm exec lntt-ci candidate --pr <n>` does
what the workflow would do on that pull request's event (move it, rebuild a
candidate's lists, or close and carry over on a merged candidate), and `--dry-run`
prints the writes instead of making them.

## The candidate automation

`.github/workflows/candidate.yml` runs `lntt-ci candidate` (`@lntt/ci`) on three
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
     close issues). Metadata *read* comes with them. Nothing else: no approvals, no
     administration, no workflows.
   - **Webhook:** off. **Events:** none; the workflow brings the events.
   - **Where it can be installed:** only this account.
2. **Install it** on this repository only.
3. **Store its credentials** in the repository (Settings → Secrets and variables →
   Actions): the app's **Client ID** in the variable `CANDIDATE_APP_CLIENT_ID`, and a
   generated **private key** (the whole `.pem`) in the secret
   `CANDIDATE_APP_PRIVATE_KEY`.
4. **Repository settings:** rebase merge allowed (the candidate into `main`) and squash
   merge allowed (a pull request into the candidate). *Automatically delete head
   branches* may stay as it is: the automation finds the pull requests left behind
   either way.

## The Lunette plugin

A change under `plugins/lunette/` raises the version in its
`.claude-plugin/plugin.json`: installed copies update only when the version changes.
CI checks it on every pull request (`scripts/check-plugin-version.sh`).

## Releasing

npm publishing happens in CI only, never from a machine, with the one exception of a
new package's placeholder (below). One release publishes every
package of `packages/` that is not private, all at one version
([CLI runtime and publishing](../adr/cli-runtime-and-publishing.md)):

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
`--provenance`, no npm token), skipping a version npm already has.

**A dry run** is a pre-release: set a pre-release version on a branch
(`node scripts/packages-version.mts set X.Y.Z-rc.N`, commit, push), then
`gh release create vX.Y.Z-rc.N --prerelease --target <branch>`. The workflow runs every
check and `npm publish --dry-run`; nothing reaches npm. Delete the pre-release, its
tag and the branch afterwards.

Promoting a pre-release to a full release publishes nothing: the promotion fires
`released`, and the workflow runs on `published`. Release the version as its own tag.

**A new package** reaches npm by hand once, before the release that first carries it,
because npm configures a trusted publisher only on a package that exists:

1. Publish a `0.0.0` placeholder from the package directory, logged in to npm with
   publish rights on the `@lntt` scope:
   `npm version 0.0.0 --no-git-tag-version && npm publish --access public && git checkout package.json`.
   It is the only publish ever made from a machine
   ([CLI runtime and publishing](../adr/cli-runtime-and-publishing.md)); the version
   set by the release bump is untouched.
2. On the package's page on npmjs.com, Settings → Trusted publishing: repository
   `LunetteOrg/starter`, workflow `release.yml`, with **allow `npm publish`**
   ticked; a configuration created after 2026-09-03 otherwise allows only
   `npm stage publish`.
3. Run the CI release within two days: an unused trusted publisher configuration
   expires.

## Discarded directions

- **Publishing from a developer machine.** The token would live on a laptop, and
  nothing would check that the tests ran on the published code.
- **Release pull requests.** A version bump has nothing to review that CI does not
  already check.
- **GitHub's merge queue.** It is the mechanism built for this, and on a private
  repository it needs GitHub Enterprise Cloud.
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
- **A personal access token.** The writes would be one person's, with that person's
  rights on every repository they see, and they stop when the person leaves.
