import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  collectDump,
  detectHarness,
  environmentSecrets,
  fenceFor,
  installKind,
  redact,
  renderDump,
  runFailing,
  withAgent,
} from '../src/dump.ts'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

describe('redact', () => {
  const context = { home: '/Users/ada', remotes: ['git@github.com:acme/secret-app.git'], secrets: ['s3cr3t-value'] }

  test('the home path becomes ~', () => {
    assert.equal(
      redact('/Users/ada/Developer/app/.agents/config.jsonc', context),
      '~/Developer/app/.agents/config.jsonc',
    )
    assert.equal(redact('/Users/adam/x', context), '/Users/adam/x', 'another user whose name starts the same')
  })

  test("the project's remotes, and any URL carrying credentials", () => {
    assert.equal(redact('origin git@github.com:acme/secret-app.git (fetch)', context), 'origin <remote> (fetch)')
    assert.equal(redact('see https://ada:pw@git.example.com/x.git', context), 'see <url with credentials>')
    assert.equal(redact('git@gitlab.com:acme/other.git', context), '<remote>')
  })

  test('emails', () => {
    assert.equal(redact('author ada.lovelace+x@example.co.uk wrote', context), 'author <email> wrote')
    assert.equal(redact('pnpm@10.16.1 and @lntt/lntt@0.6.2', context), 'pnpm@10.16.1 and @lntt/lntt@0.6.2')
  })

  test('tokens by their shape, and the values of secret-looking keys', () => {
    for (const token of [
      `ghp_${'a'.repeat(36)}`,
      `github_pat_${'B'.repeat(40)}`,
      `sk-ant-api03-${'c'.repeat(40)}`,
      `xoxb-${'1'.repeat(12)}-abc`,
      'AKIAABCDEFGHIJKLMNOP',
      `eyJ${'a'.repeat(10)}.${'b'.repeat(10)}.${'c'.repeat(10)}`,
    ]) {
      assert.equal(redact(`x ${token} y`, context), 'x <token> y', token)
    }
    assert.equal(redact('Authorization: Bearer abc.def', context), 'Authorization: Bearer <token>')
    assert.equal(redact('"apiKey": "abc123"', context), '"apiKey": "<redacted>"')
    assert.equal(redact('DB_PASSWORD=hunter2 next', context), 'DB_PASSWORD=<redacted> next')
    assert.equal(redact('"tokens": 1200', context), '"tokens": 1200', 'a count is no secret')
  })

  test('a secret held in the environment, wherever it appears', () => {
    assert.equal(redact('the value s3cr3t-value leaked', context), 'the value <redacted> leaked')
  })

  test('a short secret of the environment, and a remote with no separator, are left alone', () => {
    assert.deepEqual(
      environmentSecrets({ MY_TOKEN: 'abc', EMPTY_SECRET: '', API_KEY: 'abcdefgh', PATH: 'abcdefghij' }),
      ['abcdefgh'],
    )
    const garbling = { home: '/Users/ada', remotes: ['.', '../x', 'origin'], secrets: [] }
    assert.equal(redact('a ./b and ../x/y', garbling), 'a ./b and ../x/y')
  })
})

describe('detectHarness', () => {
  test('the model of ANTHROPIC_MODEL only under Claude Code', () => {
    const root = mkdtempSync(join(tmpdir(), 'lntt-dump-model-'))
    try {
      const model = (env: Record<string, string>) => collectDump({ root, env, version: () => null }).model
      assert.equal(model({ CLAUDECODE: '1', ANTHROPIC_MODEL: 'opus' }), 'opus')
      assert.equal(model({ OPENCODE: '1', ANTHROPIC_MODEL: 'opus' }), 'not given')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Claude Code, Codex and OpenCode by their variables; unknown otherwise', () => {
    assert.equal(detectHarness({ CLAUDECODE: '1' }), 'Claude Code')
    assert.equal(detectHarness({ CODEX_SANDBOX: 'seatbelt' }), 'Codex')
    assert.equal(detectHarness({ OPENCODE: '1' }), 'OpenCode')
    assert.equal(detectHarness({}), null)
  })
})

describe('installKind', () => {
  test('from source, a dependency of the project, or from outside it', () => {
    assert.equal(installKind('/r/packages/lntt', '/r'), 'from source (a workspace package)')
    assert.equal(
      installKind('/r/node_modules/.pnpm/@lntt+lntt@0.6.2/node_modules/@lntt/lntt', '/r'),
      'a dependency of the project',
    )
    assert.equal(installKind('/home/u/.npm/_npx/abc/node_modules/@lntt/lntt', '/r'), 'npx')
    assert.equal(installKind('/opt/homebrew/lib/node_modules/@lntt/lntt', '/r'), 'outside the project (global)')
  })
})

describe('collectDump', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-dump-')))
    mkdirSync(join(root, '.agents/skills/review'), { recursive: true })
    mkdirSync(join(root, '.claude/skills/review'), { recursive: true })
    mkdirSync(join(root, '.claude/skills/deploy'), { recursive: true })
    mkdirSync(join(root, 'node_modules/@lntt/biome-config'), { recursive: true })
    writeFileSync(join(root, '.agents/config.jsonc'), '{ "delivery": { "commits": { "language": "en" } } }\n')
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'app',
        packageManager: 'pnpm@10.16.1',
        devDependencies: { '@lntt/biome-config': '^0.6.0' },
      }),
    )
    writeFileSync(join(root, 'node_modules/@lntt/biome-config/package.json'), JSON.stringify({ version: '0.6.2' }))
    writeFileSync(
      join(root, 'lefthook.yml'),
      'pre-push:\n  commands: {}\ncommit-msg:\n  commands: {}\nskip_output: [meta]\n',
    )
    writeFileSync(
      join(root, '.claude/settings.json'),
      JSON.stringify({
        hooks: { PostToolUse: [], Stop: [] },
        enabledPlugins: { 'lunette@lunette': true, 'x@y': false },
      }),
    )
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test('the sections, read from the project and the environment', () => {
    const dump = collectDump({ root, env: { CLAUDECODE: '1' }, model: 'claude-opus-5-5', version: () => '2.3.4' })
    const get = (title: string) => dump.sections.find((s) => s.title === title)?.lines ?? []
    assert.deepEqual(
      dump.sections.map((s) => s.title),
      ['lntt', 'Runtime', 'Harness', 'Project'],
    )
    assert.match(get('lntt').join('\n'), /version: \d+\.\d+\.\d+/)
    assert.ok(get('Runtime').includes(`Node: ${process.version}`))
    assert.ok(get('Runtime').includes('package manager: pnpm@10.16.1'))
    assert.deepEqual(get('Harness'), ['harness: Claude Code 2.3.4', 'model: claude-opus-5-5'])
    const project = get('Project').join('\n')
    assert.match(project, /skills: \.agents\/skills: review; \.claude\/skills: deploy, review/)
    assert.match(project, /git hooks \(lefthook\): commit-msg, pre-push/)
    assert.match(project, /agent hooks \(\.claude\/settings\.json\): PostToolUse, Stop/)
    assert.match(project, /plugins: lunette@lunette/)
    assert.match(project, /@lntt\/biome-config: \^0\.6\.0, installed 0\.6\.2/)
    assert.match(project, /"language": "en"/)
    assert.equal(dump.harness, 'Claude Code 2.3.4')
    assert.equal(dump.model, 'claude-opus-5-5')
  })

  test('with no harness detected and no model given, each says how to give it', () => {
    const dump = collectDump({ root, env: {}, version: () => null })
    assert.deepEqual(dump.sections.find((s) => s.title === 'Harness')?.lines, [
      'harness: not detected (--harness)',
      'model: not given (--model)',
    ])
  })

  test('the failing command and its output, the tail of a long one', () => {
    const output = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')
    const dump = collectDump({
      root,
      env: {},
      version: () => null,
      command: { argv: ['pnpm', 'test'], status: 1, output },
    })
    const lines = dump.sections.find((s) => s.title === 'Command')?.lines ?? []
    assert.equal(lines[0], 'command: pnpm test')
    assert.equal(lines[1], 'exit: 1')
    assert.match(lines.join('\n'), /100 lines above left out/)
    assert.match(lines.join('\n'), /line 299\n```$/)
  })

  test('a command stopped with no exit code says why', () => {
    const dump = collectDump({
      root,
      env: {},
      version: () => null,
      command: { argv: ['x'], status: null, output: '', stopped: 'stopped after 5 s' },
    })
    assert.ok(dump.sections.find((s) => s.title === 'Command')?.lines.includes('exit: stopped after 5 s'))
  })

  test('an output holding a fence of its own stays inside the block', () => {
    const output = 'before\n```\ninside\n```\nafter'
    const dump = collectDump({ root, env: {}, version: () => null, command: { argv: ['x'], status: 1, output } })
    const text = renderDump(dump)
    assert.match(text, /\n````\nbefore\n```\ninside\n```\nafter\n````\n/)
    assert.equal(fenceFor(['no backticks']), '```')
  })

  test('the package manager from the lockfile when package.json does not name it', () => {
    writeFileSync(join(root, 'package.json'), '{"name":"app"}')
    writeFileSync(join(root, 'pnpm-lock.yaml'), '')
    const runtime = collectDump({ root, env: {}, version: () => null }).sections.find((s) => s.title === 'Runtime')
    assert.ok(runtime?.lines.includes('package manager: pnpm'))
  })

  test('a configuration that does not validate is reported, not thrown', () => {
    writeFileSync(join(root, '.agents/config.jsonc'), '{ "nope": 1 }\n')
    const project = collectDump({ root, env: {}, version: () => null }).sections.find((s) => s.title === 'Project')
    assert.match(project?.lines.join('\n') ?? '', /configuration: .*does not match the schema/)
    assert.match(collectDump({ root, env: {}, version: () => null }).configError ?? '', /does not match the schema/)
  })

  test('rendered as Markdown, one heading per section', () => {
    const text = renderDump(collectDump({ root, env: {}, version: () => null }))
    assert.match(text, /^### lntt\n\n- version: /)
    assert.match(text, /\n### Project\n/)
  })
})

describe('runFailing', () => {
  test('the exit code and the output, stderr merged', () => {
    const run = runFailing(['sh', '-c', 'echo out; echo err >&2; exit 4'], tmpdir())
    assert.equal(run.status, 4)
    assert.equal(run.output, 'out\nerr\n')
  })

  test('a command that hangs is stopped at the timeout, a nested one too, and says so', () => {
    for (const argv of [
      ['sleep', '30'],
      ['sh', '-c', 'sleep 30; true'],
    ]) {
      const started = Date.now()
      const run = runFailing(argv, tmpdir(), 1000)
      assert.ok(Date.now() - started < 10_000, argv.join(' '))
      assert.equal(run.status, null)
      assert.equal(run.stopped, 'stopped after 1 s')
    }
    assert.equal(runFailing(['sleep', '30'], tmpdir(), 300).stopped, 'stopped after 300 ms')
  })

  test('a command killed by a signal says which', () => {
    const run = runFailing(['sh', '-c', 'kill -TERM $$'], tmpdir())
    assert.equal(run.stopped, 'killed by SIGTERM')
  })
})

describe('withAgent', () => {
  test('the harness and the model given replace those of the dump, in its section too', () => {
    const dump = {
      sections: [{ title: 'Harness', lines: ['harness: a', 'model: b'] }],
      harness: 'a',
      model: 'b',
      lntt: '1',
    }
    const next = withAgent(dump, { model: 'm2' })
    assert.equal(next.model, 'm2')
    assert.equal(next.harness, 'a')
    assert.deepEqual(next.sections[0]?.lines, ['harness: a', 'model: m2'])
    const harness = withAgent(dump, { harness: 'h2' })
    assert.deepEqual(harness.sections[0]?.lines, ['harness: h2', 'model: b'])
    assert.equal(withAgent(dump, {}), dump, 'nothing given: the dump as it was read')
  })
})

describe('lntt dump', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-dump-cli-')))
    mkdirSync(join(root, '.agents'))
    writeFileSync(join(root, '.agents/config.jsonc'), '{}\n')
    writeFileSync(join(root, 'package.json'), '{"name":"app"}')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const lntt = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [BIN, 'dump', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: root, ...env },
    })

  test('runs the failing command after --, and redacts the home path and the secrets of the environment', () => {
    const run = lntt(['--model', 'm1', '--', 'sh', '-c', 'echo "in $HOME with $MY_TOKEN"; exit 3'], {
      MY_TOKEN: 'abcdefghijkl',
    })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /- model: m1/)
    assert.match(run.stdout, /- exit: 3/)
    assert.match(run.stdout, /in ~ with <redacted>/)
    assert.ok(!run.stdout.includes(root), 'the home path is gone')
  })

  test('a configuration that does not validate: the whole dump printed, then exit 1', () => {
    writeFileSync(join(root, '.agents/config.jsonc'), '{ "nope": 1 }\n')
    const run = lntt([])
    assert.equal(run.status, 1)
    assert.match(run.stdout, /### Project\n/)
    assert.match(run.stderr, /^lntt dump: .*does not match the schema/)
  })

  test('--json gives the same dump as one object', () => {
    const run = lntt(['--json', '--harness', 'Codex 1.0'])
    assert.equal(run.status, 0, run.stderr)
    const dump = JSON.parse(run.stdout)
    assert.equal(dump.harness, 'Codex 1.0')
    assert.ok(Array.isArray(dump.sections))
  })

  test('a usage error exits 2: an unknown option, an option of lntt issue, a command without --, -- alone', () => {
    for (const args of [
      ['--nope'],
      ['--send'],
      ['--comment', '7'],
      ['--dump', 'x'],
      ['--project', 'p'],
      ['ls'],
      ['--'],
    ]) {
      const run = lntt(args)
      assert.equal(run.status, 2, args.join(' '))
      assert.match(run.stderr, /usage: lntt dump/, args.join(' '))
    }
  })
})
