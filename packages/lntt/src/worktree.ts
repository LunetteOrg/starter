// The library's synchronous form of the worktree adapters (docs/adr/effect-in-lntt.md#the-bridge-while-modules-move):
// a thin shell over node: around the plain steps of src/worktree/hosts.ts, which loads no Effect.
// startOrca, startHerdr and startGit run the same steps `lntt worktree start` runs on Effect
// (src/worktree/start.ts), here through a synchronous Runner. Transitional: it goes with #341.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { cwd } from 'node:process'
import {
  type BriefValues,
  drive,
  renderBrief as fillBrief,
  startGit as gitSteps,
  startHerdr as herdrSteps,
  startOrca as orcaSteps,
  refusal,
  type Start,
  type Started,
  setupOf,
  type Templates,
} from './worktree/hosts.ts'

export {
  type Agent,
  agentArgs,
  type BriefValues,
  type Start,
  type Started,
  shellLaunch,
  toolFailure,
  type WorktreeHost,
  worktreeHost,
} from './worktree/hosts.ts'

// Runs the commands an adapter needs: `run` returns stdout, `shell` runs a script in a directory
// and fails when it does.
export interface Runner {
  run(command: string, args: string[], opts?: { cwd?: string }): string
  shell(script: string, cwd: string): void
  sleep(ms: number): void
}

// The setup a worktree gets, read from its own orca.yaml (the revision it checks out, not the main
// checkout's working copy), run by hand on the hosts that have no hook for it.
export type SetupFor = (worktree: string) => string | null

export function setupScript(worktree: string): string | null {
  const file = `${worktree}/orca.yaml`
  return existsSync(file) ? setupOf(readFileSync(file, 'utf8')) : null
}

// lntt's agents/, next to src/.
const AGENTS = new URL('../agents/', import.meta.url)

function templates(): Templates {
  return Object.fromEntries(
    readdirSync(AGENTS)
      .filter((name) => name.endsWith('.md'))
      .map((name) => [name, readFileSync(new URL(name, AGENTS), 'utf8')]),
  )
}

// The brief of a plain issue, from `template` or the shipped agents/brief.md.
export function renderBrief(template: string | undefined, values: BriefValues): string {
  return fillBrief(templates(), template, values)
}

const steps =
  (adapter: typeof orcaSteps) =>
  (start: Start, runner: Runner, setupFor: SetupFor = () => null): Started =>
    drive(adapter(start), (step) => {
      if (step.kind === 'run') return runner.run(step.command, step.args, step.cwd ? { cwd: step.cwd } : undefined)
      if (step.kind === 'shell') return runner.shell(step.script, step.cwd)
      if (step.kind === 'sleep') return runner.sleep(step.ms)
      return setupFor(step.worktree)
    })

export const startOrca = steps(orcaSteps)
export const startHerdr = steps(herdrSteps)
export const startGit = steps(gitSteps)

// One call to a tool: stdout, trimmed, is the result. When the call succeeds, what the tool said
// on stderr reaches the person after it; when it fails, the error carries the reason (Orca's JSON
// message, else what the tool printed, else its exit code), once.
export function runTool(
  command: string,
  args: string[],
  dir: string,
  say: (text: string) => void = (text) => process.stderr.write(text),
): string {
  const r = spawnSync(command, args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.error) throw r.error
  if (r.status !== 0)
    throw new Error(refusal(command, args, r.stdout ?? '', r.stderr ?? '', r.status ?? String(r.signal)))
  if (r.stderr) say(r.stderr)
  return (r.stdout ?? '').trim()
}

// The real tools, synchronously: what the upstream tests (test/upstream-*.test.ts) run the
// adapters against.
export const runner: Runner = {
  run: (command, args, opts) => runTool(command, args, opts?.cwd ?? cwd()),
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  shell: (script, dir) => {
    // The setup's output goes to stderr: stdout carries one JSON line per worktree.
    execFileSync('bash', ['-e', '-c', script], { cwd: dir, stdio: ['ignore', process.stderr, 'inherit'] })
  },
}
