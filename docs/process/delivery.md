# Delivery: how a change reaches `main` and npm

Trunk-based: a short-lived branch per change, one pull request each, merged into
`main` once CI is green and the review (the `decisions` skill in check mode, then the
line-by-line pass) is done. A merge always has a person's go.

## The Lunette plugin

A change under `plugins/lunette/` raises the version in its
`.claude-plugin/plugin.json`: installed copies update only when the version changes.
CI checks it on every pull request (`scripts/check-plugin-version.sh`).

## Releasing

npm publishing happens in CI only, never from a machine. One release publishes every
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

**A new package** needs its trusted publisher on npmjs.com (this repository, workflow
`release.yml`) before the release that first publishes it, or its publish fails.

## Discarded directions

- **Publishing from a developer machine.** The token would live on a laptop, and
  nothing would check that the tests ran on the published code.
- **Release pull requests.** A version bump has nothing to review that CI does not
  already check.
