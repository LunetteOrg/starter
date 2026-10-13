---
name: commit-message
description: Write the commit message for a change in a Lunette project — conventional type and scope, subject and body in the project's language, trailers — from `delivery.commits` in `.agents/config.jsonc`. Use before every commit, and whenever commitlint rejects a message (its errors name this skill).
---

# Commit message

The rules come from two places that agree by construction: `delivery.commits` in the
project configuration, and commitlint, which reads the same values. This skill is the
procedure; never edit it to fit one project.

## 1. Read the rules

```sh
lntt-config get delivery.commits    # or: pnpm exec lntt-config get delivery.commits
```

`language`, `scopes` (when listed, the only ones allowed), `maxLineLength` (default
100) and `longTrailers` (trailers exempt from the line limit). A missing section
means the defaults: conventional commits, any scope, 100 characters.

## 2. Write it

```
<type>(<scope>): <subject>

<body: what changed and why, wrapped at maxLineLength>

<trailers>
```

- **Type**: `feat` (new capability), `fix` (a defect), `docs`, `refactor`, `test`,
  `ci`, `chore`. A pure rename gets its own commit, so history follows the file.
- **Scope**: the area the change lives in, from `scopes` when the project lists them;
  omit it when the change spans several.
- **Subject**: imperative, in the configured language, lower case first, unless the
  first word is an identifier or a file name (`AGENTS.md`, `MAX_RETRIES`); a proper
  noun goes between backticks. No em or en dash. No trailing period.
- **Body**: the why and what a reviewer cannot see in the diff. State what holds now.
- **Trailers**: `Closes #N` for the issue the commit completes, `Refs #N` otherwise.
  A trailer listed in `longTrailers` (such as `Retro:`, a sentence about friction met
  during the work) may run past the line limit. **No attribution trailers**
  (`Co-Authored-By:`, "Generated with …"): messages stay clean.

## 3. When commitlint rejects it

The error names the rule and says what to write instead. Fix that line and commit
again; never bypass the hook with `--no-verify`. A rule that seems wrong for the
project is a change to `delivery.commits`, proposed to the person, not a workaround.
