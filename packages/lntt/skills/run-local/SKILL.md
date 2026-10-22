---
name: run-local
description: Start a Lunette project's app locally, reach it, sign in with a seeded user, check a change with requests and in a browser, and stop what was started — on the worktree's own port. Reads `local` from `.agents/config.*`. Use when asked to run, preview or try the app, to check a change in the real app rather than in tests, to take a screenshot, or to prove a property of cloud infrastructure that no test covers (on a throwaway twin).
---

# Run local

The values are the project's: `local` in `.agents/config.*` (apps, commands, base
ports, sign-in pointers, seeded users). The project's own mechanisms, such as where a
one-time code appears or which log lines are noise, are in `docs/process/local.md`.
This skill is the procedure; never edit it to fit one project.

## 1. Anchor and read

- Work from the worktree root: `git rev-parse --show-toplevel`. A command run from the
  shared main checkout starts the wrong tree.
- `lntt get local` (or `pnpm exec lntt get local`). **No `local`
  section:** stop and propose one (the apps you can see, their dev commands and ports);
  never guess and carry on.
- `lntt local app <name>` gives the app **resolved for this worktree**: its
  port (base port in the main checkout, base + 10 × a stable slot in a linked worktree),
  URL, commands and env with `{port}` filled in. Always start from it, never from the
  base values.
- Read `docs/process/local.md` when it exists, and the app's `signIn.doc`.

## 2. Prepare

- **Untracked files** a worktree lacks (`.env`): copy them from the main checkout
  (`git rev-parse --git-common-dir` names its `.git`), or from `.env.example`. Never
  print their content.
- **Infrastructure**: run `local.infra.check`. If it answers, reuse it as it is: it is
  shared with other checkouts, never restart or stop it. If not, `local.infra.up`.

## 3. Start and wait

- Is something already on the app's port? (`lsof -iTCP:<port> -sTCP:LISTEN`.) If it is
  this worktree's app, reuse it; otherwise stop and say which process holds the port.
- Run `commands.start.run` from the worktree root, **in the background**, with the
  app's `env` exported, and keep its output in a log file you can search.
- Poll `<url><readyPath>` until it answers or a timeout; on timeout, read the log
  before saying anything.

## 4. Sign in

- `signIn.test` first: run it, or reuse the state it saves (a Playwright storage
  state, for example), or read it to follow its steps. `signIn.doc` covers what the
  test cannot say.
- Use the `users` the configuration lists; never invent credentials, and never write
  a secret into a file or a message.

## 5. Check

- **Requests**: `curl -v` and read what was sent as well as what came back. Write
  every header out in full (`-H "Accept-Language: en-US"`); a header built from a
  shell expansion is not split in zsh and is silently dropped. Before concluding the
  server ignores a header or a cookie, confirm with `-v` that it was sent.
- **Showing a page to the person**: `lntt viewer open <url>`. It detects where
  the session runs (Orca, Wave, Claude desktop, a terminal) and opens the page in the
  operator's preferred viewer (`workspace.viewers` in the operator profile), in this
  worktree when the viewer belongs to one. **Exit 3** prints a JSON with `call`: the
  viewer is a tool only you can use (`preview_start` in Claude desktop, `navigate` in
  Chrome); make that one call with the URL.
- **Checking a page yourself**: a browser tool you have (Playwright, Chrome), or
  `playwright screenshot <url> <file>` and look at the file.

## 6. Infrastructure no test can cover

Skip this section unless the change rests on a property of a cloud resource (a storage
lock that refuses overwrite and delete, a CDN purge that refreshes a mirror). Such a
property is proved by one live check, not by a test, and never against the production
resource.

- **A throwaway twin.** Declare it in the project's infrastructure as code: the same
  region or jurisdiction and prefixes, a short-lived variant of what makes the check
  destructive (a 24-hour lock instead of an indefinite one), its own hostname under the
  same cache rule. On the production resource only read its configuration.
- **Temporary credentials:** created by the person, scoped to the twin, with a short
  expiry; kept in a `700` folder outside the repo (not `/tmp`, lost on reboot); loaded with
  `set -a; . <file>; set +a` and never printed; revoked as soon as their step is done.
  With some dashboards the expiry date also sets the start date: a token made "until
  <date>" is valid only *from* it, answers `401`, and its verify endpoint still says
  active. The host may refuse to let you write credentials to disk: the person writes the
  file with a one-line `!` command that reads `pbpaste` and prints only the value's length.
- **Removing a lock from the infrastructure code may not remove the lock.** With some
  providers, destroying the lock resource only drops it from state: empty the bucket after
  the lock age, then destroy the bucket. Read the provider's behaviour before the plan.
- **Remove the twin after the check.** The decision record keeps one sentence of proof
  (date, outcome, issue) and the trigger to recreate it.

## 7. Stop and report

- Stop what you started, and only that. Leave shared infrastructure running.
- Report what was checked with its proof: the command and its outcome, the URL and
  port, the screenshot path. What was not run is written as not run.
