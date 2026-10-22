import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { candidateConfig } from '../src/ci/config.ts'
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

  for (const ask of ['--help', '-h', 'help']) {
    test(`${ask} prints the usage on stdout and exits 0, with no configuration`, () => {
      const run = spawnSync('node', [BIN, ask], { cwd: root, encoding: 'utf8' })
      assert.equal(run.status, 0)
      assert.match(run.stdout, /^usage: lntt /)
    })
  }
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

  test('a candidate status left out of the file takes its default, a written one is kept', () => {
    write('.agents/config.jsonc', JSON.stringify({ delivery: { candidate: { prefix: 'release/' } } }))
    assert.deepEqual(candidateConfig(root)?.status, { inRelease: 'In release', done: 'Done' })
    const candidate = { prefix: 'release/', status: { inRelease: 'To release' } }
    write('.agents/config.jsonc', JSON.stringify({ delivery: { candidate } }))
    assert.deepEqual(candidateConfig(root)?.status, { inRelease: 'To release', done: 'Done' })
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

// Writes `config` as the project's configuration and asserts that loading it fails
// with a message matching `names`: the key, or the path, the rule rejects.
function assertRejected(config: unknown, names: RegExp): void {
  write('.agents/config.jsonc', JSON.stringify(config))
  assert.throws(() => loadConfig(root), names)
}

// Runs `lntt validate` on `config`, which the schema accepts, and returns its exit
// status and stderr: the references between lists are checked there, not on load.
function validateCli(config: unknown): { status: number | null; stderr: string } {
  write('.agents/config.jsonc', JSON.stringify(config))
  const run = spawnSync(process.execPath, [BIN, 'validate'], { cwd: root, encoding: 'utf8' })
  return { status: run.status, stderr: run.stderr }
}

function assertValid(config: unknown): void {
  const run = validateCli(config)
  assert.equal(run.status, 0, run.stderr)
}

// Asserts that the configuration loads (getValue works on it) but `lntt validate`
// exits 1 with every pattern of `lines` in its message.
function assertBadReference(config: unknown, ...lines: RegExp[]): void {
  const run = validateCli(config)
  assert.doesNotThrow(() => loadConfig(root))
  assert.equal(run.status, 1, run.stderr)
  assert.match(run.stderr, /a value names no entry of its list:\n {2}\S/)
  for (const line of lines) assert.match(run.stderr, line)
}

describe('the board section', () => {
  const board = {
    project: { owner: 'DemoOrg', ownerType: 'organization', number: 1, title: 'Demo board' },
    issueTypes: { parents: ['Feature'], children: ['Task', 'Bug'] },
    fields: {
      status: {
        name: 'Status',
        type: 'singleSelect',
        options: ['Todo', 'Discussing', 'Ready', 'In progress', 'To review', 'Done'],
        initial: 'Todo',
        ready: 'Ready',
        inProgress: 'In progress',
        inReview: 'To review',
        done: 'Done',
      },
      iteration: { name: 'Iteration', type: 'iteration' },
      startDate: { name: 'Start date', kind: 'issue', type: 'date' },
      targetDate: { name: 'End Date', type: 'date' },
      classe: { name: 'Classe', type: 'singleSelect', options: ['Prodotto', 'Piattaforma', 'Debito'] },
    },
    tracks: {
      from: ['apps/*'],
      labels: {
        community: { owner: 'developer-1', paths: ['apps/community'], description: "l'app pubblica" },
        'leva:b2b': {},
      },
    },
  }
  const withStatus = (status: Record<string, unknown>) => ({
    board: { fields: { status: { ...board.fields.status, ...status } } },
  })

  test('the Project, the issue types, its fields with their options, and the track labels', () => {
    write('.agents/config.jsonc', JSON.stringify({ board }))
    const data = loadConfig(root).data
    assert.deepEqual(getValue(data, 'board.fields.classe.options'), ['Prodotto', 'Piattaforma', 'Debito'])
    assert.equal(getValue(data, 'board.fields.status.initial'), 'Todo')
    assert.equal(getValue(data, 'board.fields.status.inReview'), 'To review')
    assert.equal(getValue(data, 'board.fields.targetDate.name'), 'End Date')
    assert.equal(getValue(data, 'board.tracks.labels.community.owner'), 'developer-1')
    assert.deepEqual(getValue(data, 'board.tracks.labels.community.paths'), ['apps/community'])
  })

  test('a Project is found by its owner and a number from 1, and its owner is an organization or a user', () => {
    assertRejected({ board: { project: { title: 'Demo board' } } }, /owner|number/)
    assertRejected({ board: { project: { owner: 'someone', ownerType: 'enterprise', number: 1 } } }, /ownerType/)
    assertRejected({ board: { project: { owner: 'someone', number: 0 } } }, /\/board\/project\/number/)
  })

  test('the issue types are listed once each, and a list is never empty', () => {
    assertRejected({ board: { issueTypes: { parents: [], children: ['Task'] } } }, /\/board\/issueTypes\/parents/)
    assertRejected(
      { board: { issueTypes: { parents: ['Feature'], children: ['Task', 'Task'] } } },
      /\/issueTypes\/children/,
    )
  })

  test('a field has a name and a GitHub field type; initial and done belong to the status alone', () => {
    assertRejected({ board: { fields: { size: { name: 'Size', type: 'tshirt' } } } }, /\/board\/fields\/size\/type/)
    assertRejected({ board: { fields: { estimate: { type: 'number' } } } }, /name/)
    assertRejected({ board: { fields: { estimate: { name: 'Estimate' } } } }, /type/)
    const scope = { name: 'Scope', type: 'singleSelect', options: ['Now'], done: 'Now' }
    assertRejected({ board: { fields: { scope } } }, /done/)
  })

  test('a field is a custom field of the Project or an issue field, nothing else', () => {
    assertRejected(
      { board: { fields: { startDate: { name: 'Start', kind: 'item', type: 'date' } } } },
      /\/startDate\/kind/,
    )
  })

  test('a single select lists its options, once each; another type has none', () => {
    assertRejected({ board: { fields: { priority: { name: 'Priority', type: 'singleSelect' } } } }, /options/)
    const twice = { name: 'Priority', type: 'singleSelect', options: ['P0', 'P0'] }
    assertRejected({ board: { fields: { priority: twice } } }, /\/board\/fields\/priority\/options/)
    const none = { name: 'Priority', type: 'singleSelect', options: [] }
    assertRejected({ board: { fields: { priority: none } } }, /\/board\/fields\/priority\/options/)
    const dated = { name: 'Start date', type: 'date', options: ['Monday'] }
    assertRejected({ board: { fields: { startDate: dated } } }, /\/board\/fields\/startDate/)
  })

  test('the status is a single select with its options', () => {
    assertRejected(withStatus({ type: 'text' }), /\/board\/fields\/status\/type/)
    const { options: _, ...noOptions } = board.fields.status
    assertRejected({ board: { fields: { status: noOptions } } }, /options/)
  })

  test('lntt validate: every status role is one of the options, and the error names the role and the options', () => {
    assertBadReference(
      withStatus({ inReview: 'In review' }),
      /board\.fields\.status\.inReview.*Todo, Discussing, Ready/,
    )
    assertBadReference(withStatus({ initial: 'Backlog' }), /board\.fields\.status\.initial/)
    assertBadReference(withStatus({ ready: 'Ready!' }), /board\.fields\.status\.ready/)
    assertBadReference(withStatus({ inProgress: 'Doing' }), /board\.fields\.status\.inProgress/)
    assertBadReference(withStatus({ done: 'Closed' }), /board\.fields\.status\.done/)
  })

  test('lntt validate: a role left unset is checked by its default, and the defaults pass when they are options', () => {
    const options = ['Backlog', 'Ready', 'In progress', 'In review', 'Done']
    assertValid({ board: { fields: { status: { name: 'Status', type: 'singleSelect', options } } } })
    const noReview = options.filter((option) => option !== 'In review')
    assertBadReference(
      { board: { fields: { status: { name: 'Status', type: 'singleSelect', options: noReview } } } },
      /board\.fields\.status\.inReview is "In review"/,
    )
  })

  test('lntt validate: every wrong value is a line of the same message', () => {
    assertBadReference(
      withStatus({ ready: 'Ready!', done: 'Closed' }),
      /board\.fields\.status\.ready is "Ready!"/,
      /board\.fields\.status\.done is "Closed"/,
    )
  })

  test("lntt validate: the candidate's statuses are options of the status too, defaults included", () => {
    const status = { inRelease: 'To review', done: 'Done' }
    assertValid({ ...withStatus({}), delivery: { candidate: { prefix: 'r/', status } } })
    assertBadReference(
      { ...withStatus({}), delivery: { candidate: { prefix: 'r/', status: { inRelease: 'In release' } } } },
      /delivery\.candidate\.status\.inRelease.*Todo, Discussing/,
    )
    assertBadReference(
      { ...withStatus({}), delivery: { candidate: { prefix: 'r/' } } },
      /delivery\.candidate\.status\.inRelease is "In release"/,
    )
    assertValid({ ...withStatus({}), delivery: { candidate: { prefix: 'r/', status: { inRelease: 'To review' } } } })
  })

  test('a status role that is not an option still loads: the check is lntt validate, not every read', () => {
    write('.agents/config.jsonc', JSON.stringify(withStatus({ done: 'Closed' })))
    assert.equal(getValue(loadConfig(root).data, 'board.fields.status.done'), 'Closed')
  })

  test('lntt set renames a status option although the roles still name the old one', () => {
    write('.agents/config.jsonc', JSON.stringify(withStatus({})))
    setValue(root, 'board.fields.status.options', ['Todo', 'Discussing', 'Ready', 'In progress', 'In review', 'Done'])
    assert.equal(getValue(loadConfig(root).data, 'board.fields.status.options.4'), 'In review')
  })

  test("a project's own field is a camelCase key", () => {
    const Classe = { name: 'Classe', type: 'singleSelect', options: ['Prodotto'] }
    assertRejected({ board: { fields: { Classe } } }, /\/board\/fields/)
  })

  test('a track owner is a GitHub handle', () => {
    assertRejected(
      { board: { tracks: { labels: { admin: { owner: 'developer 1' } } } } },
      /\/tracks\/labels\/admin\/owner/,
    )
  })

  test('lntt validate: a track owner is one of team.members, when the team lists them', () => {
    const tracks = { labels: { admin: { owner: 'developer-2' } } }
    assertValid({ board: { tracks } })
    const team = { members: { 'developer-1': { role: 'developer' } } }
    assertBadReference({ board: { tracks }, team }, /board\.tracks\.labels\.admin\.owner is "developer-2".*developer-1/)
    assertValid({ board: { tracks: { labels: { admin: { owner: 'developer-1' } } } }, team })
  })

  test('track paths are relative to the repository root and never leave it', () => {
    assertRejected({ board: { tracks: { from: ['/apps/*'] } } }, /\/board\/tracks\/from/)
    assertRejected({ board: { tracks: { from: ['apps/../../*'] } } }, /\/board\/tracks\/from/)
    assertRejected({ board: { tracks: { from: ['apps/..'] } } }, /\/board\/tracks\/from/)
    assertRejected({ board: { tracks: { from: ['apps/../x'] } } }, /\/board\/tracks\/from/)
    assertRejected({ board: { tracks: { labels: { admin: { paths: ['..'] } } } } }, /\/labels\/admin\/paths/)
    assertRejected({ board: { tracks: { labels: { admin: { paths: ['/apps/admin'] } } } } }, /\/labels\/admin\/paths/)
    write('.agents/config.jsonc', JSON.stringify({ board: { tracks: { from: ['apps/*', '..apps/x'] } } }))
    assert.deepEqual(getValue(loadConfig(root).data, 'board.tracks.from'), ['apps/*', '..apps/x'])
  })
})

describe('the cycle section', () => {
  test('the iteration and where a retrospective is published', () => {
    const cycle = {
      iteration: { days: 14, startDay: 1 },
      retrospective: {
        target: { kind: 'issue', title: 'Retrospective — {window}' },
        targetedReview: { line: 'Unstable tests', minPullRequests: 2 },
      },
    }
    write('.agents/config.jsonc', JSON.stringify({ cycle }))
    assert.equal(getValue(loadConfig(root).data, 'cycle.retrospective.targetedReview.line'), 'Unstable tests')
  })

  test('a retrospective published as a Discussion names its category', () => {
    const target = { kind: 'discussion', category: 'Ideas', title: 'Retrospettiva — {window}' }
    write('.agents/config.jsonc', JSON.stringify({ cycle: { retrospective: { target } } }))
    assert.equal(getValue(loadConfig(root).data, 'cycle.retrospective.target.category'), 'Ideas')
    const { category: _, ...noCategory } = target
    assertRejected({ cycle: { retrospective: { target: noCategory } } }, /category/)
  })

  test('the title holds the window, the targeted title the subject', () => {
    const target = { kind: 'issue', title: 'Retrospective', targetedTitle: 'Retrospective — {subject}' }
    assertRejected({ cycle: { retrospective: { target } } }, /\/cycle\/retrospective\/target\/title/)
    const targeted = { ...target, title: 'Retrospective — {window}' }
    write('.agents/config.jsonc', JSON.stringify({ cycle: { retrospective: { target: targeted } } }))
    assert.equal(
      getValue(loadConfig(root).data, 'cycle.retrospective.target.targetedTitle'),
      'Retrospective — {subject}',
    )
    const noSubject = { ...targeted, targetedTitle: 'Targeted retrospective' }
    assertRejected({ cycle: { retrospective: { target: noSubject } } }, /\/target\/targetedTitle/)
  })

  test('an iteration starts on a day of the week, 1 to 7, and lasts 1 to 31 days', () => {
    assertRejected({ cycle: { iteration: { days: 7, startDay: 8 } } }, /startDay/)
    assertRejected({ cycle: { iteration: { days: 0 } } }, /\/cycle\/iteration\/days/)
    assertRejected({ cycle: { iteration: { days: 32 } } }, /\/cycle\/iteration\/days/)
  })

  test('a targeted review names its line, and needs it in two pull requests at least', () => {
    assertRejected(
      { cycle: { retrospective: { targetedReview: { line: 'Unstable tests', minPullRequests: 1 } } } },
      /minPull/,
    )
    assertRejected({ cycle: { retrospective: { targetedReview: { minPullRequests: 2 } } } }, /line/)
  })

  test('lntt validate: the targeted line is one of the retrospective lines, when they are listed', () => {
    const cycle = { retrospective: { targetedReview: { line: 'Flaky tests' } } }
    assertValid({ cycle })
    const pullRequest = { retrospective: { lines: ['Friction', 'Unstable tests'] } }
    assertBadReference(
      { cycle, delivery: { pullRequest } },
      /cycle\.retrospective\.targetedReview\.line is "Flaky tests".*Friction, Unstable tests/,
    )
    const fixed = { retrospective: { targetedReview: { line: 'Unstable tests' } } }
    assertValid({ cycle: fixed, delivery: { pullRequest } })
  })
})

describe('ci providers and drafts', () => {
  test('the providers the cloud CI runs on, and whether it runs on drafts', () => {
    write('.agents/config.jsonc', JSON.stringify({ ci: { providers: ['circleci', 'github-actions'], drafts: false } }))
    assert.deepEqual(getValue(loadConfig(root).data, 'ci.providers'), ['circleci', 'github-actions'])
  })

  test('an unknown or repeated provider is named', () => {
    assertRejected({ ci: { providers: ['jenkins'] } }, /\/ci\/providers/)
    assertRejected({ ci: { providers: ['circleci', 'circleci'] } }, /\/ci\/providers/)
  })

  test('drafts is a yes or a no, as a boolean', () => {
    assertRejected({ ci: { drafts: 'no' } }, /\/ci\/drafts/)
  })
})

describe('delivery.pullRequest and delivery.commits.trailers', () => {
  const pullRequest = {
    language: 'it',
    template: '.github/pull_request_template.md',
    closing: ['Closes', 'Refs'],
    outcome: { done: '— fatto', notApplicable: '— non applicabile perché' },
    retrospective: { heading: '🔁 Retrospettiva', lines: ['Attrito', 'Causa di rilavoro'], none: 'nessuno' },
  }

  test('the pull request body: language, closing keywords, outcome keywords, the retrospective block', () => {
    write('.agents/config.jsonc', JSON.stringify({ delivery: { pullRequest } }))
    assert.equal(getValue(loadConfig(root).data, 'delivery.pullRequest.outcome.done'), '— fatto')
  })

  test('the outcome has a done and a not-applicable keyword, nothing else', () => {
    const outcome = { ...pullRequest.outcome, partial: '— in parte' }
    assertRejected({ delivery: { pullRequest: { ...pullRequest, outcome } } }, /partial/)
  })

  test('the language is a language tag', () => {
    assertRejected({ delivery: { pullRequest: { ...pullRequest, language: 'Italian' } } }, /\/pullRequest\/language/)
  })

  test('the trailers a project uses, named as longTrailers names them', () => {
    const trailers = { Retro: 'a signal for the retrospective', 'Removed-section': 'a heading a commit removes' }
    write('.agents/config.jsonc', JSON.stringify({ delivery: { commits: { trailers } } }))
    assert.equal(getValue(loadConfig(root).data, 'delivery.commits.trailers.Retro'), trailers.Retro)
    assertRejected({ delivery: { commits: { trailers: { 'Removed section': 'x' } } } }, /\/delivery\/commits\/trailers/)
    assertRejected({ delivery: { commits: { trailers: { Retro2: 'x' } } } }, /\/delivery\/commits\/trailers/)
  })
})

describe('the spaces section', () => {
  test('each space has one or more paths, whether git tracks it, and where it is archived', () => {
    const spaces = {
      reference: { path: 'reference/' },
      prototypes: { path: ['prototypes/', 'apps/design-system/src/Explorations/'], archive: 'reference/prototypes/' },
      notes: { path: 'appunti/', tracked: false },
    }
    write('.agents/config.jsonc', JSON.stringify({ spaces }))
    assert.equal(getValue(loadConfig(root).data, 'spaces.notes.tracked'), false)
  })

  test('a space needs its path, and an unknown key is named', () => {
    assertRejected({ spaces: { notes: { tracked: false } } }, /path/)
    assertRejected({ spaces: { notes: { path: 'appunti/', retention: '30d' } } }, /retention/)
  })

  test('a space is named in lowercase', () => {
    assertRejected({ spaces: { Notes: { path: 'appunti/' } } }, /\/spaces/)
  })
})

describe('the team section', () => {
  test('members by GitHub handle, with their role and the paths whose code they own', () => {
    const team = { language: 'it', members: { 'maintainer-1': { role: 'maintainer', owns: ['apps/admin/', '*'] } } }
    write('.agents/config.jsonc', JSON.stringify({ team }))
    assert.deepEqual(getValue(loadConfig(root).data, 'team.members.maintainer-1.owns'), ['apps/admin/', '*'])
  })

  test('has no place for what is personal: that stays in the operator profile', () => {
    const members = { 'maintainer-1': { role: 'maintainer', email: 'someone@example.com' } }
    assertRejected({ team: { members } }, /email/)
  })

  test('a member is a GitHub handle, the language a language tag', () => {
    assertRejected({ team: { members: { developer_1: { role: 'developer' } } } }, /\/team\/members/)
    assertRejected({ team: { language: 'Italiano' } }, /\/team\/language/)
  })
})

describe('the configurations of the projects the starter was ported from', () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/config')
  const distinct: Record<string, Record<string, unknown>> = {
    wai: {
      'cycle.iteration.days': 7,
      'cycle.iteration.startDay': 3,
      'cycle.retrospective.target.kind': 'discussion',
      'cycle.retrospective.target.category': 'Ideas',
      'cycle.retrospective.target.targetedTitle': 'Retrospettiva mirata — {subject}',
      'delivery.pullRequest.outcome.done': '— fatto',
      'delivery.commits.longTrailers': ['Retro', 'Removed-section'],
      'ci.providers': ['github-actions'],
      'board.fields.scope.options': ['Now', 'Next', 'Not now'],
      'board.fields.status.inReview': 'In review',
      'board.tracks.labels.Amministrazione.paths': ['apps/admin'],
    },
    pelion: {
      'cycle.iteration.days': 14,
      'cycle.iteration.startDay': 1,
      'cycle.retrospective.target.kind': 'issue',
      'delivery.pullRequest.outcome.done': '— done',
      'delivery.branches.types': ['feat', 'fix', 'chore', 'refactor', 'docs', 'test', 'ci'],
      'ci.providers': ['circleci', 'github-actions'],
      'board.fields.scope.options': ['Now', 'Next', 'Later', 'Not now', 'Permanent'],
      'board.fields.classe.options': ['Prodotto', 'Piattaforma', 'Debito'],
      'board.fields.status.inReview': 'To review',
      'board.fields.targetDate.name': 'End Date',
      'delivery.candidate.prefix': 'release/',
    },
  }

  for (const [project, values] of Object.entries(distinct)) {
    test(`${project}: lntt validate accepts it, and it carries the values that set it apart`, () => {
      write('.agents/config.jsonc', readFileSync(join(FIXTURES, `${project}.jsonc`), 'utf8'))
      const valid = spawnSync(process.execPath, [BIN, 'validate'], { cwd: root, encoding: 'utf8' })
      assert.equal(valid.status, 0, valid.stderr)
      const data = loadConfig(root).data
      for (const [key, value] of Object.entries(values)) assert.deepEqual(getValue(data, key), value, key)
    })
  }

  test('pelion holds an open decision in Discussing, wai has no such status', () => {
    const options = (project: string) => {
      write('.agents/config.jsonc', readFileSync(join(FIXTURES, `${project}.jsonc`), 'utf8'))
      return getValue(loadConfig(root).data, 'board.fields.status.options') as string[]
    }
    assert.ok(options('pelion').includes('Discussing'))
    assert.ok(!options('wai').includes('Discussing'))
  })

  test("pelion's fixture has no long-trailer exemption: delivery.commits.longTrailers is absent", () => {
    write('.agents/config.jsonc', readFileSync(join(FIXTURES, 'pelion.jsonc'), 'utf8'))
    const delivery = getValue(loadConfig(root).data, 'delivery') as Record<string, unknown>
    const commits = (delivery.commits ?? {}) as Record<string, unknown>
    assert.equal(Object.hasOwn(commits, 'longTrailers'), false)
  })
})
