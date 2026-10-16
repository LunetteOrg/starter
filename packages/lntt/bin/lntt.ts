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
//   lntt sync                 write the managed block of AGENTS.md
//   lntt check                exit 1 when the block differs from its source
//   lntt local app <name>     an app of local.apps, resolved for this worktree (port, url, commands)
//   lntt viewer detect        where the session runs and which viewer shows pages, with why
//   lntt viewer open <url>    open it there; exit 3 with the agent call when only the agent can
//
//   lntt ci local [--event pull_request|push] [--base <branch>] [--job <key>]...
//                 [--list] [--strict] [--container]
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
//
//   The run starts only on a clean working tree: it checks the commit about to be pushed.
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
else (await import('../src/cli.ts')).main(args)
