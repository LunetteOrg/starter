// What the loaders of `lntt ci local` ask of the machine while they turn the provider's files into
// jobs (src/ci/github.ts, src/ci/circleci.ts, src/ci/actions.ts). Each loader is a generator that
// yields the ask it needs and receives its answer, so it reaches nothing itself
// (docs/adr/effect-in-lntt.md#the-bridge-while-modules-move). Two drivers answer the same asks: the
// one on Effect, over the FileSystem, the spawner and Git, that `lntt ci local` uses
// (src/ci/host.ts), and the synchronous one over `node:` that the library's `githubJobs`,
// `circleciJobs` and `localAction` use (src/ci/sync.ts). An ask that fails is thrown into the
// generator, so a loader catches what it expects as plain code does.

import type { Processed } from './circleci.ts'

export type Ask =
  // A file's text, null when there is none.
  | { kind: 'read'; path: string }
  // A directory's entries, null when there is none.
  | { kind: 'list'; dir: string }
  // Whether a command is on the PATH.
  | { kind: 'onPath'; command: string }
  // The Node version lntt runs on (`v24.15.0`).
  | { kind: 'node' }
  // Files changed from the merge base with `branch` to HEAD; null without a local ref.
  | { kind: 'changed'; branch: string }
  // A CircleCI configuration's text expanded by `circleci config process`, with these pipeline
  // parameters (`path` names it in an error).
  | { kind: 'process'; path: string; text: string; parameters: Record<string, unknown> }
  // A promise the loader awaits (@actions/workflow-parser converts a workflow asynchronously).
  | { kind: 'await'; promise: () => Promise<unknown> }

export type Asks<A> = Generator<Ask, A, unknown>

export function* read(path: string): Asks<string | null> {
  return (yield { kind: 'read', path }) as string | null
}

export function* list(dir: string): Asks<string[] | null> {
  return (yield { kind: 'list', dir }) as string[] | null
}

export function* onPath(command: string): Asks<boolean> {
  return (yield { kind: 'onPath', command }) as boolean
}

export function* nodeVersion(): Asks<string> {
  return (yield { kind: 'node' }) as string
}

export function* changed(branch: string): Asks<string[] | null> {
  return (yield { kind: 'changed', branch }) as string[] | null
}

export function* processed(path: string, text: string, parameters: Record<string, unknown>): Asks<Processed> {
  return (yield { kind: 'process', path, text, parameters }) as Processed
}

export function* awaited<A>(promise: () => Promise<A>): Asks<A> {
  return (yield { kind: 'await', promise }) as A
}

// `path.posix.join` without `node:path`: the parts joined by `/`, `.` and empty segments dropped,
// `..` taking the previous one back.
export function joinPath(...parts: string[]): string {
  const absolute = parts[0]?.startsWith('/') ?? false
  const out: string[] = []
  for (const segment of parts.join('/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop()
    else if (segment !== '..' || !absolute) out.push(segment)
  }
  const joined = `${absolute ? '/' : ''}${out.join('/')}`
  return joined === '' ? '.' : joined
}
