---
name: retrospective
description: Continuous self-improvement loop. Capture friction during work (commit `Retro:` trailers + sub-agent returns), absorb it into the PR body's Retrospective block at PR-creation time (squash-safe), and periodically harvest all merged PR bodies to cluster signals and propose concrete agentic mechanisms (new skill, Lefthook hook, CI check, ADR, CLAUDE.md rule). Use when opening a PR (to fill the block) or when running the periodic retrospective to find and act on improvement signals.
---

# Retrospective — self-improvement loop

Turn the friction hit while doing the work into concrete tooling improvements, without
losing signals across many agents, a different PR author, or a squash-merge. Three stages.

## 1. Capture (during the work)

- **Commit trailer** — when an agent (or person) hits friction, add a trailer to that commit:
  ```
  Retro: <what was harder than it should be / what a hook·skill·agent could automate>
  ```
  Granular and attributed to whoever made the commit. Survives many agents. *Squash
  collapses commits*, so this is a capture aid, **not** the durable store (see stage 2).
- **Sub-agent convention** — a sub-agent must return any friction / automation-opportunity
  in its final message; the orchestrator writes it into a `Retro:` trailer (or straight
  into the PR block). This is how work done by N agents still reaches the retrospective.

## 2. Absorb (at PR creation — the durable step)

The **PR body is the durable, squash-safe store.** When opening a PR, collect the signals
and write them into the body's Retrospective block (from `.github/pull_request_template.md`),
between the markers:

```sh
BASE=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)
git log "origin/$BASE..HEAD" --format='%b' | grep -i '^Retro:' | sed 's/^[Rr]etro:/-/'
```
Fold those lines — plus any friction sub-agents returned this session — into the block:

```markdown
## 🔁 Retrospective
<!-- retro:start -->
- **Friction:** …
- **To automate (hook/skill/agent):** …
- **Rule rediscovered (→ ADR/CLAUDE.md):** …
- **Rework cause:** …
<!-- retro:end -->
```
Use `none` where a line truly doesn't apply — never leave the block as the raw
placeholder. **An agent opening a PR always does this** (per `CLAUDE.md`). If signals only
surface after review, add them as a PR **comment** containing the same marker block — the
harvest reads comments too.

## 3. Harvest (periodic — the retrospective)

Analyse **PR bodies** (durable across squash), not commit history:

```sh
# window: since a date, the current iteration start, or the last retrospective issue
gh pr list -R <repo> --state merged --search "merged:>=<YYYY-MM-DD>" \
  --json number,title,url,body,mergedAt --limit 200
# plus PR comments that carry a retro block, if used:
# gh pr view <n> --json comments
```
For each body, extract the text between `<!-- retro:start -->` and `<!-- retro:end -->`
(deterministic; ignore `none`). Then:

1. **Cluster** signals by theme; weight by frequency and by rework cost.
2. For each cluster **propose one concrete mechanism** — a new or updated skill, a Lefthook
   hook, a CI check, an ADR, or a `CLAUDE.md` rule — citing the source PRs.
3. **Output** a ranked report, or open an issue titled `Retrospective — <window>` on the
   board (via `github-board`) with the proposals as a checklist.

Adopted proposals become their own PRs (each with its own Retrospective block) — the loop
feeds itself. This skill is report-only until the user picks what to build.

## Guardrails

- The PR body is the source of truth; commit trailers are a capture aid (squash-safe rule).
- Harvest is **report-only** — propose mechanisms, let the user choose; don't create skills
  or hooks unprompted.
- Keep the marker block exactly as `<!-- retro:start -->` … `<!-- retro:end -->` so
  extraction and any CI check stay trivial.
