# GitHub Project — recipes

The commands behind the `github-board` skill. The names come from `lntt get board`;
the ids are resolved here, at runtime, and never written down. `<…>` is a value to fill
in: a name from the configuration, or an id resolved above it.

## Discovery

```sh
OWNER=$(lntt get board.project.owner | jq -r .)
NUMBER=$(lntt get board.project.number)
# organization, unless board.project.ownerType says user: GraphQL's root field differs
ROOT=$( (lntt get board.project.ownerType 2>/dev/null || echo '"organization"') | jq -r .)
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)

# the Project's node id, its fields with their ids and options: once per session
gh api graphql -f query='{ '"$ROOT"'(login:"'"$OWNER"'"){ projectV2(number:'"$NUMBER"'){ id title
  fields(first:50){ nodes{
    ... on ProjectV2FieldCommon{ id name dataType }
    ... on ProjectV2SingleSelectField{ options{ id name } }
    ... on ProjectV2IterationField{ configuration{ duration startDay
      iterations{ id title startDate duration } completedIterations{ id title startDate duration } } } } } } } }'
```

Match each configured field by its `name` (`lntt get board.fields`) and keep the ids in
variables. A configured field missing from the Project, or an option missing from a
field, is a mismatch to report to the person, never one to fix silently. The current
iteration is the one with `startDate ≤ today < startDate + duration`.

Issue types and issue fields belong to an organization: a Project owned by a user has
neither, and a configuration that names them for one is a mismatch to report.

```sh
# issue types (when board.issueTypes): the GraphQL node ids, IT_…, not the REST numbers
gh api graphql -f query='{ organization(login:"'"$OWNER"'"){ issueTypes(first:25){ nodes{ id name } } } }'

# fields of kind issue: the organization's issue fields, IFD_… (date), IFSS_… (single select)
gh api graphql -f query='{ organization(login:"'"$OWNER"'"){ issueFields(first:40){ nodes{
  ... on IssueFieldDate{ id name } ... on IssueFieldSingleSelect{ id name options{ id name } } } } } }'

gh label list -R "$REPO" --limit 200 --json name,description
gh api "repos/$REPO/collaborators" --jq '.[].login'
```

An organization may also have an *issue* field with the same name as a *Project* field
(a `Priority` of both kinds). The configured `kind` says which one is the board's; the
other is read by nothing.

## Cost

Projects v2 is GraphQL only. The budget is 5000 points an hour per user, shared by every
session and agent using the token. A query costs by the nodes it could return (full
pages assumed, divided by 100):

| command | points |
| --- | --- |
| `gh project item-list --limit 500` | ~500 |
| `gh project item-list --limit 100` | ~100 |
| `gh project field-list`, or the fields query above | ~100 |
| a query aimed at one issue or one item | 1 |
| `gh issue create` / `edit` / `view`, a field mutation | 1 |

`gh api rate_limit --jq .resources` shows the buckets apart (`core` for REST,
`graphql`): a `graphql` at zero with `core` full is an item list or a field list in a
loop.

### The item id of one issue

```sh
gh api graphql -f query='{ repository(owner:"<owner>",name:"<repo>"){
  issue(number:<N>){ id projectItems(first:5){ nodes{ id project{ number } } } } } }' \
  --jq '.data.repository.issue'
```

### Reading one item back

```sh
gh api graphql -f query='{ node(id:"<ITEM_ID>"){ ... on ProjectV2Item{
  f1: fieldValueByName(name:"<a single select field name>"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } }
  f2: fieldValueByName(name:"<the iteration field name>"){ ... on ProjectV2ItemFieldIterationValue{ title } }
  content{ ... on Issue{ number issueType{ name } parent{ number } milestone{ title }
    labels(first:5){ nodes{ name } } assignees(first:3){ nodes{ login } } } } } } }' --jq .data.node
```

A field of `kind: issue` reads back `null` here even when set: read it on the issue
(`issue{ issueFieldValues(first:20){ … } }`).

## Create and edit issues

```sh
gh issue create -R "$REPO" --title "<title>" --body-file body.md \
  --label "<track>" --assignee "<owner>" --milestone "<milestone>"   # each flag only when configured
gh issue list -R "$REPO" --state all --limit <sized> --json number,id   # number → node id I_…
```

Set the issue type with the type's node id (the REST number fails with *Could not
resolve to a node with the global id*):

```sh
gh api graphql -f query='mutation($id:ID!,$t:ID!){
  updateIssue(input:{id:$id, issueTypeId:$t}){ issue{ number issueType{ name } } } }' \
  -f id=<ISSUE_NODE_ID> -f t=<TYPE_NODE_ID>
```

Link a child to its parent (`board.subIssues`), check its `parent` before re-parenting:

```sh
gh api graphql -f query='mutation($p:ID!,$c:ID!){
  addSubIssue(input:{issueId:$p, subIssueId:$c}){ issue{ number } } }' \
  -f p=<PARENT_NODE_ID> -f c=<CHILD_NODE_ID>
# removeSubIssue(input:{issueId, subIssueId}) detaches it
```

Milestones (`board.milestones`):

```sh
gh api "repos/$REPO/milestones?state=all" --jq '.[] | {title,state,due_on}'
gh api "repos/$REPO/milestones" -f title="<title>" -f state=open   # only with the person's go
```

## REST: a separate budget, and fewer steps

`gh issue create` and `edit` go through GraphQL; the REST endpoints do the same work on
the `core` bucket, which has 5000 points of its own: the way to finish an operation when
GraphQL is spent. Some take one step instead of two:

```sh
# create with the type at once
gh api "repos/$REPO/issues" -X POST -f title="<title>" -F body=@body.md \
  -f 'labels[]=<track>' -f type=<type name> --jq '"#\(.number) \(.type.name)"'
# change the type, by name
gh api "repos/$REPO/issues/<N>" -X PATCH -f type=<type name>
# link a child: the child's numeric id, not its number
child=$(gh api "repos/$REPO/issues/<CHILD>" --jq .id)
gh api "repos/$REPO/issues/<PARENT>/sub_issues" -X POST -F sub_issue_id="$child"
```

The Project's fields have no REST endpoint.

## Project fields

```sh
item=$(gh project item-add "$NUMBER" --owner "$OWNER" --url <ISSUE_URL> --format json --jq .id)
# a single select
gh project item-edit --project-id <PROJECT_NODE_ID> --id "$item" \
  --field-id <FIELD_ID> --single-select-option-id <OPTION_ID>
# the iteration
gh project item-edit --project-id <PROJECT_NODE_ID> --id "$item" \
  --field-id <ITERATION_FIELD_ID> --iteration-id <ITERATION_ID>
# a date, a number, a text: --date, --number, --text; --clear empties the field
```

`item-add` fails as a duplicate when an organization workflow already added the issue:
take the item id from the issue instead. `gh project item-list --format json` may carry
control characters in a title: filter with `gh`'s own `--jq`, not a strict JSON parser.

### Issue fields

A field of `kind: issue` belongs to the organization's issues: `item-edit` and
`updateProjectV2ItemFieldValue` fail on it, sometimes with *only custom fields can be
updated*, sometimes silently. Write it on the issue (the issue's node id, `I_…`):

```sh
gh api graphql -f query='mutation($i:ID!,$f:ID!,$d:String!){
  updateIssueFieldValue(input:{issueId:$i, issueField:{fieldId:$f, dateValue:$d}}){ issue{ number } } }' \
  -f i=<ISSUE_NODE_ID> -f f=<IFD_ID> -f d=<YYYY-MM-DD>
# a single select: issueField:{fieldId:<IFSS_ID>, singleSelectOptionId:<OPTION_ID>}
```

## Changing a field's options

`updateProjectV2Field` **rewrites the whole option set and regenerates every id**: each
item that had a value in the field loses it, on every repository the Project holds.
Passing the same names again does not help: the link is the id.

- Add an option from the Project's web UI (the field's menu, *Edit*): it keeps the ids.
- A **new** field (`gh project field-create`) touches no existing value: a new exclusive
  dimension belongs in a new field.
- A field with **no options yet** can be given its options with the mutation, after the
  person confirms them and they are in the configuration.
- To use the mutation on a field in use anyway, with the person's go: save every item's
  value first, run it, then write the values back in batches against the new ids.

```sh
gh project item-list "$NUMBER" --owner "$OWNER" --limit <sized> --format json \
  --jq '.items[] | select(.<field key> != null) | [.id, .<field key>] | @tsv' > before.tsv
gh api graphql -f query='mutation($f:ID!){ updateProjectV2Field(input:{ fieldId:$f,
  singleSelectOptions:[ {name:"<existing>", color:GRAY, description:""}, {name:"<new>", color:BLUE, description:""} ] }){
  projectV2Field{ ... on ProjectV2SingleSelectField{ options{ id name } } } } }' -f f=<FIELD_ID>
```

The option names are the configuration's (`board.fields.<key>.options`), in its order.
An iteration field's iterations are added from the Project's settings by hand, for the
same reason.

## Writing in bulk

- **About 20 aliased mutations per call**: 80 return *Resource limits for this query
  exceeded*.
- **About 1.2 s between mutating calls**: the secondary rate limit does not show in
  `rate_limit`; 114 labels in a loop with no pause applied 5, with `sleep 1.2` all 114.
- **Count the outcomes**: with `--silent` a failure is invisible, and a failed alias
  still has its key, with `null`: count the non-null ones.

```sh
# writes.tsv: itemId<TAB>fieldId<TAB>optionId
split -l 20 writes.tsv chunk_
for c in chunk_*; do
  awk -v proj="<PROJECT_NODE_ID>" 'BEGIN{print "mutation {"}
    { printf "  m%d: updateProjectV2ItemFieldValue(input:{projectId:\"%s\", itemId:\"%s\", fieldId:\"%s\", value:{singleSelectOptionId:\"%s\"}}){ projectV2Item{ id } }\n", NR, proj, $1, $2, $3 }
    END{print "}"}' FS='\t' "$c" > "$c.graphql"
  # must print the chunk's line count and no error: a failed alias comes back null
  gh api graphql -F query=@"$c.graphql" --jq '[(.data // {})[] | select(. != null)] | length, (.errors // [] | .[].message)'
  sleep 1.2
done
```

`clearProjectV2ItemFieldValue(input:{projectId, itemId, fieldId})` empties a field and
aliases the same way.

## Dependencies

With `board.blockedBy`:

```sh
gh api graphql -f query='mutation($i:ID!,$b:ID!){
  addBlockedBy(input:{issueId:$i, blockingIssueId:$b}){ issue{ number } } }' \
  -f i=<BLOCKED_NODE_ID> -f b=<BLOCKING_NODE_ID>      # removeBlockedBy undoes it
# read back: the field is blockedBy (blockedByIssues does not exist)
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){
  issue(number:$n){ blockedBy(first:10){ nodes{ number state } } blocking(first:10){ nodes{ number state } } } } }' \
  -f o=<owner> -f r=<repo> -F n=<N>
```

The iteration of every open issue and of its blockers, in one paginated query (an issue
has one item per Project: take the item whose project number is `board.project.number`).
`--paginate` needs the variable named `$endCursor` and prints one document per page:

```sh
gh api graphql --paginate -f query='query($endCursor:String){ repository(owner:"<owner>",name:"<repo>"){
  issues(first:100,states:OPEN,after:$endCursor){ pageInfo{ endCursor hasNextPage } nodes{ number
    projectItems(first:3){ nodes{ project{ number } it: fieldValueByName(name:"<the iteration field name>"){
      ... on ProjectV2ItemFieldIterationValue{ title startDate } } } }
    blockedBy(first:10){ nodes{ number state projectItems(first:3){ nodes{ project{ number }
      it: fieldValueByName(name:"<the iteration field name>"){ ... on ProjectV2ItemFieldIterationValue{ title startDate } } } } } } } } } }' \
  | jq -s .
```

## Velocity

For the `roadmap` skill: what closed, measured, never estimated ahead.

```sh
# the closed iterations: from the fields query of Discovery, completedIterations
# the children done in one of them: a full read, paid once for every iteration
gh project item-list "$NUMBER" --owner "$OWNER" --format json --limit <sized> \
  --jq '[.items[] | select(.<iteration key>.title=="<iteration title>" and .status=="<status done role>")] | length'
```

`item-list` names a field's JSON key after the field's GitHub name in lower case
(`.iteration`, `.status`, `."start date"`). Read the list once and count every closed
iteration from the saved file.

## Views

Projects v2 has no API to create or edit a saved view: the filters are prepared, and a
person creates the view in the UI. With *Show hierarchy* on, an item sits in the group
of its root ancestor, so a view of children by iteration keeps hierarchy off. The
Project's built-in workflows (auto-add, the status on close, on a linked pull request)
are listed by the API (`workflows{ name enabled }`) but their values are read in the UI.

## Check the structure

```sh
gh api graphql -f query='{ repository(owner:"<owner>",name:"<repo>"){ issues(first:100,states:OPEN){ nodes{
  number title issueType{ name } parent{ number } subIssues{ totalCount }
  blockedBy(first:10){ nodes{ number } } assignees(first:3){ nodes{ login } } } } } }'
```

Every issue has a type (when `issueTypes`), every child a parent (when `subIssues`), and
no parent sits in an iteration.
