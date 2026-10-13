# @lntt/project-config

Reads, validates and edits a Lunette project's configuration: the values skills and
scripts need, in `.agents/config.jsonc` **or** `.agents/config.yml` at the repository
root (one of the two; both is an error). Sections are named after process areas
(`recording` today); [`schema/config.schema.json`](./schema/config.schema.json) says
what each one holds.

Both formats allow comments: a short reason for a value goes next to it. So scripts
never parse the file themselves (`jq` and `JSON.parse` reject comments), and writes go
through an editor that keeps them.

```sh
lntt-config path                       # the file in use
lntt-config validate                   # exit 0 when it matches the schema
lntt-config get recording.logs         # a dotted key, as plain JSON (pipe it to jq)
lntt-config set recording.language '"it"'   # a JSON value, comments kept
```

Exit codes: 0 ok, 1 configuration error, 2 usage error.

Editors validate the file against the schema through its first line:

```jsonc
{ "$schema": "<path or URL of config.schema.json>", … }
```

```yaml
# yaml-language-server: $schema=<path or URL of config.schema.json>
```

The package is private and runs from source on Node ≥ 24 until it is published with
the other shared packages.
