#!/usr/bin/env node
// lntt — a Lunette project's configuration, its agent files and its CI, from the
// command line.
//
//   lntt path                 the configuration file in use
//   lntt validate             exit 0 when the file matches the schema
//   lntt get <key>            the value at a dotted key, as plain JSON
//   lntt set <key> <json>     set a dotted key, keeping the comments
//   lntt operator             the operator profile, merged, as plain JSON
//   lntt operator get <key>   one key of it
//   lntt operator sources     the files it was read from, in merge order
//   lntt sync                 write the managed block of AGENTS.md and the stubs of the shared
//                             skills in .agents/skills/ and .claude/skills/
//   lntt guide [<skill>]      a shared skill's guide, from this package; alone, the skills
//   lntt local app <name>     an app of local.apps, resolved for this worktree (port, url, commands)
//   lntt viewer detect        where the session runs and which viewer shows pages, with why
//   lntt viewer open <url>    open it there; exit 3 with the agent call when only the agent can
//   lntt browser [<app>] [--json]
//                             how an agent drives a browser on the app of local.apps in this
//                             worktree: the driver, why, and each operation as a shell
//                             command or a tool call; <app> may be omitted when there is one
//
//   lntt board sync [--apply | --check]
//                             the GitHub Project and the organization's issue types brought to
//                             the board section: missing fields, options and types added,
//                             colors and descriptions set, case-only renames made; what the
//                             API cannot do or is risky listed for the UI, with the steps.
//                             A dry run unless --apply; --check exits 1 when the board differs
//
//   lntt refs [--cached] [<text>...]
//                             the issue and pull request references of the text (the arguments,
//                             else stdin) with their titles, from gh, cached for a day: one JSON
//                             object (repository, mentions with their positions, refs);
//                             --cached asks gh for no issue
//
//   lntt check [<area> [<check>]] [--base <ref>] [--json]
//                             what is checked without judgement, one area per review lens;
//                             alone, every area. Each check says PASS, FAIL or NOT RUN with
//                             its reason (INFO: printed, neither); exit 1 on a FAIL.
//                             --json: one line per result (area, check, status, path, line,
//                             message); --base: what the diff from the ref touches
//     agents-md               the managed block of AGENTS.md matches its source
//     skills                  every shared skill has its stub in .agents/skills/ and
//                             .claude/skills/, unedited, and no stub names a skill gone
//     decisions [structure]   the logs of recording: index and files both ways, references
//                             to records, append-only residues, file name, title, status;
//                             with --base, the diff inventory and the touched records' figures
//     decisions numbers [<file>...]
//                             every line carrying a figure, of the files or (--base) of the
//                             records the diff touches
//     tests [levels]          every test file at exactly one level of tests.levels, opening its
//                             level's harness; the pyramid and what the diff adds are INFO
//     tests focus             .only, a new .skip or todo, a test with no assertion
//     tests rules             the patterns tests.rules forbids in tests
//     tests touched           (needs --base) the changed lines and the tests that run them
//     tests mutate <path:line> --text <on the line> --to <mutated>
//                             applies the mutation in a scratch worktree, runs the tests that
//                             import the file: PASS killed (failing test), FAIL survived
//     body [--pr <n> | -]     the retrospective block of a pull request body (default: the
//                             current branch's, with gh; -: stdin): FAIL for a missing block, a
//                             missing, repeated or empty label; alone, lntt check does not run it
//     body template           the pull request template holds the block lntt pr block prints
//   lntt check cite <path:line>...
//                             what is on those lines; FAIL for a line or file that does not exist
//
//   lntt branch name --issue <n> [--type <type>] [--slug <slug>]
//                             the branch name for an issue: type/issue/slug, from its type
//                             or labels and its title (gh); --type and --slug override
//   lntt branch name --type <type> --slug <slug>
//                             the name for work without an issue: type/no-issue/slug
//   lntt branch check [--branch <name>]
//                             exit 1 when the branch (default: the current one) does not
//                             follow the convention, with the name it should have
//   lntt branch rename        rename the current branch to the convention, from the name a
//                             tool gave it or, in Orca, from the linked issue; never fails
//
//   lntt pr block             the empty retrospective block of delivery.pullRequest.retrospective,
//                             for the pull request template and the retrospective skill
//
//   lntt review [--base <branch>] [--plan]
//                             one review round on the current branch: the lenses and agents of
//                             delivery.review, headless and read-only, then verifiers that try to
//                             refute each blocker and warning; JSON on stdout, exit 1 with findings,
//                             exit 3 past delivery.review.maxRounds (the round does not start)
//   lntt review reply <finding> <answer>
//                             the author's answer, to the sessions of the reviewers who found it
//   lntt review allow <rounds>
//                             more rounds for the current branch, past delivery.review.maxRounds
//
//   lntt worktree start --issue <n> [--issue <n>]... [--host orca|herdr|git]
//                       [--kind <agent>] [--model <id>] [--effort <level>] [--no-agent]
//                       [--base <branch>] [--prompt <text>]
//                             per issue: a worktree on its branch, the setup orca.yaml
//                             declares, and an agent (--kind, default claude; --model and
//                             --effort as that agent takes them) with the brief (agents/brief.md);
//                             one JSON line each. The host is the innermost one the
//                             session runs in (Herdr, Orca), else plain git, where the
//                             brief is printed for the person to start the agent;
//                             --prompt replaces the brief (a coordinator's own, a trial)
//
//   lntt worktree start --coordinator --theme <slug> --issue <n>... [--approve <n>]...
//                             a theme's coordinator: one worktree on no issue, the coordinator's
//                             brief (agents/coordinator.md), on coordinator.models.coordinator
//   lntt worktree start --theme <slug> --issue <n> [--parent <worktree>] [--context <file>]
//                       [--size XS|S|M|L|XL] [--workflow]
//                             a coordinator's child: the theme in its brief, the model of its
//                             Size, the gate (coordinator.gate) passed before anything is created
//
//   lntt ask --to <orchestrator|coordinator|child> [--issue <n>] [--theme <slug>] [--topic <slug>]
//            [--timeout <s>] <question | ->
//                             write a message under <git common dir>/lntt-messages/ and wait for
//                             its answer (polled every 20 s); stdout is the answer
//   lntt inbox [--as <role>] [--issue <n>] [--theme <slug>] [--wait] [--timeout <s>]
//                             the unanswered messages to a role, one JSON line each
//   lntt answer <id> <text | ->
//                             reply to a message: the same name ending in .answer.md
//
//   lntt ci local [--event pull_request|push] [--base <branch>] [--job <key>]...
//                 [--list] [--strict] [--container] [--no-lock]
//
//     --event      what the cloud would see: a ready pull request into the base
//                  (default), or a push to it
//     --base       the pull request's base, or the branch pushed to (default:
//                  origin/HEAD's branch, else main)
//     --job        run only this job (`ci.yml/ci`, `circleci/test`); repeatable
//     --list       per job, what the cloud runs and what the local run does; runs nothing
//     --strict     fail when a step or job the cloud runs was not run locally
//     --container  run each job in the provider's local executor (act, circleci local
//                  execute) instead of on the host
//     --no-lock    run without waiting for the ci:local lock
//
//   The run starts only on a clean working tree: it checks the commit about to be pushed.
//   It queues on the ci:local lock (ci.local.lock), and a step that outlasts
//   ci.local.timeoutMinutes is stopped and fails with the machine's load.
//
//   lntt ci candidate [--pr <n>] [--event opened|ready_for_review|closed]
//                     [--head-ref <ref>] [--labels a,b] [--merged] [--dry-run]
//
//     In Actions it reads the pull_request event (GITHUB_EVENT_PATH). From a terminal,
//     --pr reads the pull request with gh and does what the workflow would do on its
//     event; --head-ref, --labels and --merged override what was read, to try a case
//     without creating it; --dry-run prints every write instead of making it. Without
//     delivery.candidate in the configuration it does nothing.
//
// Exit codes: 0 ok (the CI green), 1 a configuration error (the CI red), 2 a usage error.

import { argv } from 'node:process'

const args = argv.slice(2)
if (args[0] === 'ci') await (await import('../src/ci/cli.ts')).main(args.slice(1))
else if (args[0] === 'branch') (await import('../src/branch-cli.ts')).main(args.slice(1))
else if (args[0] === 'pr') (await import('../src/pull-request-cli.ts')).main(args.slice(1))
else if (args[0] === 'refs') await (await import('../src/refs-cli.ts')).main(args.slice(1))
else if (args[0] === 'board') (await import('../src/board-cli.ts')).main(args.slice(1))
else if (args[0] === 'check') (await import('../src/check-cli.ts')).main(args.slice(1))
else if (args[0] === 'review') await (await import('../src/review-cli.ts')).main(args.slice(1))
else if (args[0] === 'worktree') (await import('../src/worktree-cli.ts')).main(args.slice(1))
else if (args[0] === 'ask' || args[0] === 'inbox' || args[0] === 'answer') {
  ;(await import('../src/messages-cli.ts')).main(args[0], args.slice(1))
} else (await import('../src/cli.ts')).main(args)
