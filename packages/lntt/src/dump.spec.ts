import { assert, describe, it } from '@effect/vitest'
import {
  type DumpFacts,
  detectHarness,
  dumpOf,
  environmentSecrets,
  fenceFor,
  installKind,
  type ProjectFacts,
  redact,
  remotesIn,
  renderDump,
  stoppedAfter,
  versionIn,
  withAgent,
} from './dump.ts'

describe('redact', () => {
  const context = { home: '/Users/ada', remotes: ['git@github.com:acme/secret-app.git'], secrets: ['s3cr3t-value'] }

  it('the home path becomes ~', () => {
    assert.strictEqual(
      redact('/Users/ada/Developer/app/.agents/config.jsonc', context),
      '~/Developer/app/.agents/config.jsonc',
    )
    assert.strictEqual(redact('/Users/adam/x', context), '/Users/adam/x', 'another user whose name starts the same')
  })

  it("the project's remotes, and any URL carrying credentials", () => {
    assert.strictEqual(redact('origin git@github.com:acme/secret-app.git (fetch)', context), 'origin <remote> (fetch)')
    assert.strictEqual(redact('see https://ada:pw@git.example.com/x.git', context), 'see <url with credentials>')
    assert.strictEqual(redact('git@gitlab.com:acme/other.git', context), '<remote>')
  })

  it('emails', () => {
    assert.strictEqual(redact('author ada.lovelace+x@example.co.uk wrote', context), 'author <email> wrote')
    assert.strictEqual(redact('pnpm@10.16.1 and @lntt/lntt@0.6.2', context), 'pnpm@10.16.1 and @lntt/lntt@0.6.2')
  })

  it('tokens by their shape, and the values of secret-looking keys', () => {
    for (const token of [
      `ghp_${'a'.repeat(36)}`,
      `github_pat_${'B'.repeat(40)}`,
      `sk-ant-api03-${'c'.repeat(40)}`,
      `xoxb-${'1'.repeat(12)}-abc`,
      'AKIAABCDEFGHIJKLMNOP',
      `eyJ${'a'.repeat(10)}.${'b'.repeat(10)}.${'c'.repeat(10)}`,
    ]) {
      assert.strictEqual(redact(`x ${token} y`, context), 'x <token> y', token)
    }
    assert.strictEqual(redact('Authorization: Bearer abc.def', context), 'Authorization: Bearer <token>')
    assert.strictEqual(redact('"apiKey": "abc123"', context), '"apiKey": "<redacted>"')
    assert.strictEqual(redact('DB_PASSWORD=hunter2 next', context), 'DB_PASSWORD=<redacted> next')
    assert.strictEqual(redact('"tokens": 1200', context), '"tokens": 1200', 'a count is no secret')
  })

  it('a secret held in the environment, wherever it appears', () => {
    assert.strictEqual(redact('the value s3cr3t-value leaked', context), 'the value <redacted> leaked')
  })

  it('a short secret of the environment, and a remote with no separator, are left alone', () => {
    assert.deepStrictEqual(
      environmentSecrets({ MY_TOKEN: 'abc', EMPTY_SECRET: '', API_KEY: 'abcdefgh', PATH: 'abcdefghij' }),
      ['abcdefgh'],
    )
    const garbling = { home: '/Users/ada', remotes: ['.', '../x', 'origin'], secrets: [] }
    assert.strictEqual(redact('a ./b and ../x/y', garbling), 'a ./b and ../x/y')
  })
})

describe('detectHarness', () => {
  it('the model of ANTHROPIC_MODEL only under Claude Code', () => {
    const model = (env: Record<string, string>) => dumpOf(facts({ env })).model
    assert.strictEqual(model({ CLAUDECODE: '1', ANTHROPIC_MODEL: 'opus' }), 'opus')
    assert.strictEqual(model({ OPENCODE: '1', ANTHROPIC_MODEL: 'opus' }), 'not given')
  })

  it('Claude Code, Codex and OpenCode by their variables; unknown otherwise', () => {
    assert.strictEqual(detectHarness({ CLAUDECODE: '1' }), 'Claude Code')
    assert.strictEqual(detectHarness({ CODEX_SANDBOX: 'seatbelt' }), 'Codex')
    assert.strictEqual(detectHarness({ OPENCODE: '1' }), 'OpenCode')
    assert.strictEqual(detectHarness({}), null)
  })
})

describe('installKind', () => {
  it('from source, a dependency of the project, or from outside it', () => {
    assert.strictEqual(installKind('/r/packages/lntt', '/r'), 'from source (a workspace package)')
    assert.strictEqual(
      installKind('/r/node_modules/.pnpm/@lntt+lntt@0.6.2/node_modules/@lntt/lntt', '/r'),
      'a dependency of the project',
    )
    assert.strictEqual(installKind('/home/u/.npm/_npx/abc/node_modules/@lntt/lntt', '/r'), 'npx')
    assert.strictEqual(installKind('/opt/homebrew/lib/node_modules/@lntt/lntt', '/r'), 'outside the project (global)')
  })
})

describe('withAgent', () => {
  it('the harness and the model given replace those of the dump, in its section too', () => {
    const dump = {
      sections: [{ title: 'Harness', lines: ['harness: a', 'model: b'] }],
      harness: 'a',
      model: 'b',
      lntt: '1',
    }
    const next = withAgent(dump, { model: 'm2' })
    assert.strictEqual(next.model, 'm2')
    assert.strictEqual(next.harness, 'a')
    assert.deepStrictEqual(next.sections[0]?.lines, ['harness: a', 'model: m2'])
    const harness = withAgent(dump, { harness: 'h2' })
    assert.deepStrictEqual(harness.sections[0]?.lines, ['harness: h2', 'model: b'])
    assert.strictEqual(withAgent(dump, {}), dump, 'nothing given: the dump as it was read')
  })
})

describe('what a dump reads from the tools', () => {
  it('a version from the first line of --version; the remotes of git remote -v, once each', () => {
    assert.strictEqual(versionIn('2.3.4 (Claude Code)\nmore'), '2.3.4')
    assert.strictEqual(versionIn('no digits here\n'), 'no digits here')
    assert.strictEqual(versionIn(''), null)
    assert.deepStrictEqual(
      remotesIn('origin\tgit@github.com:a/b.git (fetch)\norigin\tgit@github.com:a/b.git (push)\nup\t../x (fetch)\n'),
      ['git@github.com:a/b.git', '../x'],
    )
    assert.strictEqual(stoppedAfter(1000), 'stopped after 1 s')
    assert.strictEqual(stoppedAfter(300), 'stopped after 300 ms')
  })
})

const ROOT = '/r'

// A project as src/dump/collect.ts reads it.
const project = (extra: Partial<ProjectFacts> = {}): ProjectFacts => ({
  pkg: { name: 'app', packageManager: 'pnpm@10.16.1', devDependencies: { '@lntt/biome-config': '^0.6.0' } },
  locks: [],
  skills: [
    { dir: '.agents/skills', names: ['review'] },
    { dir: '.claude/skills', names: ['deploy', 'review'] },
  ],
  lefthook: 'pre-push:\n  commands: {}\ncommit-msg:\n  commands: {}\nskip_output: [meta]\n',
  claude: { hooks: { PostToolUse: [], Stop: [] }, enabledPlugins: { 'lunette@lunette': true, 'x@y': false } },
  installed: { '@lntt/biome-config': '0.6.2' },
  config: { path: `${ROOT}/.agents/config.jsonc`, data: { delivery: { commits: { language: 'en' } } } },
  ...extra,
})

const facts = (extra: Partial<DumpFacts> = {}): DumpFacts => ({
  root: ROOT,
  env: {},
  harnessVersion: null,
  lntt: { version: '0.6.5', dir: '/r/node_modules/@lntt/lntt' },
  node: 'v24.1.0',
  os: 'Darwin 27.0.0 arm64',
  home: '/home/u',
  remotes: [],
  project: project(),
  ...extra,
})

describe('the dump of what was gathered', () => {
  it('the sections, read from the project and the environment', () => {
    const dump = dumpOf(facts({ env: { CLAUDECODE: '1' }, model: 'claude-opus-5-5', harnessVersion: '2.3.4' }))
    const get = (title: string) => dump.sections.find((s) => s.title === title)?.lines ?? []
    assert.deepStrictEqual(
      dump.sections.map((s) => s.title),
      ['lntt', 'Runtime', 'Harness', 'Project'],
    )
    assert.deepStrictEqual(get('lntt'), [
      'version: 0.6.5',
      'installed: a dependency of the project',
      'path: /r/node_modules/@lntt/lntt',
    ])
    assert.deepStrictEqual(get('Runtime'), [
      'Node: v24.1.0',
      'package manager: pnpm@10.16.1',
      'OS: Darwin 27.0.0 arm64',
    ])
    assert.deepStrictEqual(get('Harness'), ['harness: Claude Code 2.3.4', 'model: claude-opus-5-5'])
    const lines = get('Project').join('\n')
    assert.match(lines, /skills: \.agents\/skills: review; \.claude\/skills: deploy, review/)
    assert.match(lines, /git hooks \(lefthook\): commit-msg, pre-push/)
    assert.match(lines, /agent hooks \(\.claude\/settings\.json\): PostToolUse, Stop/)
    assert.match(lines, /plugins: lunette@lunette/)
    assert.match(lines, /@lntt\/biome-config: \^0\.6\.0, installed 0\.6\.2/)
    assert.match(lines, /configuration: \.agents\/config\.jsonc\n```json\n[\s\S]*"language": "en"/)
    assert.strictEqual(dump.harness, 'Claude Code 2.3.4')
    assert.strictEqual(dump.model, 'claude-opus-5-5')
  })

  it('with no harness detected and no model given, each says how to give it', () => {
    assert.deepStrictEqual(dumpOf(facts()).sections.find((s) => s.title === 'Harness')?.lines, [
      'harness: not detected (--harness)',
      'model: not given (--model)',
    ])
  })

  it('the failing command and its output, the tail of a long one', () => {
    const output = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')
    const dump = dumpOf(facts({ command: { argv: ['pnpm', 'test'], status: 1, output } }))
    const lines = dump.sections.find((s) => s.title === 'Command')?.lines ?? []
    assert.strictEqual(lines[0], 'command: pnpm test')
    assert.strictEqual(lines[1], 'exit: 1')
    assert.match(lines.join('\n'), /100 lines above left out/)
    assert.match(lines.join('\n'), /line 299\n```$/)
  })

  it('a command stopped with no exit code says why', () => {
    const dump = dumpOf(facts({ command: { argv: ['x'], status: null, output: '', stopped: 'stopped after 5 s' } }))
    assert.include(dump.sections.find((s) => s.title === 'Command')?.lines ?? [], 'exit: stopped after 5 s')
  })

  it('an output holding a fence of its own stays inside the block', () => {
    const output = 'before\n```\ninside\n```\nafter'
    const text = renderDump(dumpOf(facts({ command: { argv: ['x'], status: 1, output } })))
    assert.match(text, /\n````\nbefore\n```\ninside\n```\nafter\n````\n/)
    assert.strictEqual(fenceFor(['no backticks']), '```')
  })

  it('the package manager from the lockfile when package.json does not name it', () => {
    const dump = dumpOf(facts({ project: project({ pkg: { name: 'app' }, locks: ['pnpm-lock.yaml'] }) }))
    assert.include(dump.sections.find((s) => s.title === 'Runtime')?.lines ?? [], 'package manager: pnpm')
  })

  it('a configuration that does not validate is reported and red, its error redacted too', () => {
    const invalid = `/home/u/r/.agents/config.jsonc does not match the schema:\n  / nope`
    const dump = dumpOf(facts({ project: project({ config: { invalid } }) }))
    assert.match(
      dump.sections.find((s) => s.title === 'Project')?.lines.join('\n') ?? '',
      /configuration: .*does not match/,
    )
    assert.strictEqual(dump.configError, '~/r/.agents/config.jsonc does not match the schema:\n  / nope')
  })

  it('no configuration file is the defaults, not an error', () => {
    const dump = dumpOf(
      facts({ project: project({ config: { none: 'no .agents/config.jsonc or .agents/config.yml in /r or above' } }) }),
    )
    assert.strictEqual(dump.configError, undefined)
    assert.match(dump.sections.find((s) => s.title === 'Project')?.lines.join('\n') ?? '', /configuration: no \.agents/)
  })

  it('rendered as Markdown, one heading per section', () => {
    const text = renderDump(dumpOf(facts()))
    assert.match(text, /^### lntt\n\n- version: /)
    assert.match(text, /\n### Project\n/)
  })

  it('the remotes, the home and the secrets of the environment are redacted everywhere', () => {
    const dump = dumpOf(
      facts({
        env: { MY_TOKEN: 'abcdefghijkl' },
        remotes: ['git@github.com:acme/secret.git'],
        command: { argv: ['x'], status: 1, output: 'in /home/u with abcdefghijkl from git@github.com:acme/secret.git' },
      }),
    )
    assert.match(renderDump(dump), /in ~ with <redacted> from <remote>/)
  })
})
