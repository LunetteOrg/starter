import { assert, describe, it } from '@effect/vitest'
import * as ByteSize from 'effect/ByteSize'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as PlatformError from 'effect/PlatformError'
import { filesAt } from '../testing/fixtures.ts'
import { memoryTree, readTree } from './tree.ts'

describe('the project as read', () => {
  it.effect('reads the files listed and those named besides them; a listed path that is gone leaves the list', () =>
    Effect.gen(function* () {
      const fs = filesAt('/repo', { 'a.md': 'alpha', 'docs/b.md': 'beta', 'outside-list.md': 'gamma' })
      const tree = yield* readTree('/repo', ['a.md', 'docs/b.md', 'deleted.md', 'docs'], ['outside-list.md']).pipe(
        Effect.provide(Layer.mergeAll(fs.layer, Path.layer)),
      )
      assert.deepStrictEqual(tree.files, ['a.md', 'docs/b.md', 'docs'])
      assert.strictEqual(tree.text('docs/b.md'), 'beta')
      assert.strictEqual(tree.text('./a.md'), 'alpha')
      assert.strictEqual(tree.text('outside-list.md'), 'gamma')
      assert.strictEqual(tree.text('deleted.md'), null)
      // A folder is there, and no file.
      assert.strictEqual(tree.isFile('docs'), false)
      assert.strictEqual(tree.size('a.md'), 5)
    }),
  )

  it('a tree from texts, for a spec: its files sorted, their sizes in bytes', () => {
    const tree = memoryTree('/r', { 'b.md': 'é', 'a.md': '' })
    assert.deepStrictEqual(tree.files, ['a.md', 'b.md'])
    assert.strictEqual(tree.size('b.md'), 2)
    assert.ok(tree.isFile('a.md'))
    assert.ok(!tree.isFile('c.md'))
  })

  it.effect('a binary file, or one past the limit, is there with its size and no text', () =>
    Effect.gen(function* () {
      const fs = filesAt('/repo', { 'logo.png': 'not text', 'big.md': 'x'.repeat(20), 'small.md': 'ok' })
      const tree = yield* readTree('/repo', ['logo.png', 'big.md', 'small.md'], [], 10).pipe(
        Effect.provide(Layer.mergeAll(fs.layer, Path.layer)),
      )
      assert.deepStrictEqual(tree.files, ['logo.png', 'big.md', 'small.md'])
      assert.deepStrictEqual(
        ['logo.png', 'big.md', 'small.md'].map((f) => [tree.isFile(f), tree.size(f), tree.text(f)]),
        [
          [true, 8, null],
          [true, 20, null],
          [true, 2, 'ok'],
        ],
      )
    }),
  )

  it.effect('a file that is there and cannot be read fails the read, never a silent pass', () =>
    Effect.gen(function* () {
      const unreadable = Layer.succeed(FileSystem.FileSystem)(
        FileSystem.makeNoop({
          stat: () => Effect.succeed({ type: 'File', size: ByteSize.bytes(5) } as FileSystem.File.Info),
          readFileString: (path) =>
            Effect.fail(
              PlatformError.systemError({
                _tag: 'PermissionDenied',
                module: 'FileSystem',
                method: 'readFile',
                pathOrDescriptor: path,
              }),
            ),
        }),
      )
      const read = yield* readTree('/repo', ['a.md']).pipe(
        Effect.provide(Layer.mergeAll(unreadable, Path.layer)),
        Effect.flip,
      )
      assert.strictEqual(read._tag, 'PlatformError')
    }),
  )
})
