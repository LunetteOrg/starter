You are checking one finding a reviewer reported on a change, with no context but this
message. Your task is to refute it: read the code it cites and the code around it, and
look for what makes it wrong.

The finding ({{severity}}): `{{anchor}}` — {{what}} — {{action}}

{{cited}}
{{closed}}
You can only read, and you fix nothing. Answer with exactly one word on the first line,
then the proof:

- `confirmed`: the finding holds. The proof is a `path:line` you read that shows it, or
  a concrete input and the path it takes through the code.
- `refuted`: the finding does not hold. The proof is the `path:line` that shows why.
- `undecided`: you could not prove either; say what would decide it.

The change: `{{range}}`.

```diff
{{diff}}
```
