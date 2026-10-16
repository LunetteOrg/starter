---
name: issues
description: Manage GitHub issues with gh — triage them into release milestones and a P0–P3 priority field on a GitHub Project (v2). Discovers the repo/owner/project at runtime (never hardcoded) and bootstraps the structure if missing. Use when asked to create, write or retitle, triage, prioritize, or organize issues, plan a release/iteration, or set up the issue board.
metadata:
  internal: true # the starter's own board tooling, not part of the Lunette plugin
---

# Issue management & triage

Organize GitHub issues with the `gh` CLI following the template's convention:

- **Milestones = releases/versions** (e.g. `v0.1`, `v0.2`). Each issue targets at
  most one release milestone.
- **Priority = `P0`–`P3`**, stored as a **single-select field on a GitHub
  Project (v2)** (`P0` = critical … `P3` = low).
- **Status** lives on the Project board (Todo/In Progress/Done — the default
  fields of a new Project v2).

## Titles

A title is read on the board, in a milestone, in a list: without the body. Write it
so that the list is enough.

- **Unambiguous: a problem found, or a change to make.** Either is fine:
  "Delivery process: three gaps found while releasing 0.6.0", "Turn Ryuk back on".
  A present-tense statement that reads both as how things are and as how they
  should become is not: "Issue titles are unambiguous" (are they now, or must they
  be made so?). A title that names a problem without listing it is acceptable for a
  group of small fixes; the body lists them.
- **Ideally actionable and measurable.** An action verb, then the observable result
  that closes the issue: "Turn Ryuk back on, so a killed run cleans up after
  itself". A user story ("As a …, I want …") helps while it stays short; it is not
  required.
- **In conversation, never the number alone.** Name an issue by its title, or after
  describing it in the same message: a bare `#81` says nothing to whoever reads it.

This skill mutates GitHub (creates milestones/projects/fields, edits issues), so
it works against a PR/board the user owns. **Always show the plan and confirm
before any create/edit that isn't a single explicit request**, and never create
an org/user-level Project or field without explicit confirmation.

## Stay generic — discover, don't hardcode

This skill ships in a template; other repos are bootstrapped from it. Never bake
in a repo, owner, or project ID. Resolve everything at runtime:

```sh
# current repo + owner (works in any clone)
gh repo view --json nameWithOwner,owner,name
OWNER=$(gh repo view --json owner --jq .owner.login)
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
```

## Discovery & bootstrap

1. **Milestones (releases).** List, then create on request:
   ```sh
   gh api "repos/$REPO/milestones?state=all" --jq '.[] | {title,state,due_on}'
   # create (confirm first):
   gh api "repos/$REPO/milestones" -f title="v0.1" -f state=open \
     -f description="…"   # optional: -f due_on=YYYY-MM-DDT00:00:00Z
   ```

2. **Project (v2).** Find a project owned by `$OWNER`; pick the one the user
   means (ask if several). Inspect its fields:
   ```sh
   gh project list --owner "$OWNER" --format json
   gh project field-list <NUMBER> --owner "$OWNER" --format json
   ```
   If there is no suitable project, or it lacks a `Priority` field, propose
   creating them (confirm first):
   ```sh
   gh project create --owner "$OWNER" --title "<repo> board"
   # Priority field — single-select P0..P3 (gh can create SINGLE_SELECT fields):
   gh project field-create <NUMBER> --owner "$OWNER" \
     --name "Priority" --data-type SINGLE_SELECT \
     --single-select-options "P0,P1,P2,P3"
   ```
   Note: **Iteration fields cannot be created via `gh`** (GraphQL/web-UI only).
   Iterations are out of scope here; milestones cover release planning. If the
   user wants an Iteration field, point them to the web UI and then read it back.

## Triage workflow (per issue or batch)

For each issue being triaged:

1. Set the **release milestone**: `gh issue edit <N> -R "$REPO" --milestone "v0.1"`.
2. Add it to the **Project**: `gh project item-add <NUMBER> --owner "$OWNER" --url <issue-url>`.
3. Set **Priority**. This needs IDs resolved from JSON (no name-based shortcut):
   ```sh
   # project id + Priority field id + option ids
   gh project field-list <NUMBER> --owner "$OWNER" --format json   # → field id, options[].id
   gh project item-list  <NUMBER> --owner "$OWNER" --format json   # → item id for the issue
   gh project item-edit --project-id <PROJECT_ID> --id <ITEM_ID> \
     --field-id <PRIORITY_FIELD_ID> --single-select-option-id <P1_OPTION_ID>
   ```
4. Optionally set labels (use existing repo labels; create only on request).

Batch: resolve the field/option IDs once, then loop the issues.

## Other actions

- **Create + triage** a new issue in one go:
  `gh issue create -R "$REPO" --title … --body … --milestone …`, then add to the
  project and set Priority as above.
- **Organize / report.** Group open issues by milestone and priority; surface
  **untriaged** ones (no milestone, or not on the board, or no Priority set).
  Read with `gh issue list -R "$REPO" --json number,title,milestone,labels` and
  the project item-list for Priority. Report-only unless asked to act.
- **Plan a release.** Show what's in a milestone, what's unprioritized, and what
  P0/P1 work is still open.

## Guardrails

- Confirm before creating milestones, projects, or fields — these are outward and
  awkward to undo. Per-issue edits to an explicit single issue need no extra ask.
- If `gh` isn't authenticated (`gh auth status`), stop and tell the user.
- Resolve IDs fresh each run; never cache a project/field/option ID into this
  file or assume one from another repo.
- Respect existing structure: if the project already has a differently-named
  priority field or milestone scheme, surface it and ask before diverging.
