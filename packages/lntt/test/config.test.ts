import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ConfigError, findConfig, getValue, loadConfig, setValue } from '../src/index.ts'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

const JSONC = `{
  // The decision logs of this repo.
  "recording": {
    "language": "en", // records are written in English
    "logs": {
      "adr": { "path": "docs/adr" }
    }
  }
}
`

const YAML = `# The decision logs of this repo.
recording:
  language: en # records are written in English
  logs:
    adr:
      path: docs/adr
`

let root: string

function write(file: string, content: string): string {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-project-config-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('finding the file', () => {
  test('walks up from a subdirectory to .agents/config.jsonc', () => {
    const path = write('.agents/config.jsonc', JSONC)
    mkdirSync(join(root, 'packages/deep/src'), { recursive: true })
    assert.deepEqual(findConfig(join(root, 'packages/deep/src')), { path, format: 'jsonc' })
  })

  test('finds .agents/config.yml', () => {
    const path = write('.agents/config.yml', YAML)
    assert.deepEqual(findConfig(root), { path, format: 'yaml' })
  })

  test('refuses a directory that has both formats, naming them', () => {
    write('.agents/config.jsonc', JSONC)
    write('.agents/config.yml', YAML)
    assert.throws(
      () => findConfig(root),
      (e: unknown) => {
        assert.ok(e instanceof ConfigError)
        assert.match(e.message, /config\.jsonc/)
        assert.match(e.message, /config\.yml/)
        return true
      },
    )
  })

  test('says so when there is none', () => {
    assert.throws(() => findConfig(root), /no \.agents\/config\.jsonc or \.agents\/config\.yml/)
  })
})

describe('reading and validating', () => {
  test('JSONC and YAML give the same data, comments ignored', () => {
    write('.agents/config.jsonc', JSONC)
    const fromJsonc = loadConfig(root).data
    rmSync(join(root, '.agents/config.jsonc'))
    write('.agents/config.yml', YAML)
    assert.deepEqual(loadConfig(root).data, fromJsonc)
    assert.equal(getValue(fromJsonc, 'recording.logs.adr.path'), 'docs/adr')
  })

  test('accepts the $schema key editors use', () => {
    write('.agents/config.jsonc', `{ "$schema": "../schema.json", "recording": { "logs": {} } }`)
    assert.deepEqual(loadConfig(root).data.recording, { logs: {} })
  })

  test('rejects an unknown section, naming it', () => {
    write('.agents/config.jsonc', `{ "recordin": { "logs": {} } }`)
    assert.throws(() => loadConfig(root), /recordin/)
  })

  test('rejects a value of the wrong type, naming where', () => {
    write('.agents/config.yml', 'recording:\n  logs:\n    adr:\n      path: 42\n')
    assert.throws(() => loadConfig(root), /\/recording\/logs\/adr\/path/)
  })

  test('reports a JSONC syntax error instead of reading half a file', () => {
    write('.agents/config.jsonc', '{ "recording": { "logs": { } ')
    assert.throws(() => loadConfig(root), ConfigError)
  })

  test('getValue fails on a missing key rather than returning undefined', () => {
    write('.agents/config.jsonc', JSONC)
    assert.throws(() => getValue(loadConfig(root).data, 'recording.logs.pdr.path'), /recording\.logs\.pdr/)
  })
})

describe('writing keeps the comments', () => {
  test('JSONC', () => {
    const path = write('.agents/config.jsonc', JSONC)
    setValue(root, 'recording.logs.process', { path: 'docs/process' })
    const text = readFileSync(path, 'utf8')
    assert.match(text, /\/\/ The decision logs of this repo\./)
    assert.match(text, /\/\/ records are written in English/)
    assert.equal(getValue(loadConfig(root).data, 'recording.logs.process.path'), 'docs/process')
  })

  test('YAML', () => {
    const path = write('.agents/config.yml', YAML)
    setValue(root, 'recording.logs.process', { path: 'docs/process' })
    const text = readFileSync(path, 'utf8')
    assert.match(text, /# The decision logs of this repo\./)
    assert.match(text, /# records are written in English/)
    assert.equal(getValue(loadConfig(root).data, 'recording.logs.process.path'), 'docs/process')
  })

  test('refuses to write a value the schema rejects, leaving the file as it was', () => {
    const path = write('.agents/config.jsonc', JSONC)
    assert.throws(() => setValue(root, 'recording.language', 7), ConfigError)
    assert.equal(readFileSync(path, 'utf8'), JSONC)
  })
})

describe('the command line', () => {
  test('get prints plain JSON that jq can read', () => {
    write('.agents/config.jsonc', JSONC)
    const out = execFileSync('node', [BIN, 'get', 'recording.logs'], { cwd: root, encoding: 'utf8' })
    assert.deepEqual(JSON.parse(out), { adr: { path: 'docs/adr' } })
  })

  test('set writes a JSON value', () => {
    write('.agents/config.yml', YAML)
    execFileSync('node', [BIN, 'set', 'recording.language', '"it"'], { cwd: root })
    assert.equal(getValue(loadConfig(root).data, 'recording.language'), 'it')
  })

  test('path and validate', () => {
    const path = write('.agents/config.jsonc', JSONC)
    assert.equal(execFileSync('node', [BIN, 'path'], { cwd: root, encoding: 'utf8' }).trim(), path)
    assert.equal(spawnSync('node', [BIN, 'validate'], { cwd: root }).status, 0)
  })

  test('an invalid file exits 1 with the reason on stderr', () => {
    write('.agents/config.jsonc', `{ "recordin": {} }`)
    const run = spawnSync('node', [BIN, 'validate'], { cwd: root, encoding: 'utf8' })
    assert.equal(run.status, 1)
    assert.match(run.stderr, /recordin/)
  })

  test('a usage error exits 2', () => {
    assert.equal(spawnSync('node', [BIN, 'frobnicate'], { cwd: root }).status, 2)
  })
})

describe('the local section', () => {
  const web = {
    description: 'The members site',
    port: 5173,
    url: 'http://localhost:{port}',
    readyPath: '/',
    commands: { start: { run: 'pnpm --filter @demo/web dev --port {port}', description: 'Dev server' } },
    env: { APP_ORIGIN: 'http://localhost:{port}' },
    signIn: { test: 'apps/web/e2e/auth.setup.ts', doc: 'docs/process/local.md#web' },
    users: { member: { login: 'member@demo.test', role: 'member' } },
  }

  test('describes each app: commands, base port, URL, sign-in pointers, seeded users', () => {
    write('.agents/config.jsonc', JSON.stringify({ local: { infra: { up: 'pnpm infra:up' }, apps: { web } } }))
    assert.equal(getValue(loadConfig(root).data, 'local.apps.web.commands.start.run'), web.commands.start.run)
  })

  test('has no place for a password: how to sign in is the test or docs/process/local.md', () => {
    const users = { member: { login: 'm@x', password: 'x' } }
    write('.agents/config.jsonc', JSON.stringify({ local: { apps: { web: { ...web, users } } } }))
    assert.throws(() => loadConfig(root), /password/)
  })

  test('an app needs a base port, a URL and a start command', () => {
    write('.agents/config.jsonc', JSON.stringify({ local: { apps: { web: { url: 'http://localhost:{port}' } } } }))
    assert.throws(() => loadConfig(root), /port|commands/)
  })
})

describe('the ci section', () => {
  const local = {
    cloudOnly: { 'release.yml': 'publishes to npm', 'circleci/deploy': 'deploys' },
    fake: { secrets: { CANARY: 'not-a-secret' }, vars: { REGION: 'eu' } },
    actions: { 'actions/upload-artifact': { skip: 'nothing to upload' }, 'owner/lint': { run: 'pnpm lint' } },
  }

  test('declares cloud-only jobs, fake values and local stand-ins for actions', () => {
    write('.agents/config.jsonc', JSON.stringify({ ci: { local } }))
    assert.equal(getValue(loadConfig(root).data, 'ci.local.fake.secrets.CANARY'), 'not-a-secret')
  })

  test('a cloud-only job needs its reason', () => {
    write('.agents/config.jsonc', JSON.stringify({ ci: { local: { cloudOnly: { 'release.yml': '' } } } }))
    assert.throws(() => loadConfig(root), /cloudOnly/)
  })

  test('an action maps to a command or to a skip with its reason, not both', () => {
    write('.agents/config.jsonc', JSON.stringify({ ci: { local: { actions: { 'a/b': { run: 'x', skip: 'y' } } } } }))
    assert.throws(() => loadConfig(root), /actions/)
  })
})

describe('delivery.candidate', () => {
  test('the candidate prefix, the base and the hotfix markers', () => {
    const candidate = { base: 'main', prefix: 'candidate/', hotfix: { prefix: 'hotfix/', label: 'hotfix' } }
    write('.agents/config.jsonc', JSON.stringify({ delivery: { candidate } }))
    assert.equal(getValue(loadConfig(root).data, 'delivery.candidate.prefix'), 'candidate/')
  })

  test("pelion's release/ is a prefix like any other; only the prefix is required", () => {
    write('.agents/config.jsonc', JSON.stringify({ delivery: { candidate: { prefix: 'release/' } } }))
    assert.equal(getValue(loadConfig(root).data, 'delivery.candidate.prefix'), 'release/')
    write('.agents/config.jsonc', JSON.stringify({ delivery: { candidate: { base: 'main' } } }))
    assert.throws(() => loadConfig(root), /prefix/)
  })

  test('a prefix ends with a separator, so candidate/1 is never confused with candidate1x', () => {
    write('.agents/config.jsonc', JSON.stringify({ delivery: { candidate: { prefix: 'candidate' } } }))
    assert.throws(() => loadConfig(root), /prefix/)
  })
})
