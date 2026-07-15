# GitHub Project — board recipes

Runbook for the `github-board` skill. **Conventions are stable; concrete ids are not —
resolve them fresh.** Nothing here is hardcoded into a script.

## Discovery (run first)

```sh
OWNER=$(gh repo view --json owner --jq .owner.login)
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)

gh project list --owner "$OWNER" --format json
gh project field-list <PROJ_NUM> --owner "$OWNER" --format json   # field ids + option ids

# current iteration (pick startDate ≤ today < start+duration)
gh api graphql -f query='
{ organization(login:"'"$OWNER"'"){ projectV2(number:<N>){
    id field(name:"Iteration"){ ... on ProjectV2IterationField {
      id configuration{ iterations{ id title startDate } } } } } } }'

# native issue types — capture the GraphQL NODE ids (IT_…), not the REST numeric ids
gh api graphql -f query='{ organization(login:"'"$OWNER"'"){ issueTypes(first:20){ nodes{ id name } } } }'

gh label list -R "$REPO"
gh api "repos/$REPO/collaborators" --jq '.[].login'
```

## Track labels (derive, then create only the missing)

Decide the track set before creating issues — don't hardcode it (rationale in the skill's
[Track labels](../SKILL.md) section).

```sh
gh label list -R "$REPO" --json name --jq '.[].name'   # what exists — reuse, don't duplicate
ls -d apps/*/ 2>/dev/null | xargs -n1 basename         # one track candidate per app
# + cross-cutting areas the plan needs (infrastructure, design-system, docs) that no app owns
```

Propose `kebab-case` names + owners, confirm, then create **only** the new ones (color is
optional — omit for a random one):

```sh
gh label create "<track>" -R "$REPO" --description "<one-line scope>" --color <hex>
# Already present? Skip it. Do NOT --force (that overwrites color/description) and never rename.
```

## Materialize

Create with `gh issue create -R "$REPO" --title … --body … --assignee … -l <label>` (parse
the number from the URL); edit existing with `gh issue edit <N> …`. Then map node ids:

```sh
gh issue list -R "$REPO" --state all --limit 200 --json number,id   # number → node id
```

**Native issue type** — use the type's GraphQL **node id** (`IT_…`); the REST numeric id
fails with "Could not resolve to a node with the global id":

```sh
gh api graphql -f query='mutation($id:ID!,$t:ID!){
  updateIssue(input:{id:$id, issueTypeId:$t}){ issue{ number issueType{ name } } } }' \
  -f id=<ISSUE_NODE_ID> -f t=<TYPE_NODE_ID>
```

**Sub-issues** (link / unlink to a Feature):

```sh
gh api graphql -f query='mutation($p:ID!,$c:ID!){
  addSubIssue(input:{issueId:$p, subIssueId:$c}){ issue{ number } } }' \
  -f p=<PARENT_NODE_ID> -f c=<CHILD_NODE_ID>
# removeSubIssue(input:{issueId, subIssueId}) to detach. Check `parent` before re-parenting.
```

**Add to Project + set the current iteration** (Features: add, leave Iteration empty):

```sh
item=$(gh project item-add <N> --owner "$OWNER" --url <ISSUE_URL> --format json --jq .id)
gh project item-edit --project-id <PROJECT_NODE_ID> --id "$item" \
  --field-id <ITERATION_FIELD_ID> --iteration-id <CURRENT_ITERATION_ID>
# --clear instead of --iteration-id to unschedule (e.g. a Feature added by mistake).
```

`gh project item-list … --format json` may emit control chars in a title — parse with
`gh`'s built-in `--jq`, not a strict external JSON parser.

## Priority P0–P3 (bootstrap the options, then set)

The Priority field may exist with **no options**. Add them once (colors optional):

```sh
gh api graphql -f query='mutation($f:ID!){
  updateProjectV2Field(input:{ fieldId:$f, singleSelectOptions:[
    {name:"P0", color:RED,    description:"critical / unblocks the most"},
    {name:"P1", color:ORANGE, description:"high"},
    {name:"P2", color:YELLOW, description:"normal"},
    {name:"P3", color:GRAY,   description:"low"} ] }){
    projectV2Field{ ... on ProjectV2SingleSelectField { id options{ id name } } } } }' \
  -f f=<PRIORITY_FIELD_ID>
```

Set a priority on an item (resolve the option id from the mutation/field-list output):

```sh
gh project item-edit --project-id <PROJECT_NODE_ID> --id <ITEM_ID> \
  --field-id <PRIORITY_FIELD_ID> --single-select-option-id <PN_OPTION_ID>
```

## Issue-derived fields (Priority, Start date, Target date, Effort) — the silent trap

Some fields shown on the Project are **issue-level fields** (GitHub's native Issues
fields), not Project custom fields. On this board that's **Priority, Start date, Target
date, Effort**. `gh project item-edit` / `updateProjectV2ItemFieldValue` **fail on them**
— sometimes with `only custom fields can be updated`, sometimes **silently** (no error,
value not written). They must be set with **`updateIssueFieldValue`**, keyed by the
**IssueField id** (`IFD_…` date, `IFSS_…` single-select), not the `PVTF_…` Project field id.

```sh
# discover the IssueField ids (union type — use member fragments)
gh api graphql -f query='{organization(login:"'"$OWNER"'"){issueFields(first:40){nodes{
  ... on IssueFieldDate{id name} ... on IssueFieldSingleSelect{id name options{id name}} }}}}'

# set a DATE issue field on an issue (issueId is the ISSUE node id I_…, not the item id)
gh api graphql -f query='mutation($i:ID!,$f:ID!,$d:String!){
  updateIssueFieldValue(input:{issueId:$i, issueField:{fieldId:$f, dateValue:$d}}){issue{number}}}' \
  -f i=<ISSUE_NODE_ID> -f f=<IFD_ID> -f d=2026-07-28
# single-select (e.g. Priority): issueField:{fieldId:<IFSS_ID>, singleSelectOptionId:<OPT_ID>}
```
Reading back: `gh project item-list --jq '.["start date"]'` and `fieldValueByName` may show
null for these even when set — verify on the **issue** (`issue{ issueFieldValues }`) or in
the Roadmap UI, not via the Project item field value. A **custom** Project date/select
field (created with `gh project field-create`) is the opposite: settable with
`item-edit`, readable with `fieldValueByName` — use one if you need scriptable read-back.

## Dependencies

- **Hard** → native blocked-by:
  ```sh
  gh api graphql -f query='mutation($i:ID!,$b:ID!){
    addBlockedBy(input:{issueId:$i, blockingIssueId:$b}){ issue{ number } } }' \
    -f i=<BLOCKED_NODE_ID> -f b=<BLOCKING_NODE_ID>      # removeBlockedBy to undo
  ```
  Read back with `issue{ blockedBy(first:10){ nodes{ number } } blocking(first:10){ nodes{ number } } }`.
- **Soft / urgency** → set a **higher Priority** on the prerequisite (see above) and add a
  `**Soft:** #NN` cross-reference in the body's *Dipende da* section. Not a native blocker.

## Velocity (retroactive — for the `roadmap` skill)

Measure what actually completed, don't pre-estimate. For each **closed** iteration, count
the sub-issues that reached `Done` while assigned to it:

```sh
# closed iterations
gh api graphql -f query='{ organization(login:"'"$OWNER"'"){ projectV2(number:<N>){
  field(name:"Iteration"){ ... on ProjectV2IterationField {
    configuration{ completedIterations{ id title startDate } } } } } } }'
# throughput of one closed iteration = done sub-issues assigned to it
gh project item-list <N> --owner "$OWNER" --format json --jq \
  '[.items[] | select(.iteration.title=="<Iteration N>" and .status=="Done")] | length'
```
Optional effort weight per item (measured, not guessed): merged-PR count / commits / diff
size / days `In progress → Done`. Rolling-average the last few closed iterations; split per
track (label/assignee) when parallel tracks have different velocities. Feature timelines
(`Start date` / `Target date`) are then scheduled to that measured throughput.

## Verify

```sh
gh api graphql -f query='{ repository(owner:"'"$OWNER"'",name:"<repo>"){ issues(first:80,states:OPEN){ nodes{
  number title issueType{name} parent{number} subIssues{totalCount}
  blockedBy(first:10){nodes{number}} assignees(first:3){nodes{login}} } } } }'
# items in the current iteration must be sub-issues only (no Feature):
gh project item-list <N> --owner "$OWNER" --format json \
  --jq '[.items[] | select(.iteration.title=="<Iteration N>")] | length'
```
