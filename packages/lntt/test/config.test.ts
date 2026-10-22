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

describe('the board section', () => {
  const board = {
    project: { owner: 'DemoOrg', ownerType: 'organization', number: 1, title: 'Demo board' },
    issueTypes: { parents: ['Feature'], children: ['Task', 'Bug'] },
    fields: {
      status: {
        name: 'Status',
        type: 'singleSelect',
        options: ['Todo', 'Discussing', 'Ready', 'Done'],
        initial: 'Todo',
        done: 'Done',
      },
      iteration: { name: 'Iteration', type: 'iteration' },
      startDate: { name: 'Start date', kind: 'issue', type: 'date' },
      classe: { name: 'Classe', type: 'singleSelect', options: ['Prodotto', 'Piattaforma', 'Debito'] },
    },
    tracks: {
      from: ['apps/*'],
      labels: { community: { owner: 'developer-1', description: 'apps/community' }, 'leva:b2b': {} },
    },
  }

  test('the Project, the issue types, its fields with their options, and the track labels', () => {
    write('.agents/config.jsonc', JSON.stringify({ board }))
    const data = loadConfig(root).data
    assert.deepEqual(getValue(data, 'board.fields.classe.options'), ['Prodotto', 'Piattaforma', 'Debito'])
    assert.equal(getValue(data, 'board.fields.status.initial'), 'Todo')
    assert.equal(getValue(data, 'board.tracks.labels.community.owner'), 'developer-1')
  })

  test('a Project is found by its owner and number, and its owner is an organization or a user', () => {
    write('.agents/config.jsonc', JSON.stringify({ board: { project: { title: 'Demo board' } } }))
    assert.throws(() => loadConfig(root), /owner|number/)
    const project = { owner: 'someone', ownerType: 'enterprise', number: 1 }
    write('.agents/config.jsonc', JSON.stringify({ board: { project } }))
    assert.throws(() => loadConfig(root), /ownerType/)
  })

  test('a field has a GitHub field type; initial and done belong to the status alone', () => {
    const size = { name: 'Size', type: 'tshirt' }
    write('.agents/config.jsonc', JSON.stringify({ board: { fields: { size } } }))
    assert.throws(() => loadConfig(root), /\/board\/fields\/size\/type/)
    const scope = { name: 'Scope', type: 'singleSelect', options: ['Now'], done: 'Now' }
    write('.agents/config.jsonc', JSON.stringify({ board: { fields: { scope } } }))
    assert.throws(() => loadConfig(root), /done/)
  })

  test("a project's own field is a camelCase key", () => {
    const Classe = { name: 'Classe', type: 'singleSelect', options: ['Prodotto'] }
    write('.agents/config.jsonc', JSON.stringify({ board: { fields: { Classe } } }))
    assert.throws(() => loadConfig(root), /\/board\/fields/)
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
    write('.agents/config.jsonc', JSON.stringify({ cycle: { retrospective: { target: noCategory } } }))
    assert.throws(() => loadConfig(root), /category/)
  })

  test('an iteration starts on a day of the week, 1 to 7', () => {
    write('.agents/config.jsonc', JSON.stringify({ cycle: { iteration: { days: 7, startDay: 8 } } }))
    assert.throws(() => loadConfig(root), /startDay/)
  })

  test('a targeted review needs the same line in two pull requests at least', () => {
    const targetedReview = { line: 'Unstable tests', minPullRequests: 1 }
    write('.agents/config.jsonc', JSON.stringify({ cycle: { retrospective: { targetedReview } } }))
    assert.throws(() => loadConfig(root), /minPullRequests/)
  })
})

describe('ci providers and drafts', () => {
  test('the providers the cloud CI runs on, and whether it runs on drafts', () => {
    write('.agents/config.jsonc', JSON.stringify({ ci: { providers: ['circleci', 'github-actions'], drafts: false } }))
    assert.deepEqual(getValue(loadConfig(root).data, 'ci.providers'), ['circleci', 'github-actions'])
  })

  test('an unknown provider is named', () => {
    write('.agents/config.jsonc', JSON.stringify({ ci: { providers: ['jenkins'] } }))
    assert.throws(() => loadConfig(root), /\/ci\/providers/)
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
    write('.agents/config.jsonc', JSON.stringify({ delivery: { pullRequest: { ...pullRequest, outcome } } }))
    assert.throws(() => loadConfig(root), /partial/)
  })

  test('the trailers a project uses, by their capitalised name', () => {
    const trailers = { Retro: 'a signal for the retrospective', 'Removed-section': 'a heading a commit removes' }
    write('.agents/config.jsonc', JSON.stringify({ delivery: { commits: { trailers } } }))
    assert.equal(getValue(loadConfig(root).data, 'delivery.commits.trailers.Retro'), trailers.Retro)
    write('.agents/config.jsonc', JSON.stringify({ delivery: { commits: { trailers: { retro: 'x' } } } }))
    assert.throws(() => loadConfig(root), /\/delivery\/commits\/trailers/)
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
    write('.agents/config.jsonc', JSON.stringify({ spaces: { notes: { tracked: false } } }))
    assert.throws(() => loadConfig(root), /path/)
    write('.agents/config.jsonc', JSON.stringify({ spaces: { notes: { path: 'appunti/', retention: '30d' } } }))
    assert.throws(() => loadConfig(root), /retention/)
  })
})

describe('the team section', () => {
  test('members by GitHub handle, with their role and what they own', () => {
    const team = { language: 'it', members: { 'maintainer-1': { role: 'maintainer', owns: ['infrastructure'] } } }
    write('.agents/config.jsonc', JSON.stringify({ team }))
    assert.deepEqual(getValue(loadConfig(root).data, 'team.members.maintainer-1.owns'), ['infrastructure'])
  })

  test('has no place for what is personal: that stays in the operator profile', () => {
    const members = { 'maintainer-1': { role: 'maintainer', email: 'someone@example.com' } }
    write('.agents/config.jsonc', JSON.stringify({ team: { members } }))
    assert.throws(() => loadConfig(root), /email/)
  })
})

describe('the configurations of the projects the starter was ported from', () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/config')
  const distinct: Record<string, Record<string, unknown>> = {
    wai: {
      'cycle.iteration.days': 7,
      'cycle.retrospective.target.kind': 'discussion',
      'cycle.retrospective.target.category': 'Ideas',
      'delivery.pullRequest.outcome.done': '— fatto',
      'ci.providers': ['github-actions'],
      'board.fields.scope.options': ['Now', 'Next', 'Not now'],
    },
    pelion: {
      'cycle.iteration.days': 14,
      'cycle.retrospective.target.kind': 'issue',
      'delivery.pullRequest.outcome.done': '— done',
      'ci.providers': ['circleci', 'github-actions'],
      'board.fields.scope.options': ['Now', 'Next', 'Later', 'Not now', 'Permanent'],
      'board.fields.classe.options': ['Prodotto', 'Piattaforma', 'Debito'],
      'delivery.candidate.prefix': 'release/',
    },
  }

  for (const [project, values] of Object.entries(distinct)) {
    test(`${project}: the whole file is valid, with the values that set it apart`, () => {
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
})
