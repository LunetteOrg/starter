import { assert, describe, it } from '@effect/vitest'
import { localInput } from './cli.ts'

describe('localInput', () => {
  const at = (args: string[], env: Record<string, string | undefined> = {}) =>
    localInput(args, env, '/home/me', 'v24.0.0')

  it('a pull request with the lock in the cache folder, by default', () => {
    assert.deepStrictEqual(at([]), {
      event: 'pull_request',
      list: false,
      strict: false,
      container: false,
      lock: true,
      lockDir: '/home/me/.cache/lntt',
      node: 'v24.0.0',
    })
  })

  it('each option reaches the run: --no-lock, --strict, --list, --container, --base, --job', () => {
    assert.deepStrictEqual(
      at(
        [
          '--event',
          'push',
          '--base',
          'main',
          '--job',
          'a',
          '--job',
          'b',
          '--list',
          '--strict',
          '--container',
          '--no-lock',
        ],
        { LNTT_CI_LOCK_DIR: '/locks', LNTT_CI_LOCK_POLL_MS: '100' },
      ),
      {
        event: 'push',
        base: 'main',
        only: ['a', 'b'],
        list: true,
        strict: true,
        container: true,
        lock: false,
        lockDir: '/locks',
        poll: 100,
        node: 'v24.0.0',
      },
    )
  })

  it('an event other than pull_request or push, or an option it does not know, is a usage error', () => {
    assert.deepStrictEqual(at(['--event', 'release']), { usage: '--event is pull_request or push, not release' })
    assert.deepStrictEqual(at(['--no-list']), { usage: "Unknown option '--no-list'" })
  })

  it('a poll interval that is not a positive number is left out', () => {
    for (const poll of ['', '0', 'abc']) assert.notProperty(at([], { LNTT_CI_LOCK_POLL_MS: poll }), 'poll')
  })
})
