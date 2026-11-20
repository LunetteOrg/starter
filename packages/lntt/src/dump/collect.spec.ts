import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import type * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as PlatformError from 'effect/PlatformError'
import { type ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { PackageDir } from '../sync/project.ts'
import { filesAt } from '../testing/fixtures.ts'
import { memorySpawner } from '../testing/spawner.ts'
import { collectDump, lnttPackage, redactionIn, runFailing } from './collect.ts'

const ROOT = '/r'
const MACHINE = { node: 'v24.1.0', os: 'Darwin 27.0.0 arm64', home: '/home/u' }

// A project with skills, hooks, a Lunette package and its configuration; lntt's own package at
// /lntt, its code in /lntt/dist.
const PROJECT = {
  '.agents/config.jsonc': '{ "delivery": { "commits": { "language": "en" } } }\n',
  '.agents/skills/review/SKILL.md': '',
  '.claude/skills/review/SKILL.md': '',
  '.claude/skills/deploy/SKILL.md': '',
  '.claude/settings.json': JSON.stringify({ hooks: { Stop: [] }, enabledPlugins: { 'lunette@lunette': true } }),
  'lefthook.yml': 'pre-push:\n  commands: {}\n',
  'package.json': JSON.stringify({ name: 'app', devDependencies: { '@lntt/biome-config': '^0.6.0' } }),
  'pnpm-lock.yaml': '',
  'node_modules/@lntt/biome-config/package.json': JSON.stringify({ version: '0.6.2' }),
}

function world(files: Record<string, string> = PROJECT, answer = (_: string, __: string[]) => ({}) as const) {
  const fs = filesAt(ROOT, files)
  fs.files.set('/lntt/package.json', { text: '{"name":"@lntt/lntt","version":"0.6.5"}', mtime: 0 })
  Effect.runSync(fs.dir('/lntt/dist/src'))
  const spawner = memorySpawner((command, args) => {
    if (command === 'git') return { out: 'origin\tgit@github.com:acme/app.git (fetch)\n' }
    if (args[0] === '--version') return { out: 'claude 2.3.4 (Claude Code)\n' }
    return answer(command, args)
  })
  const run = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>,
  ) =>
    effect.pipe(
      Effect.provide(Layer.mergeAll(fs.layer, Path.layer, spawner.layer)),
      Effect.provideService(PackageDir, '/lntt/dist'),
    )
  return { fs, spawner, run }
}

describe('what a dump gathers', () => {
  it.effect('lntt from the package.json above its code, and the project read from its files', () => {
    const w = world()
    return w.run(
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* lnttPackage, { dir: '/lntt', version: '0.6.5' })
        const dump = yield* collectDump({ root: ROOT, env: { CLAUDECODE: '1' }, machine: MACHINE })
        const get = (title: string) => dump.sections.find((s) => s.title === title)?.lines.join('\n') ?? ''
        assert.match(get('lntt'), /version: 0\.6\.5\ninstalled: from source/)
        assert.match(get('Runtime'), /package manager: pnpm\n/)
        assert.strictEqual(dump.harness, 'Claude Code 2.3.4')
        const project = get('Project')
        assert.match(project, /skills: \.agents\/skills: review; \.claude\/skills: deploy, review/)
        assert.match(project, /git hooks \(lefthook\): pre-push/)
        assert.match(project, /agent hooks \(\.claude\/settings\.json\): Stop/)
        assert.match(project, /@lntt\/biome-config: \^0\.6\.0, installed 0\.6\.2/)
        assert.match(project, /configuration: \.agents\/config\.jsonc/)
      }),
    )
  })

  it.effect('a configuration that does not validate, or none, is reported, not failed', () =>
    Effect.gen(function* () {
      const invalid = yield* world({ ...PROJECT, '.agents/config.jsonc': '{ "nope": 1 }' }).run(
        collectDump({ root: ROOT, env: {}, machine: MACHINE }),
      )
      assert.match(invalid.configError ?? '', /does not match the schema/)
      const { '.agents/config.jsonc': _, ...none } = PROJECT
      const defaults = yield* world(none).run(collectDump({ root: ROOT, env: {}, machine: MACHINE }))
      assert.strictEqual(defaults.configError, undefined)
    }),
  )

  it.effect('the remotes git lists, the home and the secrets of the environment are what a report hides', () => {
    const w = world()
    return w.run(
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* redactionIn(ROOT, { MY_TOKEN: 'abcdefghijkl' }, '/home/u'), {
          home: '/home/u',
          remotes: ['git@github.com:acme/app.git'],
          secrets: ['abcdefghijkl'],
        })
        assert.deepStrictEqual(
          w.spawner.asked.map((a) => [a.command, ...a.args].join(' ')),
          ['git remote -v'],
        )
      }),
    )
  })
})

// A failing command whose process prints `out` and then ends as `end` says: an exit code, a
// signal, or never.
function failing(out: string, end: { code: number } | { signal: string } | 'never') {
  const asked: string[][] = []
  const spawn = (command: ChildProcess.Command) =>
    Effect.sync(() => {
      if (command._tag === 'StandardCommand') asked.push([command.command, ...command.args.map(String)])
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode:
          end === 'never'
            ? Effect.never
            : 'code' in end
              ? Effect.succeed(ChildProcessSpawner.ExitCode(end.code))
              : Effect.fail(
                  PlatformError.systemError({
                    _tag: 'Unknown',
                    module: 'ChildProcess',
                    method: 'exitCode',
                    pathOrDescriptor: 'sh',
                    cause: new Error(`Process interrupted due to receipt of signal: '${end.signal}'`),
                  }),
                ),
        isRunning: Effect.succeed(end === 'never'),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout:
          end === 'never'
            ? Stream.concat(Stream.make(new TextEncoder().encode(out)), Stream.never)
            : Stream.make(new TextEncoder().encode(out)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    })
  return { asked, layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.make(spawn)) }
}

describe('the failing command', () => {
  it.effect('runs through sh with stderr merged, in its directory: its exit code and its output', () => {
    const f = failing('out\nerr\n', { code: 4 })
    return Effect.gen(function* () {
      const ran = yield* runFailing(['pnpm', 'test'], '/r')
      assert.deepStrictEqual(ran, { argv: ['pnpm', 'test'], status: 4, output: 'out\nerr\n' })
      assert.deepStrictEqual(f.asked, [['sh', '-c', 'exec "$@" 2>&1', 'sh', 'pnpm', 'test']])
    }).pipe(Effect.provide(f.layer))
  })

  it.effect('a command killed by a signal says which', () =>
    Effect.gen(function* () {
      const ran = yield* runFailing(['x'], '/r')
      assert.deepStrictEqual([ran.status, ran.stopped], [null, 'killed by SIGTERM'])
    }).pipe(Effect.provide(failing('', { signal: 'SIGTERM' }).layer)),
  )

  it.effect('a command that hangs is stopped at the timeout, what it printed kept', () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(runFailing(['sleep', '10'], '/r', 1000))
      yield* TestClock.adjust('1 second')
      const ran = yield* Fiber.join(fiber)
      assert.deepStrictEqual(ran, {
        argv: ['sleep', '10'],
        status: null,
        output: 'so far\n',
        stopped: 'stopped after 1 s',
      })
    }).pipe(Effect.provide(failing('so far\n', 'never').layer)),
  )
})
