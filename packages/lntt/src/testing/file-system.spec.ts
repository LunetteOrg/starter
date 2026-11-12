import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { memoryFileSystem } from './file-system.ts'

describe('the file system in memory', () => {
  it.effect('lists what a directory holds as Node’s readdir: its files and directories, once each, sorted', () => {
    const memory = memoryFileSystem({ dirs: ['/box/empty'] })
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* memory.put('/box/b.md', 'b')
      yield* memory.put('/box/a/one.md', '1')
      yield* memory.put('/box/a/deeper/two.md', '2')
      assert.deepStrictEqual(yield* fs.readDirectory('/box'), ['a', 'b.md', 'empty'])
      assert.deepStrictEqual(yield* fs.readDirectory('/box/a'), ['deeper', 'one.md'])
      assert.deepStrictEqual(yield* fs.readDirectory('/box/empty'), [])
    }).pipe(Effect.provide(memory.layer))
  })

  it.effect('a directory that is not there is NotFound; a file is BadResource, as Node’s ENOTDIR', () => {
    const memory = memoryFileSystem()
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* memory.put('/box/b.md', 'b')
      const missing = yield* Effect.flip(fs.readDirectory('/nowhere'))
      assert.strictEqual(missing.reason._tag, 'NotFound')
      const file = yield* Effect.flip(fs.readDirectory('/box/b.md'))
      assert.strictEqual(file.reason._tag, 'BadResource')
    }).pipe(Effect.provide(memory.layer))
  })
})
