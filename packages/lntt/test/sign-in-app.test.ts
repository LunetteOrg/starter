import assert from 'node:assert/strict'
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import { closeSync, cpSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type LocalApp, localApp } from '../src/index.ts'

// run-local's sign-in procedure (skills/run-local, section 4) proved on a fixture app:
// two seeded users from the configuration, a one-time code in the server log, a
// protected page, a cookie named per port. Two instances run at once, one per
// checkout, each with a state saved by the app's Playwright `signIn.test`.

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures/sign-in-app')
const PLAYWRIGHT = resolve(HERE, '../node_modules/.bin/playwright')

interface Instance {
  app: LocalApp
  root: string
  log: string
  state: string
  server: ChildProcess
  fd: number
}

let tmp: string
const instances: Instance[] = []

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

const listensOn = (port: number): Promise<boolean> =>
  new Promise((done) => {
    const probe = createServer()
    probe.once('error', () => done(false))
    probe.listen(port, () => probe.close(() => done(true)))
  })

// The fixture's base port is fixed, so two runs of this suite from two checkouts would
// share it: each run takes a base whose own port and the next worktree's are free.
async function freeBase(): Promise<number> {
  for (;;) {
    const base = 20000 + Math.floor(Math.random() * 20000)
    if ((await listensOn(base)) && (await listensOn(base + 10))) return base
  }
}

async function ready(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`${url} never answered`)
}

async function start(root: string, name: string): Promise<Instance> {
  const app = localApp(root, name)
  const log = join(root, 'app.log')
  const fd = openSync(log, 'w')
  const server = spawn(app.commands.start.run, {
    cwd: root,
    shell: true,
    env: { ...process.env, ...app.env },
    stdio: ['ignore', fd, fd],
  })
  const instance = { app, root, log, state: join(root, '.auth/state.json'), server, fd }
  instances.push(instance)
  await ready(app.url + app.readyPath)
  return instance
}

// Playwright runs without blocking this process: a blocked event loop never sees the
// server close an idle keep-alive connection, and the next fetch reuses it (ECONNRESET).
async function signIn(i: Instance, login: string): Promise<void> {
  // The setup test is the one `signIn.test` points at; it reads the code in the log.
  const test = i.app.signIn?.test
  assert.ok(test, 'the app declares no signIn.test')
  const run = spawn(PLAYWRIGHT, ['test', test, '--config', join(i.root, 'playwright.config.ts')], {
    cwd: i.root,
    timeout: 60_000,
    env: { ...process.env, ...i.app.env, SIGN_IN_AS: login, LOG_FILE: i.log, STATE_FILE: i.state },
  })
  let output = ''
  run.stdout.on('data', (chunk) => (output += chunk))
  run.stderr.on('data', (chunk) => (output += chunk))
  const [status, error] = await new Promise<[number | null, Error | undefined]>((done) => {
    run.once('error', (e) => done([null, e]))
    run.once('close', (code) => done([code, undefined]))
  })
  assert.equal(status, 0, `${error ?? ''}${output}`)
}

async function privatePage(i: Instance, jar: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${i.app.url}/private`, { headers: { cookie: jar } })
  return { status: res.status, body: await res.text() }
}

const jarOf = (i: Instance): string =>
  (JSON.parse(readFileSync(i.state, 'utf8')) as { cookies: { name: string; value: string }[] }).cookies
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-sign-in-')))
  const main = join(tmp, 'main')
  cpSync(FIXTURE, main, { recursive: true })
  const config = join(main, '.agents/config.jsonc')
  writeFileSync(config, readFileSync(config, 'utf8').replace('4300', String(await freeBase())))
  // Playwright resolves @playwright/test from the fixture's folder: link lntt's.
  execFileSync('ln', ['-s', resolve(HERE, '../node_modules'), join(main, 'node_modules')])
  git(main, 'init', '-q', '-b', 'main')
  git(main, 'add', '.')
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
  const other = join(tmp, 'other')
  git(main, 'worktree', 'add', '-q', '--detach', other)
  execFileSync('ln', ['-s', resolve(HERE, '../node_modules'), join(other, 'node_modules')])
  await start(main, 'app')
  await start(other, 'app')
})

after(() => {
  for (const i of instances) {
    i.server.kill()
    closeSync(i.fd)
  }
  rmSync(tmp, { recursive: true, force: true })
})

describe('sign-in on two instances at once', () => {
  test('each checkout runs the app on its own port', () => {
    assert.notEqual(instances[0].app.port, instances[1].app.port)
    assert.equal(instances[0].app.env?.APP_ORIGIN, `http://localhost:${instances[0].app.port}`)
  })

  test('the protected page refuses a request without a session', async () => {
    assert.equal((await privatePage(instances[0], '')).status, 401)
  })

  test('the signIn.test of each app saves a state that opens the protected page', async () => {
    await signIn(instances[0], 'alice')
    await signIn(instances[1], 'bob')
    const [a, b] = await Promise.all([
      privatePage(instances[0], jarOf(instances[0])),
      privatePage(instances[1], jarOf(instances[1])),
    ])
    assert.equal(a.status, 200)
    assert.match(a.body, /Signed in as alice/)
    assert.equal(b.status, 200)
    assert.match(b.body, /Signed in as bob/)
  })

  test('cookies are named per port: one instance ignores the other one’s session', async () => {
    // localhost cookies do not isolate ports, so both states live in one jar.
    const both = `${jarOf(instances[0])}; ${jarOf(instances[1])}`
    assert.match((await privatePage(instances[0], both)).body, /Signed in as alice/)
    assert.match((await privatePage(instances[1], both)).body, /Signed in as bob/)
    assert.equal((await privatePage(instances[1], jarOf(instances[0]))).status, 401)
  })

  test('anything but GET and POST on a known path is a 404, and a missing environment stops the server', () => {
    const i = instances[0]
    return Promise.all(
      ['PUT', 'DELETE'].map(async (method) => {
        assert.equal((await fetch(`${i.app.url}/sign-in`, { method })).status, 404)
      }),
    ).then(async () => {
      assert.equal((await fetch(`${i.app.url}/nope`)).status, 404)
      const bare = spawnSync('node', ['server.mjs'], { cwd: i.root, env: { PATH: process.env.PATH }, encoding: 'utf8' })
      assert.equal(bare.status, 1)
      assert.match(bare.stderr, /needs APP_ORIGIN, PORT and USERS/)
    })
  })

  test('a second sign-in on the same instance reads the newest code of the log', async () => {
    await signIn(instances[0], 'alice')
    // Without the first run's state, only the second run can make the page open.
    rmSync(instances[0].state)
    await signIn(instances[0], 'alice')
    assert.match((await privatePage(instances[0], jarOf(instances[0]))).body, /Signed in as alice/)
  })

  test('a sign-in that fails stops the test with Playwright’s output', async () => {
    await assert.rejects(signIn(instances[0], 'mallory'), /Expected: 202\s+Received: 404/)
  })

  test('a one-time code works once, and only the right one', async () => {
    const i = instances[0]
    const origin = i.app.env?.APP_ORIGIN ?? ''
    const post = (path: string, body: object, from = origin) =>
      fetch(i.app.url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: from },
        body: JSON.stringify(body),
      })
    assert.equal((await post('/sign-in', { login: 'alice' }, 'http://evil.example')).status, 403)
    assert.equal((await post('/sign-in', { login: 'mallory' })).status, 404)
    assert.doesNotMatch(readFileSync(i.log, 'utf8'), /mallory/)
    // A body that is not an object is refused, and the server stays up.
    for (const body of ['{', 'null', '7']) {
      const res = await fetch(`${i.app.url}/sign-in`, { method: 'POST', headers: { origin }, body })
      assert.equal(res.status, 404)
    }
    assert.equal((await post('/verify', { login: 'alice' })).status, 401)
    assert.equal((await post('/sign-in', { login: 'alice' })).status, 202)
    const code = [...readFileSync(i.log, 'utf8').matchAll(/one-time code for alice: (\d{6})/g)].at(-1)?.[1]
    assert.equal((await post('/verify', { login: 'alice', code: '000000' })).status, 401)
    assert.equal((await post('/verify', { login: 'alice' })).status, 401)
    assert.equal((await post('/verify', { login: 'alice', code })).status, 204)
    assert.equal((await post('/verify', { login: 'alice', code })).status, 401)
  })
})
