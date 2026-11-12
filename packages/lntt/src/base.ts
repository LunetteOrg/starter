// The base a branch is compared with or started from (docs/adr/worktree-tooling.md), for the
// commands not yet on Effect: each function loads its Effect form (src/base/base.ts) when it is
// called and runs it on git and gh in `cwd`, so a command that does not call it loads no Effect.
// The project's delivery.candidate is read here, once per call.

import type { Base, BaseFor, CandidateRules } from './base/names.ts'
import { candidateConfig } from './ci/config.ts'

export type { Base, BaseFor, CandidateRules }

// Runs an Effect of the base on git and gh in `cwd`; a failure rejects with its error.
async function onMachine<A>(
  cwd: string,
  program: (base: typeof import('./base/base.ts')) => import('effect/Effect').Effect<A, unknown, unknown>,
): Promise<A> {
  const [Effect, Layer, base, { gitAt }, { ghAt }, { SpawnerLive }] = await Promise.all([
    import('effect/Effect'),
    import('effect/Layer'),
    import('./base/base.ts'),
    import('./git/git.ts'),
    import('./gh/gh.ts'),
    import('./spawner.ts'),
  ])
  const live = Layer.mergeAll(gitAt(cwd), ghAt(cwd)).pipe(Layer.provide(SpawnerLive))
  return Effect.runPromise(Effect.provide(program(base), live) as import('effect/Effect').Effect<A>)
}

// The branch pull requests go into: delivery.candidate.base, else origin/HEAD's, else main.
export function defaultBranch(cwd: string, candidate: CandidateRules | null): Promise<string> {
  return onMachine(cwd, (base) => base.defaultBranch(candidate))
}

// `origin/<branch>`; a missing one rejects, never falls back on the local branch.
export function remoteRef(cwd: string, branch: string): Promise<string> {
  return onMachine(cwd, (base) => base.remoteRef(branch))
}

// `origin/<branch>` when it exists locally, else `<branch>`, else null.
export function localRef(cwd: string, branch: string): Promise<string | null> {
  return onMachine(cwd, (base) => base.localRef(branch))
}

// The base of the branch in `cwd`, from the project's delivery.candidate and GitHub.
export function projectBase(cwd: string, kind: BaseFor): Promise<Base> {
  const config = candidateConfig(cwd)
  const candidate = config ? { base: config.base, prefix: config.prefix } : null
  return onMachine(cwd, (base) => base.projectBase(candidate, kind))
}
