import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { acquire, gitCommonDir, type LockDeps, lockDir, lockPath, type Owner, release } from '../../src/ci/lock.ts'
import { git, repo } from './helpers.ts'

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-lock-')))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const START = Date.parse('2026-10-21T10:00:00Z')
const me: Owner = { pid: 1000, host: 'here', worktree: '/w/me', started: new Date(START).toISOString() }
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
    log: (line) => lines.push(line),
    lines,
    ...fields,
  }
}

const holder = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Owner

describe('acquire', () => {
  test('a free lock is taken at once, with the owner record, and nothing left beside it', async () => {
    const d = deps({ path: join(dir, 'sub', 'ci-local.lock') })
    const lock = await acquire(d)
    assert.deepEqual(holder(lock.path), me)
    assert.deepEqual(d.lines, [])
    assert.deepEqual(readdirSync(join(dir, 'sub')), ['ci-local.lock'])
    lock.release()
    assert.equal(existsSync(lock.path), false)
  })

  test('a held lock is waited for, naming its holder once, until it is released', async () => {
    const d = deps()
    writeFileSync(d.path, JSON.stringify(other()))
    let sleeps = 0
    d.sleep = async () => {
      if (++sleeps === 3) rmSync(d.path)
    }
    await acquire(d)
    assert.equal(sleeps, 3)
    assert.equal(d.lines.length, 2)
    assert.match(
      d.lines[0],
      /^lntt ci: waiting for the ci:local lock held by \/w\/other \(pid 2000 on here, since \d\d:\d\d, 5m ago\) — .*ci-local\.lock$/,
    )
    assert.match(d.lines[1], /took the ci:local lock after/)
    assert.equal(holder(d.path).pid, 1000)
  })

  test('a lock whose owner is no longer running on this host is taken over', async () => {
    const d = deps({ alive: (pid) => pid !== 2000 })
    writeFileSync(d.path, JSON.stringify(other()))
    await acquire(d)
    assert.equal(holder(d.path).pid, 1000)
    assert.match(d.lines[0], /held by \/w\/other .*which is no longer running/)
  })

  test('a dead pid on another host is not judged from here', async () => {
    const d = deps({ alive: () => false })
    writeFileSync(d.path, JSON.stringify(other({ host: 'elsewhere' })))
    d.sleep = async () => rmSync(d.path)
    await acquire(d)
    assert.match(d.lines[0], /waiting for the ci:local lock held by \/w\/other \(pid 2000 on elsewhere/)
  })

  test('a lock held past the maximum hold time is taken over, loudly', async () => {
    const d = deps()
    writeFileSync(d.path, JSON.stringify(other({ started: new Date(START - 121 * 60_000).toISOString() })))
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
      const old = (Date.now() - 11_000) / 1000
      utimesSync(d.path, old, old)
    }
    await acquire(d)
    assert.equal(sleeps, 1)
    assert.match(d.lines[0], /no readable owner record: taking it over/)
    assert.equal(holder(d.path).pid, 1000)
  })
})

describe('release', () => {
  test('removes only a lock whose record is ours', () => {
    const path = join(dir, 'ci-local.lock')
    writeFileSync(path, JSON.stringify(other()))
    release(path, me)
    assert.equal(existsSync(path), true)
    writeFileSync(path, JSON.stringify({ ...me, started: other().started }))
    release(path, me)
    assert.equal(existsSync(path), true)
    writeFileSync(path, JSON.stringify(me))
    release(path, me)
    assert.equal(existsSync(path), false)
    release(path, me)
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
