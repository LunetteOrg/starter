import { assert, describe, it } from '@effect/vitest'
import { ConfigError } from './files.ts'
import { appOf, liveWorktrees, resolvedApp, slotIn, slotsOf } from './local.ts'

const WEB = {
  port: 5173,
  url: 'http://localhost:{port}',
  commands: { start: { run: 'pnpm dev --port {port}' } },
  env: { APP_ORIGIN: 'http://localhost:{port}' },
}

describe('an app of local.apps', () => {
  it('on slot 0, the base port, with {port} filled in everywhere and the ready path defaulted', () => {
    assert.deepStrictEqual(resolvedApp('web', WEB, 0), {
      name: 'web',
      port: 5173,
      url: 'http://localhost:5173',
      readyPath: '/',
      commands: { start: { run: 'pnpm dev --port 5173' } },
      env: { APP_ORIGIN: 'http://localhost:5173' },
    })
  })

  it('on slot n, ten ports up per slot', () => {
    const app = resolvedApp('web', { ...WEB, readyPath: '/health' }, 2)
    assert.deepStrictEqual(
      [app.port, app.url, app.readyPath, app.env?.APP_ORIGIN],
      [5193, 'http://localhost:5193', '/health', 'http://localhost:5193'],
    )
  })

  it('an unknown app names the ones that exist, or says there are none', () => {
    assert.strictEqual(appOf({ local: { apps: { web: WEB } } }, 'web'), WEB)
    assert.throws(
      () => appOf({ local: { apps: { web: WEB } } }, 'admin'),
      ConfigError,
      /^no app admin in local\.apps \(web\)$/,
    )
    assert.throws(() => appOf({}, 'admin'), /\(none configured\)$/)
  })
})

describe('the slot of a worktree', () => {
  const porcelain = (...paths: string[]) => paths.map((p) => `worktree ${p}\nHEAD abc\ndetached\n`).join('\n')

  it('the slots a file holds: a JSON object of whole numbers, else none', () => {
    assert.deepStrictEqual(slotsOf('{"/a": 1, "/b": 2}'), { '/a': 1, '/b': 2 })
    for (const text of ['nope', 'null', '[1]', '"x"', '3', '{"/a": "one"}', '{"/a": 1.5}']) {
      assert.strictEqual(slotsOf(text), null, text)
    }
  })

  it('the worktrees git lists', () => {
    assert.deepStrictEqual([...liveWorktrees(porcelain('/main', '/a'))], ['/main', '/a'])
  })

  it('a new worktree takes the lowest free slot from 1; one with a slot keeps it', () => {
    const live = liveWorktrees(porcelain('/main', '/a', '/b'))
    const a = slotIn({}, live, '/a')
    assert.deepStrictEqual(a, { slot: 1, slots: { '/a': 1 } })
    const b = slotIn(a.slots, live, '/b')
    assert.deepStrictEqual(b, { slot: 2, slots: { '/a': 1, '/b': 2 } })
    assert.deepStrictEqual(slotIn(b.slots, live, '/a'), { slot: 1, slots: b.slots })
  })

  it('a worktree gone frees its slot for the next one', () => {
    const live = liveWorktrees(porcelain('/main', '/c'))
    assert.deepStrictEqual(slotIn({ '/a': 1, '/b': 2 }, live, '/c'), { slot: 1, slots: { '/c': 1 } })
  })
})
