# Delivery: how a change reaches `main` and npm

Trunk-based: a short-lived branch per change, one pull request each, merged into
`main` once CI is green and the review (the `decisions` skill in check mode, then the
line-by-line pass) is done. A merge always has a person's go.

## The Lunette plugin

A change under `plugins/lunette/` raises the version in its
`.claude-plugin/plugin.json`: installed copies update only when the version changes.
CI checks it on every pull request (`scripts/check-plugin-version.sh`).

## Releasing

npm publishing happens in CI only, never from a machine:

1. Bump `packages/create/package.json` and commit `chore(release): @lntt/create X.Y.Z`
   directly on `main`; a release does not go through a pull request.
2. `gh release create vX.Y.Z --generate-notes`. The tag matches the package version,
   and every release ships the generated notes (the merged pull requests since the
   previous tag).
3. Add by hand what the generator misses: it lists merged pull requests only, so a
   user-facing change that landed as a direct commit (`git log vPREV..vX.Y.Z
   --no-merges`) goes in with `gh release edit vX.Y.Z --notes …`. The release bump
   and repo-internal commits stay out.

Publishing the GitHub Release starts `.github/workflows/release.yml`: it runs the
tests, checks that the tag matches the package version, and publishes through npm
trusted publishing (OIDC, `--provenance`, no npm token).

## Discarded directions

- **Publishing from a developer machine.** The token would live on a laptop, and
  nothing would check that the tests ran on the published code.
- **Release pull requests.** A version bump has nothing to review that CI does not
  already check.
