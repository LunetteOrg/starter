import { assert, describe, it } from '@effect/vitest'
import * as PlatformError from 'effect/PlatformError'
import {
  held,
  holdDeadline,
  lockDir,
  lockFailure,
  lockPath,
  type Owner,
  overdue,
  parse,
  pollInterval,
  unreadable,
  withGroup,
} from './lock-rules.ts'

const START = Date.parse('2026-10-21T10:00:00Z')
const other = (fields: Partial<Owner> = {}): Owner => ({
  pid: 2000,
  host: 'here',
  worktree: '/w/other',
  started: new Date(START - 5 * 60_000).toISOString(),
  ...fields,
})

describe('where the lock is', () => {
  it('$LNTT_CI_LOCK_DIR, else the cache folder', () => {
    assert.strictEqual(lockDir({ LNTT_CI_LOCK_DIR: '/x' }, '/home/me'), '/x')
    assert.strictEqual(lockDir({ XDG_CACHE_HOME: '/c' }, '/home/me'), '/c/lntt')
    assert.strictEqual(lockDir({}, '/home/me'), '/home/me/.cache/lntt')
  })

  it('machine scope: one file; project scope: one per repository, named by its common dir and its hash', () => {
    const hash = 'abcdef0123456789'
    assert.strictEqual(lockPath('/l', 'machine', '/r/a/.git', hash), '/l/ci-local.lock')
    assert.strictEqual(lockPath('/l', 'project', '/r/a/.git', hash), '/l/ci-local-a-abcdef012345.lock')
    // A bare clone's common dir, named without its .git.
    assert.strictEqual(lockPath('/l', 'project', '/r/b.git', hash), '/l/ci-local-b-abcdef012345.lock')
  })
})

describe('the record', () => {
  it('reads only a whole record: a pid and a group that are numbers, a start that is a date', () => {
    assert.deepStrictEqual(parse(JSON.stringify(other({ group: 7 }))), other({ group: 7 }))
    for (const bad of [
      { ...other(), pid: '2000' },
      { ...other(), started: 'yesterday' },
      { ...other(), group: 'g' },
    ]) {
      assert.strictEqual(parse(JSON.stringify(bad)), null)
    }
    assert.strictEqual(parse(''), null)
  })

  it('carries the step’s process group while it runs one', () => {
    assert.deepStrictEqual(withGroup(other(), 77), other({ group: 77 }))
    assert.deepStrictEqual(withGroup(other({ group: 77 }), null), other())
  })
})

describe('the verdict', () => {
  it('an unreadable record is waited on while fresh or gone, stale once older than 10 s', () => {
    assert.deepStrictEqual(unreadable('/l', START, START - 5000), { pending: true })
    assert.deepStrictEqual(unreadable('/l', START, null), { pending: true })
    assert.match(
      (unreadable('/l', START, START - 11_000) as { stale: string }).stale,
      /no readable owner record: taking it over — \/l$/,
    )
  })

  it('a holder within the maximum hold time and its grace is held, even at 121 minutes; past it, stale loudly', () => {
    for (const minutes of [119, 121]) {
      assert.strictEqual(
        overdue('/l', other({ started: new Date(START - minutes * 60_000).toISOString() }), START),
        null,
      )
    }
    const late = overdue('/l', other({ started: new Date(START - 123 * 60_000).toISOString() }), START)
    assert.match(
      (late as { stale: string }).stale,
      /TAKING OVER the ci:local lock held by \/w\/other .*past the maximum hold time of 120 minutes/,
    )
  })

  it('held while the owner runs, or its step does; else stale, naming the host it was recorded on', () => {
    assert.deepStrictEqual(held('/l', other(), START, true, false), { owner: other(), orphan: false })
    assert.deepStrictEqual(held('/l', other({ group: 4 }), START, false, true), {
      owner: other({ group: 4 }),
      orphan: true,
    })
    // A group alive says nothing of a record without one.
    assert.ok('stale' in held('/l', other(), START, false, true))
    assert.match(
      (held('/l', other({ host: 'elsewhere' }), START, false, false) as { stale: string }).stale,
      /held by \/w\/other \(pid 2000 on elsewhere, since \d\d:\d\d, 5m ago\), which is no longer running: taking it over/,
    )
  })
})

describe('holdDeadline', () => {
  it('the maximum hold time from when the lock was taken, with its reason', () => {
    assert.deepStrictEqual(holdDeadline(other({ started: '2026-10-21T10:00:00.000Z' })), {
      at: Date.parse('2026-10-21T12:00:00.000Z'),
      reason: "the run passed the lock's maximum hold time of 120 minutes",
    })
  })
})

describe('why the lock could not be taken', () => {
  it('the first line of stderr, of the system error under a PlatformError, or of the message; else the code or name', () => {
    assert.strictEqual(
      lockFailure(Object.assign(new Error(''), { code: 'EACCES' }), '/l'),
      'cannot take the ci:local lock (EACCES) — /l; --no-lock runs without it',
    )
    assert.match(lockFailure(Object.assign(new Error(' '), { stderr: '' }), '/l'), /lock \(Error\) — /)
    assert.match(
      lockFailure({ stderr: 'fatal: not a git repository\nmore' }, '/l'),
      /lock \(fatal: not a git repository\) — /,
    )
    const platform = PlatformError.systemError({
      _tag: 'BadResource',
      module: 'FileSystem',
      method: 'makeDirectory',
      cause: new Error("ENOTDIR: not a directory, mkdir '/x/file/locks'"),
    })
    assert.match(lockFailure(platform, '/l'), /lock \(ENOTDIR: not a directory, mkdir '\/x\/file\/locks'\) — /)
    assert.match(lockFailure('boom', '/l'), /lock \(boom\) — /)
    assert.match(lockFailure({}, '/l'), /lock \(\[object Object\]\) — /)
  })

  it('a poll interval that is not a positive number is ignored', () => {
    assert.strictEqual(pollInterval({ LNTT_CI_LOCK_POLL_MS: '100' }), 100)
    for (const poll of [undefined, '', 'abc', '0', '-5', 'Infinity']) {
      assert.strictEqual(pollInterval({ LNTT_CI_LOCK_POLL_MS: poll }), undefined, String(poll))
    }
  })
})
