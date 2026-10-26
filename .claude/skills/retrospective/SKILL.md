---
name: retrospective
description: Carry the friction met while working to where it gets fixed — a `Retro:` trailer on the commit, the retrospective block of the pull request body (between `<!-- retro:start -->` and `<!-- retro:end -->`), the candidate's retrospective comment for the batch's friction (`lntt retro add`), a harvest of the merged pull requests' blocks into proposals, published where `cycle.retrospective` says, and the friction that comes from Lunette itself (items marked `[lunette]`) reported upstream with `lntt dump` and `lntt issue`, on the operator's approval. Use when opening a pull request (to fill the block), before marking one ready (`lntt check body`), when an orchestrator or a coordinator meets friction that belongs to the batch or squashes into the candidate, and when a theme or a release ends (the harvest and the upstream reports).
---
<!-- installed by lntt sync from @lntt/lntt: edit the skill in the package, not this stub -->

The guide of this skill comes with the project's `lntt`, at its version. Before acting,
load it and follow it:

```sh
pnpm exec lntt guide retrospective
```
