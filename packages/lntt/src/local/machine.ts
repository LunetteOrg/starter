// What `lntt local`, `lntt viewer` and `lntt browser` read from the machine and do on it, on Effect
// (docs/adr/effect-in-lntt.md): the worktree's port slot through Git and the FileSystem, the
// commands on the PATH and the opening of a page through the spawner. What to compute is plain
// (src/local.ts, src/viewer.ts).

import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Scope from 'effect/Scope'
import { captured, onPath } from '../captured.ts'
import { Git } from '../git/git.ts'
import { appOf, liveWorktrees, PORTS, resolvedApp, slotIn, slotsOf } from '../local.ts'
import { noTab, type Opening } from '../viewer.ts'

// What a command of these refuses or cannot do: an app local.apps does not have, a viewer that
// failed to open the page. Reported by its message, exit 1.
export class LocalFailed extends Data.TaggedError('LocalFailed')<{ message: string }> {}

// The slot of the worktree Git runs in: 0 in the main checkout; in a linked worktree the one the
// slots' file in the common directory gives it, which the file then keeps.
export const worktreeSlot = Effect.gen(function* () {
  const git = yield* Git
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const gitDir = yield* git.gitDir
  const common = yield* git.commonDir
  if (gitDir === common) return 0
  const here = yield* git.root
  const live = liveWorktrees(yield* git.worktrees(gitDir))
  const file = path.join(common, ...PORTS)
  const text = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : '{}'
  const known = slotsOf(text)
  if (known === null) {
    return yield* new LocalFailed({
      message: `${file} is not a JSON object of slots: remove it, and the slots start again`,
    })
  }
  const { slot, slots } = slotIn(known, live, here)
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  yield* fs.writeFileString(file, `${JSON.stringify(slots, null, 2)}\n`)
  return slot
})

// An app of local.apps of the configuration `data`, resolved for the worktree Git runs in.
export const localApp = Effect.fnUntraced(function* (data: Record<string, unknown>, name: string) {
  const app = yield* Effect.try({
    try: () => appOf(data, name),
    catch: (error) => new LocalFailed({ message: error instanceof Error ? error.message : String(error) }),
  })
  return resolvedApp(name, app, yield* worktreeSlot)
})

// Which of `commands` are on the PATH, asked once each, all at once. A command not asked is a bug
// of lntt: it throws.
export const onPathOf = Effect.fnUntraced(function* (commands: string[]) {
  const unique = [...new Set(commands)]
  const found = yield* Effect.forEach(unique, onPath, { concurrency: 'unbounded' })
  return (command: string) => {
    const at = unique.indexOf(command)
    if (at === -1) throw new Error(`${command} was not looked for on the PATH: add it to the commands asked`)
    return found[at] === true
  }
})

// Runs a viewer's command to its end; one that fails is a LocalFailed with what it printed.
const run = Effect.fnUntraced(function* (command: string, args: string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const said = yield* captured(spawner, command, args)
  if (said.code !== 0) {
    const output = [said.out, said.err].filter(Boolean).join('\n')
    return yield* new LocalFailed({ message: `${command} ${args[0]} failed${output ? `: ${output}` : ''}` })
  }
  return said
})

// Opens a page as the opening says. A detached command belongs to no scope: it outlives lntt, in a
// process group of its own, and does not keep the process alive.
export const open = Effect.fnUntraced(function* (opening: Opening) {
  if (opening.kind === 'orca') {
    yield* run('orca', opening.goto).pipe(
      Effect.catchTag('LocalFailed', (failed) =>
        noTab(failed.message) ? run('orca', opening.tab) : Effect.fail(failed),
      ),
    )
    return
  }
  if (opening.kind === 'run') {
    yield* run(opening.command, opening.args)
    return
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const own = yield* Scope.make()
  const letGo = yield* spawner
    .spawn(
      ChildProcess.make(opening.command, opening.args, {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        detached: true,
      }),
    )
    .pipe(
      Scope.provide(own),
      Effect.map((handle) => handle.unref),
    )
  yield* letGo.pipe(Effect.ignore)
})
