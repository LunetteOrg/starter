import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  acquire,
  acquireLock,
  alive,
  GROUP_WAIT_MS,
  gitCommonDir,
  groupAlive,
  holdDeadline,
  type Identity,
  type LockDeps,
  LockError,
  lockDir,
  lockError,
  lockPath,
  type Owner,
  pollInterval,
  RELEASE_WAIT_MS,
  release,
  removeStaleGuard,
} from '../../src/ci/lock.ts'
import { git, repo } from './helpers.ts'

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-lock-')))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const START = Date.parse('2026-10-21T10:00:00Z')
const me: Identity = { pid: 1000, host: 'here', worktree: '/w/me' }
const other = (fields: Partial<Owner> = {}): Owner => ({
  pid: 2000,
  host: 'here',
  worktree: '/w/other',
  started: new Date(START - 5 * 60_000).toISOString(),
  ...fields,
})

// A clock that the waiter's sleep moves forward, and the lines it logs.
function deps(fields: Partial<LockDeps> = {}): LockDeps & { lines: string[] } {
  let now = START
  const lines: string[] = []
  return {
    path: join(dir, 'ci-local.lock'),
    owner: me,
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
    alive: () => true,
    groupAlive: () => false,
    log: (line) => lines.push(line),
    lines,
    ...fields,
  }
}

const holder = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Owner

// A record `seconds` old on disk.
function age(path: string, seconds: number) {
  const old = (Date.now() - seconds * 1000) / 1000
  utimesSync(path, old, old)
}

describe('acquire', () => {
  test('a free lock is taken at once, with the owner record, and nothing left beside it', async () => {
    const d = deps({ path: join(dir, 'sub', 'ci-local.lock') })
    const lock = await acquire(d)
    assert.deepEqual(holder(lock.path), { ...me, started: new Date(START).toISOString() })
    assert.deepEqual(lock.owner, holder(lock.path))
    assert.deepEqual(d.lines, [])
    assert.deepEqual(readdirSync(join(dir, 'sub')), ['ci-local.lock'])
    lock.release()
    assert.equal(existsSync(lock.path), false)
    assert.deepEqual(readdirSync(join(dir, 'sub')), [])
  })

  test('a held lock is waited for, naming its holder once, until it is released; started is when it was taken', async () => {
    const d = deps({ interval: 5000 })
    writeFileSync(d.path, JSON.stringify(other()))
    let sleeps = 0
    const sleep = d.sleep
    d.sleep = async (ms) => {
      await sleep(ms)
      if (++sleeps === 3) rmSync(d.path)
    }
    const lock = await acquire(d)
    assert.equal(sleeps, 3)
    assert.equal(d.lines.length, 2)
    assert.match(
      d.lines[0],
      /^lntt ci: waiting for the ci:local lock held by \/w\/other \(pid 2000 on here, since \d\d:\d\d, 5m ago\) — .*ci-local\.lock$/,
    )
    assert.match(d.lines[1], /took the ci:local lock after 15s of waiting/)
    assert.equal(holder(d.path).pid, 1000)
    // The 15 s spent waiting are not counted as hold time.
    assert.equal(holder(d.path).started, new Date(START + 15_000).toISOString())
    assert.equal(lock.owner.started, holder(d.path).started)
  })

  test('a lock whose owner is no longer running is taken over', async () => {
    const d = deps({ alive: (pid) => pid !== 2000 })
    writeFileSync(d.path, JSON.stringify(other()))
    await acquire(d)
    assert.equal(holder(d.path).pid, 1000)
    assert.match(d.lines[0], /held by \/w\/other .*which is no longer running: taking it over/)
  })

  test('the host is shown, not used to judge the owner: a dead pid recorded under another host name is taken over', async () => {
    const d = deps({ alive: () => false })
    writeFileSync(d.path, JSON.stringify(other({ host: 'elsewhere' })))
    await acquire(d)
    assert.equal(holder(d.path).pid, 1000)
    assert.match(d.lines[0], /held by \/w\/other \(pid 2000 on elsewhere, .*which is no longer running/)
  })

  test('an owner gone while its step still runs is waited for, said once, until the step ends', async () => {
    let looks = 0
    const d = deps({ alive: (pid) => pid !== 2000, groupAlive: (group) => group === 4242 && ++looks < 4 })
    writeFileSync(d.path, JSON.stringify(other({ group: 4242 })))
    await acquire(d)
    assert.equal(looks, 4)
    assert.equal(d.lines.length, 3)
    assert.match(
      d.lines[0],
      /waiting for the ci:local lock held by \/w\/other .*, which is no longer running, but its step \(process group 4242\) still is — /,
    )
    assert.match(d.lines[1], /which is no longer running: taking it over/)
    assert.match(d.lines[2], /took the ci:local lock after/)
  })

  test('a holder that becomes an orphan with its step still running is announced again', async () => {
    let looks = 0
    const d = deps({ alive: (pid) => pid !== 2000 || ++looks < 3, groupAlive: (group) => group === 4242 })
    writeFileSync(d.path, JSON.stringify(other({ group: 4242 })))
    d.sleep = async () => {
      if (looks >= 5) rmSync(d.path)
    }
    await acquire(d)
    assert.equal(d.lines.length, 3)
    assert.match(d.lines[0], /^lntt ci: waiting for the ci:local lock held by \/w\/other \(pid 2000 .*\) — /)
    assert.doesNotMatch(d.lines[0], /still is/)
    assert.match(d.lines[1], /which is no longer running, but its step \(process group 4242\) still is — /)
    assert.match(d.lines[2], /took the ci:local lock after/)
  })

  test('a holder within the maximum hold time and its grace is waited for, even at 121 minutes', async () => {
    for (const minutes of [119, 121]) {
      const d = deps()
      writeFileSync(d.path, JSON.stringify(other({ started: new Date(START - minutes * 60_000).toISOString() })))
      d.sleep = async () => rmSync(d.path)
      await acquire(d)
      assert.match(d.lines[0], new RegExp(`waiting for the ci:local lock held by /w/other .*, ${minutes}m ago\\)`))
      assert.doesNotMatch(d.lines.join('\n'), /TAKING OVER/)
    }
  })

  test('a lock held past the maximum hold time and its grace is taken over, loudly', async () => {
    const d = deps()
    writeFileSync(d.path, JSON.stringify(other({ started: new Date(START - 123 * 60_000).toISOString() })))
    await acquire(d)
    assert.equal(holder(d.path).pid, 1000)
    assert.match(
      d.lines[0],
      /TAKING OVER the ci:local lock held by \/w\/other .*past the maximum hold time of 120 minutes/,
    )
  })

  test('an unreadable record is waited on while fresh, taken over once older than 10 s', async () => {
    const d = deps({ now: () => Date.now() })
    writeFileSync(d.path, '')
    let sleeps = 0
    d.sleep = async () => {
      sleeps++
      age(d.path, 11)
    }
    await acquire(d)
    assert.equal(sleeps, 1)
    assert.match(d.lines[0], /no readable owner record: taking it over/)
    assert.equal(holder(d.path).pid, 1000)
  })

  for (const [what, bad] of [
    ['a pid that is not a number', { ...other(), pid: '2000' }],
    ['a start that is not a date', { ...other(), started: 'yesterday' }],
    ['a group that is not a number', { ...other(), group: 'g' }],
  ] as const) {
    test(`a record with ${what} is unreadable, taken over once older than 10 s`, async () => {
      const d = deps({ now: () => Date.now() })
      writeFileSync(d.path, JSON.stringify(bad))
      age(d.path, 11)
      await acquire(d)
      assert.match(d.lines[0], /no readable owner record: taking it over/)
      assert.equal(holder(d.path).pid, 1000)
    })
  }

  test('a record replaced between the verdict and the removal survives', async () => {
    const d = deps({
      alive: (pid) => {
        // Another waiter takes the lock over while this one judges the old record.
        if (pid === 2000) writeFileSync(d.path, JSON.stringify(other({ pid: 3000 })))
        return pid !== 2000
      },
    })
    writeFileSync(d.path, JSON.stringify(other()))
    let sleeps = 0
    d.sleep = async () => {
      sleeps++
      assert.equal(holder(d.path).pid, 3000)
      rmSync(d.path)
    }
    await acquire(d)
    assert.equal(sleeps, 1)
    assert.doesNotMatch(d.lines.join('\n'), /taking it over/)
    assert.match(d.lines[0], /waiting for the ci:local lock held by \/w\/other \(pid 3000/)
  })

  test('a lock that vanishes on every read is looked at again after a pause, not in a tight loop', async () => {
    const d = deps()
    // A dangling link: taken for a link, missing for a read.
    symlinkSync(join(dir, 'nowhere'), d.path)
    const pauses: number[] = []
    d.sleep = async (ms) => {
      pauses.push(ms)
      if (pauses.length === 3) rmSync(d.path)
    }
    await acquire(d)
    assert.deepEqual(pauses, [50, 50, 50])
    assert.equal(holder(d.path).pid, 1000)
  })

  test('a takeover guard left by a crash is removed after 10 s; a fresh one is waited for', async () => {
    const d = deps({ alive: (pid) => pid !== 2000 })
    writeFileSync(d.path, JSON.stringify(other()))
    const guard = `${d.path}.takeover`
    writeFileSync(guard, 'crashed')
    let sleeps = 0
    d.sleep = async () => {
      // The first look finds the guard fresh; the next one removes it, the third takes it.
      if (++sleeps === 1) age(guard, 11)
    }
    await acquire(d)
    assert.equal(sleeps, 2)
    assert.equal(holder(d.path).pid, 1000)
    assert.equal(existsSync(guard), false)
  })

  test('the step’s process group is recorded while the record is still ours', async () => {
    const d = deps()
    const lock = await acquire(d)
    lock.setGroup(77)
    assert.deepEqual(holder(d.path), { ...lock.owner, group: 77 })
    lock.setGroup(null)
    assert.deepEqual(holder(d.path), lock.owner)
    writeFileSync(d.path, JSON.stringify(other()))
    lock.setGroup(78)
    assert.deepEqual(holder(d.path), other())
    assert.deepEqual(readdirSync(dir), ['ci-local.lock'])
  })
})

describe('three waiters on a dead holder’s lock', () => {
  // Each waiter takes the lock eight times, logs in and out, and then plays dead: it
  // leaves its record and names its pid in the dead file, so the others race to take over.
  const WAITER = `
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { acquire } from ${JSON.stringify(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/ci/lock.ts')).href)}
const [dir, name] = process.argv.slice(1)
const dead = () => (existsSync(dir + '/dead') ? readFileSync(dir + '/dead', 'utf8').split('\\n') : [])
while (!existsSync(dir + '/go')) await new Promise((r) => setTimeout(r, 1))
for (let round = 1; round <= 8; round++) {
  const pid = process.pid * 10 + round
  await acquire({
    path: dir + '/ci-local.lock',
    owner: { pid, host: 'here', worktree: name },
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    // Slow to judge, so the waiters' verdicts and removals interleave.
    alive: (p) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3)
      return !dead().includes(String(p))
    },
    groupAlive: () => false,
    log: () => {},
    interval: 2,
  })
  appendFileSync(dir + '/log', 'in ' + name + '\\n')
  await new Promise((r) => setTimeout(r, 5))
  appendFileSync(dir + '/log', 'out ' + name + '\\n')
  appendFileSync(dir + '/dead', pid + '\\n')
}
`

  test('exactly one holds the lock at a time', async () => {
    writeFileSync(join(dir, 'ci-local.lock'), JSON.stringify(other({ pid: 1 })))
    writeFileSync(join(dir, 'dead'), '1\n')
    const waiters = ['a', 'b', 'c'].map(
      (name) =>
        new Promise<number | null>((done) =>
          spawn(process.execPath, ['--input-type=module', '-e', WAITER, dir, name], { stdio: 'inherit' }).on(
            'close',
            done,
          ),
        ),
    )
    writeFileSync(join(dir, 'go'), '')
    assert.deepEqual(await Promise.all(waiters), [0, 0, 0])
    const log = readFileSync(join(dir, 'log'), 'utf8').trim().split('\n')
    assert.equal(log.length, 48)
    for (let i = 0; i < log.length; i += 2) {
      assert.equal(log[i].replace('in ', 'out '), log[i + 1], `overlap at line ${i + 1}:\n${log.join('\n')}`)
    }
  })
})

describe('release', () => {
  test('removes only a lock whose record is the one it published', () => {
    const path = join(dir, 'ci-local.lock')
    const mine = other({ pid: 1000 })
    writeFileSync(path, JSON.stringify(other()))
    release(path, mine)
    assert.equal(existsSync(path), true)
    writeFileSync(path, JSON.stringify({ ...mine, started: new Date(START).toISOString() }))
    release(path, mine)
    assert.equal(existsSync(path), true)
    // The same start, another pid.
    writeFileSync(path, JSON.stringify({ ...mine, pid: 2000 }))
    release(path, mine)
    assert.equal(existsSync(path), true)
    writeFileSync(path, JSON.stringify({ ...mine, group: 12 }))
    release(path, mine)
    assert.equal(existsSync(path), false)
    release(path, mine)
    assert.deepEqual(readdirSync(dir), [])
  })

  test('waits out a takeover guard left by a crash', () => {
    const path = join(dir, 'ci-local.lock')
    const mine = other({ pid: 1000 })
    writeFileSync(path, JSON.stringify(mine))
    writeFileSync(`${path}.takeover`, 'crashed')
    age(`${path}.takeover`, 11)
    release(path, mine)
    assert.deepEqual(readdirSync(dir), [])
  })
})

describe('the takeover guard', () => {
  const guard = () => join(dir, 'ci-local.lock.takeover')

  test('a stale guard is removed only while it is still the one seen, and still old', () => {
    writeFileSync(guard(), 'crashed')
    age(guard(), 11)
    // Another waiter removed it, and a third run took a fresh one: it stays.
    writeFileSync(guard(), 'fresh')
    assert.equal(removeStaleGuard(guard(), 'crashed'), false)
    assert.equal(readFileSync(guard(), 'utf8'), 'fresh')
    // The same content, seen through a clock that finds it only 5 s old.
    age(guard(), 11)
    assert.equal(
      removeStaleGuard(guard(), 'fresh', () => Date.now() - 6000),
      false,
    )
    assert.equal(readFileSync(guard(), 'utf8'), 'fresh')
    assert.equal(removeStaleGuard(guard(), 'fresh'), true)
    assert.equal(existsSync(guard()), false)
    // Gone already: nothing to do.
    assert.equal(removeStaleGuard(guard(), 'fresh'), false)
    assert.deepEqual(readdirSync(dir), [])
  })

  test('a fresh guard held by another run bounds the wait: setGroup gives up, release too', async () => {
    const d = deps()
    const lock = await acquire(d)
    writeFileSync(guard(), 'another run')
    let started = Date.now()
    lock.setGroup(77)
    const grouped = Date.now() - started
    assert.ok(grouped >= GROUP_WAIT_MS && grouped < GROUP_WAIT_MS + 500, `setGroup waited ${grouped} ms`)
    assert.deepEqual(holder(d.path), lock.owner)
    started = Date.now()
    lock.release()
    const released = Date.now() - started
    assert.ok(released >= RELEASE_WAIT_MS && released < RELEASE_WAIT_MS + 1000, `release waited ${released} ms`)
    // Left to go stale by its owner's dead pid.
    assert.deepEqual(holder(d.path), lock.owner)
  })
})

describe('acquireLock', () => {
  test('a lock folder that cannot be made is one line naming the lock and --no-lock', async () => {
    writeFileSync(join(dir, 'file'), '')
    await assert.rejects(
      acquireLock(dir, 'machine', () => {}, { LNTT_CI_LOCK_DIR: join(dir, 'file', 'locks') }),
      (error: Error) => {
        assert.ok(error instanceof LockError)
        assert.match(
          error.message,
          /^cannot take the ci:local lock \(ENOTDIR: .*\) — .*\/file\/locks\/ci-local\.lock; --no-lock runs without it$/,
        )
        return true
      },
    )
  })

  test('a lock file that cannot be read, or a folder that cannot be written, is one line too', async () => {
    mkdirSync(join(dir, 'ci-local.lock'))
    await assert.rejects(
      acquireLock(dir, 'machine', () => {}, { LNTT_CI_LOCK_DIR: dir }),
      {
        message: /^cannot take the ci:local lock \(EISDIR: .*\) — .*ci-local\.lock; --no-lock runs without it$/,
      },
    )
    const readOnly = join(dir, 'read-only')
    mkdirSync(readOnly, { mode: 0o500 })
    try {
      await assert.rejects(
        acquireLock(dir, 'machine', () => {}, { LNTT_CI_LOCK_DIR: readOnly }),
        {
          message:
            /^cannot take the ci:local lock \(EACCES: .*\) — .*read-only\/ci-local\.lock; --no-lock runs without it$/,
        },
      )
    } finally {
      chmodSync(readOnly, 0o700)
    }
  })

  test('the project scope outside a git checkout is one line too', async () => {
    await assert.rejects(
      acquireLock(dir, 'project', () => {}, { LNTT_CI_LOCK_DIR: join(dir, 'locks') }),
      (error: Error) => {
        assert.match(error.message, /^cannot take the ci:local lock \(.*\) — .*\/locks; --no-lock runs without it$/)
        assert.doesNotMatch(error.message, /\n/)
        return true
      },
    )
  })

  test('a stale lock that cannot be removed is one line too', async () => {
    const path = join(dir, 'ci-local.lock')
    writeFileSync(path, JSON.stringify(other({ started: new Date(Date.now() - 200 * 60_000).toISOString() })))
    const unlink = fs.unlinkSync
    let attempts = 0
    // Only the first removal fails: an error swallowed would let the next one take the lock.
    mock.method(fs, 'unlinkSync', (target: fs.PathLike) => {
      if (target === path && ++attempts === 1)
        throw Object.assign(new Error('EBUSY: resource busy or locked, unlink'), { code: 'EBUSY' })
      unlink(target)
    })
    syncBuiltinESMExports()
    try {
      await assert.rejects(
        acquireLock(dir, 'machine', () => {}, { LNTT_CI_LOCK_DIR: dir }),
        (error: Error) => {
          assert.ok(error instanceof LockError)
          assert.match(error.message, /^cannot take the ci:local lock \(EBUSY: .*\) — .*ci-local\.lock; --no-lock runs/)
          return true
        },
      )
    } finally {
      mock.restoreAll()
      syncBuiltinESMExports()
    }
    assert.equal(existsSync(path), true)
  })

  test('an error with no message is named by its code, else its name', () => {
    const coded = Object.assign(new Error(''), { code: 'EACCES' })
    assert.equal(
      lockError(coded, '/l').message,
      'cannot take the ci:local lock (EACCES) — /l; --no-lock runs without it',
    )
    assert.match(lockError(Object.assign(new Error(' '), { stderr: '' }), '/l').message, /lock \(Error\) — /)
    assert.match(
      lockError({ stderr: 'fatal: not a git repository\nmore' }, '/l').message,
      /lock \(fatal: not a git repository\) — /,
    )
  })

  test('a poll interval that is not a positive number is ignored', () => {
    assert.equal(pollInterval({ LNTT_CI_LOCK_POLL_MS: '100' }), 100)
    for (const poll of [undefined, '', 'abc', '0', '-5', 'Infinity']) {
      assert.equal(pollInterval({ LNTT_CI_LOCK_POLL_MS: poll }), undefined, String(poll))
    }
  })
})

describe('holdDeadline', () => {
  test('the maximum hold time from when the lock was taken, with its reason', () => {
    assert.deepEqual(holdDeadline(other({ started: '2026-10-21T10:00:00.000Z' })), {
      at: Date.parse('2026-10-21T12:00:00.000Z'),
      reason: "the run passed the lock's maximum hold time of 120 minutes",
    })
  })
})

describe('liveness', () => {
  test('a running process, one of another user (EPERM), a finished one; a process group', async () => {
    assert.equal(alive(process.pid), true)
    assert.equal(alive(1), true)
    const finished = spawnSync('true').pid as number
    assert.equal(alive(finished), false)
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    const closed = new Promise((resolve) => child.on('close', resolve))
    assert.equal(groupAlive(child.pid as number), true)
    process.kill(-(child.pid as number), 'SIGKILL')
    await closed
    assert.equal(groupAlive(child.pid as number), false)
  })
})

describe('where the lock is', () => {
  test('$LNTT_CI_LOCK_DIR, else the cache folder', () => {
    assert.equal(lockDir({ LNTT_CI_LOCK_DIR: '/x' }), '/x')
    assert.equal(lockDir({ XDG_CACHE_HOME: '/c' }), '/c/lntt')
    assert.match(lockDir({}), /\/\.cache\/lntt$/)
  })

  test('machine scope: one file; project scope: one per repository, shared by its worktrees', () => {
    assert.equal(lockPath('/l', 'machine', '/r/a/.git'), '/l/ci-local.lock')
    const a = repo({})
    const b = repo({})
    try {
      git(a, 'worktree', 'add', '-q', join(a, '.git', 'wt'), '-b', 'other')
      const main = lockPath('/l', 'project', gitCommonDir(a))
      assert.match(main, new RegExp(`^/l/ci-local-${a.split('/').pop()}-[0-9a-f]{12}\\.lock$`))
      assert.equal(lockPath('/l', 'project', gitCommonDir(join(a, '.git', 'wt'))), main)
      assert.notEqual(lockPath('/l', 'project', gitCommonDir(b)), main)
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })
})
