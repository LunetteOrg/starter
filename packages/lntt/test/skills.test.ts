import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  checkSkills,
  guide,
  SKILL_DIRS,
  sharedSkills,
  skillFolder,
  stub,
  stubFolders,
  syncSkills,
} from '../src/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(HERE, '../bin/lntt.ts')
const SKILLS = resolve(HERE, '../skills')

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-skills-')))
  mkdirSync(join(root, '.agents'))
  writeFileSync(join(root, '.agents/config.jsonc'), '{}')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function lntt(args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8' })
}

function off(): string[] {
  return checkSkills(root)
    .filter((s) => s.state !== 'ok')
    .map((s) => `${s.state} ${s.path}`)
}

// A stub as an older lntt sync wrote it, for a skill the package dropped.
function staleStub(dir: string, name: string): void {
  mkdirSync(join(root, dir, name), { recursive: true })
  writeFileSync(join(root, dir, name, 'SKILL.md'), stub('decisions').replaceAll('decisions', name))
}

describe('the shared skills', () => {
  test('are the folders of skills/ holding a SKILL.md, guides included', () => {
    const names = sharedSkills()
    assert.ok(names.includes('commit-message') && names.includes('decisions'), names.join(', '))
    assert.deepEqual(names, readdirSync(SKILLS).sort())
    assert.equal(skillFolder('decisions'), join(SKILLS, 'decisions'))
    assert.equal(skillFolder('nope'), null)
  })

  test('a guide is the SKILL.md of the package, after the folder its links start from', () => {
    const text = guide('decisions') as string
    const source = readFileSync(join(SKILLS, 'decisions/SKILL.md'), 'utf8')
    assert.equal(
      text,
      `<!-- lntt guide decisions: relative links start from ${join(SKILLS, 'decisions')} -->\n\n${source}`,
    )
    assert.ok(existsSync(join(SKILLS, 'decisions/references/recording-rules.md')), 'the folder holds what it links')
    assert.equal(guide('nope'), null)
  })

  test("a stub keeps the skill's frontmatter and only says to load the guide", () => {
    const source = readFileSync(join(SKILLS, 'review/SKILL.md'), 'utf8')
    const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(source)?.[0] as string
    const text = stub('review')
    assert.ok(text.startsWith(frontmatter), text)
    assert.match(text, /installed by lntt sync from @lntt\/lntt/)
    assert.match(text, /\npnpm exec lntt guide review\n/)
    assert.ok(text.length < frontmatter.length + 400, 'a stub, not the guide')
  })

  test('sync writes a stub for every skill in .agents/skills and .claude/skills', () => {
    syncSkills(root)
    assert.deepEqual(SKILL_DIRS, ['.agents/skills', '.claude/skills'])
    for (const dir of SKILL_DIRS) {
      assert.deepEqual(readdirSync(join(root, dir)).sort(), sharedSkills())
      for (const name of sharedSkills()) {
        assert.deepEqual(readdirSync(join(root, dir, name)), ['SKILL.md'])
        assert.equal(readFileSync(join(root, dir, name, 'SKILL.md'), 'utf8'), stub(name))
      }
    }
  })

  test('sync puts back an edited stub, removes the stubs of skills gone, and leaves the project skills alone', () => {
    syncSkills(root)
    writeFileSync(join(root, '.claude/skills/decisions/SKILL.md'), `${stub('decisions')}One more rule.\n`)
    writeFileSync(join(root, '.agents/skills/decisions/extra.md'), 'extra\n')
    writeFileSync(join(root, '.agents/skills/decisions/.DS_Store'), '')
    mkdirSync(join(root, '.claude/skills/review/references/deep'), { recursive: true })
    writeFileSync(join(root, '.claude/skills/review/references/deep/notes.md'), 'nested\n')
    staleStub('.claude/skills', 'gone')
    mkdirSync(join(root, '.claude/skills/issues'))
    writeFileSync(join(root, '.claude/skills/issues/SKILL.md'), 'our own skill\n')
    syncSkills(root)
    assert.equal(readFileSync(join(root, '.claude/skills/decisions/SKILL.md'), 'utf8'), stub('decisions'))
    assert.deepEqual(readdirSync(join(root, '.agents/skills/decisions')), ['SKILL.md'], 'extra and hidden files go')
    assert.deepEqual(readdirSync(join(root, '.claude/skills/review')), ['SKILL.md'], 'nested folders go')
    assert.equal(existsSync(join(root, '.claude/skills/gone')), false)
    assert.equal(readFileSync(join(root, '.claude/skills/issues/SKILL.md'), 'utf8'), 'our own skill\n')
    const tree = () =>
      stubFolders(root).map(
        (f) => `${f}:${readdirSync(join(root, f)).join(',')}:${readFileSync(join(root, f, 'SKILL.md'), 'utf8')}`,
      )
    const once = tree()
    syncSkills(root)
    assert.deepEqual(tree(), once, 'a second sync changes nothing')
  })

  test('check names every stub missing from either directory', () => {
    const expected = SKILL_DIRS.flatMap((dir) => sharedSkills().map((name) => `missing ${dir}/${name}`))
    assert.deepEqual(off(), expected)
  })

  test('check passes after sync, ignoring the project skills beside the stubs', () => {
    syncSkills(root)
    mkdirSync(join(root, '.agents/skills/ours'))
    writeFileSync(join(root, '.agents/skills/ours/SKILL.md'), 'ours\n')
    assert.deepEqual(off(), [])
    assert.equal(checkSkills(root).length, SKILL_DIRS.length * sharedSkills().length)
  })

  test('check names an edited stub, a file added beside one, and a stub of a skill the package does not have', () => {
    syncSkills(root)
    writeFileSync(join(root, '.claude/skills/commit-message/SKILL.md'), `${stub('commit-message')}One more rule.\n`)
    writeFileSync(join(root, '.agents/skills/decisions/notes.md'), 'added\n')
    staleStub('.agents/skills', 'gone')
    assert.deepEqual(off(), [
      'edited .agents/skills/decisions',
      'edited .claude/skills/commit-message',
      'unknown .agents/skills/gone',
    ])
  })

  test('check reads a stub checked out with CRLF line endings, or next to a hidden file, as unedited', () => {
    syncSkills(root)
    const file = join(root, '.claude/skills/review/SKILL.md')
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll('\n', '\r\n'))
    writeFileSync(join(root, '.agents/skills/review/.DS_Store'), '')
    assert.deepEqual(off(), [])
  })

  test('a project skill that quotes the marker below its frontmatter is not a stub: sync and check leave it alone', () => {
    mkdirSync(join(root, '.agents/skills/mine'), { recursive: true })
    const text = `---\nname: mine\ndescription: ours\n---\n# Mine\n\n${stub('review').split('\n')[4]}\n`
    writeFileSync(join(root, '.agents/skills/mine/SKILL.md'), text)
    syncSkills(root)
    assert.deepEqual(off(), [])
    assert.equal(readFileSync(join(root, '.agents/skills/mine/SKILL.md'), 'utf8'), text)
  })

  test('the stub folders on disk are told apart from the project skills beside them', () => {
    syncSkills(root)
    staleStub('.agents/skills', 'gone')
    mkdirSync(join(root, '.claude/skills/issues'))
    writeFileSync(join(root, '.claude/skills/issues/SKILL.md'), 'our own skill\n')
    assert.deepEqual(stubFolders(root), [
      ...[...sharedSkills(), 'gone'].sort().map((n) => `.agents/skills/${n}`),
      ...sharedSkills().map((n) => `.claude/skills/${n}`),
    ])
  })

  test('a project skill with a shared name is a clash: sync writes nothing and check names it', () => {
    mkdirSync(join(root, '.claude/skills/review'), { recursive: true })
    writeFileSync(join(root, '.claude/skills/review/SKILL.md'), 'our own review\n')
    assert.throws(
      () => syncSkills(root),
      /\.claude\/skills\/review: a skill of the project's own with the name of a shared skill/,
    )
    assert.equal(existsSync(join(root, '.agents/skills/review')), false, 'nothing written')
    assert.equal(readFileSync(join(root, '.claude/skills/review/SKILL.md'), 'utf8'), 'our own review\n')
    assert.ok(off().includes('clash .claude/skills/review'), off().join(', '))
    mkdirSync(join(root, '.agents/skills/decisions'), { recursive: true })
    writeFileSync(join(root, '.agents/skills/decisions/notes.md'), 'no SKILL.md, still ours\n')
    assert.ok(off().includes('clash .agents/skills/decisions'), off().join(', '))
    assert.throws(() => syncSkills(root), /\.agents\/skills\/decisions, \.claude\/skills\/review: /)
    assert.equal(readFileSync(join(root, '.agents/skills/decisions/notes.md'), 'utf8'), 'no SKILL.md, still ours\n')
    const r = lntt(['sync'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /^lntt: \.agents\/skills\/decisions, \.claude\/skills\/review: a skill of the project's own/)
    assert.equal(existsSync(join(root, 'AGENTS.md')), false, 'nor the managed block')
  })

  test('lntt sync and lntt check work from a subfolder of the project, on its root', () => {
    mkdirSync(join(root, 'packages/x'), { recursive: true })
    const sub = (args: string[]) =>
      spawnSync(process.execPath, [BIN, ...args], { cwd: join(root, 'packages/x'), encoding: 'utf8' })
    assert.equal(sub(['sync']).status, 0)
    assert.equal(existsSync(join(root, '.agents/skills/decisions/SKILL.md')), true)
    assert.equal(existsSync(join(root, 'packages/x/.agents')), false)
    assert.equal(sub(['check', 'skills']).status, 0)
  })

  test('lntt check skills says what to do for an edited stub, a stub of a skill gone and a clash', () => {
    assert.equal(lntt(['sync']).status, 0)
    writeFileSync(join(root, '.claude/skills/decisions/SKILL.md'), `${stub('decisions')}One more rule.\n`)
    staleStub('.agents/skills', 'gone')
    writeFileSync(join(root, '.agents/skills/review/SKILL.md'), 'our own review\n')
    const out = lntt(['check', 'skills']).stdout
    assert.match(out, /\.claude\/skills\/decisions — differs from the stub lntt sync writes; run lntt sync/)
    assert.match(out, /\.agents\/skills\/gone — a stub of a skill @lntt\/lntt does not have; run lntt sync/)
    assert.match(
      out,
      /\.agents\/skills\/review — a skill of the project's own with the name of a shared skill; rename it/,
    )
  })

  test('lntt sync writes the stubs and lntt check skills fails until it has', () => {
    const before = lntt(['check', 'skills'])
    assert.equal(before.status, 1)
    assert.match(before.stdout, /FAIL {5}skills\/installed {2}\.agents\/skills\/decisions — .*run lntt sync/)
    assert.equal(lntt(['sync']).status, 0)
    assert.ok(existsSync(join(root, 'AGENTS.md')), 'sync still writes the managed block')
    const after = lntt(['check', 'skills'])
    assert.equal(after.status, 0, after.stdout)
    assert.match(after.stdout, /^PASS {5}skills\/installed — /)
  })

  test('lntt guide prints a guide, lists the skills alone, and fails on a skill it does not have', () => {
    const r = lntt(['guide', 'commit-message'])
    assert.equal(r.status, 0)
    assert.equal(r.stdout, guide('commit-message'))
    assert.equal(
      lntt(['guide']).stdout,
      sharedSkills()
        .map((s) => `${s}\n`)
        .join(''),
    )
    const missing = lntt(['guide', 'nope'])
    assert.equal(missing.status, 1)
    assert.equal(missing.stdout, '')
    assert.match(missing.stderr, /^lntt guide: no skill nope; the skills are commit-message, /)
  })
})

// A Markdown link to a file next to the guide, or to a heading of its own.
const RELATIVE_LINK = /\]\(((?:\.\.?\/|#)[^)\s]*)\)/g

// The heading anchors of a Markdown file, as GitHub makes them; a `#` line inside a code
// fence is a comment, not a heading.
function anchors(file: string): string[] {
  const prose = readFileSync(file, 'utf8').replace(/^```[\s\S]*?^```$/gm, '')
  return [...prose.matchAll(/^#+ (.+)$/gm)].map((m) =>
    m[1]
      .toLowerCase()
      .replace(/[^\p{L}\p{N} -]/gu, '')
      .replaceAll(' ', '-'),
  )
}

// Every Markdown file of a skill's folder.
function guideFiles(name: string): string[] {
  const folder = join(SKILLS, name)
  return readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(folder, f))
}

describe('the guides', () => {
  test('every relative link resolves inside the package, to a file and a heading that exist', () => {
    for (const name of sharedSkills()) {
      for (const file of guideFiles(name)) {
        for (const [, target] of readFileSync(file, 'utf8').matchAll(RELATIVE_LINK)) {
          const [path, anchor] = target.split('#')
          const linked = path ? resolve(dirname(file), path) : file
          assert.ok(linked.startsWith(`${SKILLS}/`), `${file}: ${target} leaves the package`)
          assert.ok(existsSync(linked), `${file}: ${target}`)
          if (anchor) assert.ok(anchors(linked).includes(anchor), `${file}: ${target} names no heading`)
        }
      }
    }
  })
})

describe('the board skills', () => {
  const BOARD = ['github-board', 'plan-round', 'roadmap']
  const schema = JSON.parse(readFileSync(resolve(HERE, '../schema/config.schema.json'), 'utf8'))
  const text = (name: string) => guideFiles(name).map((f) => readFileSync(f, 'utf8'))

  // The schema node a dotted key names, following $ref and the open maps; `<key>` is any key.
  function node(key: string): Record<string, unknown> | undefined {
    let at = schema as Record<string, unknown> | undefined
    for (const part of key.split('.')) {
      while (at && typeof at.$ref === 'string') {
        at = (at.$ref as string)
          .slice(2)
          .split('/')
          .reduce((n: Record<string, unknown>, k) => n[k] as Record<string, unknown>, schema)
      }
      const properties = at?.properties as Record<string, Record<string, unknown>> | undefined
      at = part === '<key>' ? (at?.additionalProperties as Record<string, unknown>) : properties?.[part]
    }
    return at
  }

  test('ship in the package beside the other shared skills', () => {
    for (const name of BOARD) assert.ok(sharedSkills().includes(name), name)
  })

  test('read the board section, and stop and propose it when it is missing', () => {
    for (const name of BOARD) {
      const guide = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8')
      assert.match(guide, /lntt get board/, name)
      assert.match(guide, /\*\*No `board`\s+section:\*\* stop/, name)
    }
  })

  test('stop and propose the horizon when the board has none: it is the base they plan on', () => {
    for (const name of BOARD) {
      const guide = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8')
      assert.match(guide, /\*\*No `board\.fields\.horizon`:\*\* stop/, name)
    }
  })

  // The layers: the base (horizon, status, priority, issue type), then milestones and
  // iterations as add-ons, each switched on by its key.
  test('github-board describes the base and the two add-ons, and the incoherences between them', () => {
    const guide = readFileSync(join(SKILLS, 'github-board', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ')
    assert.match(guide, /\*\*The base\*\*/)
    assert.match(guide, /only parents carry it; a child takes its parent's/)
    assert.match(
      guide,
      /children at `board\.fields\.status\.ready` of the parents in\s+the nearest horizon, by priority/,
    )
    assert.match(guide, /\*\*Milestones\*\* \(`board\.milestones`\)[^-]*never replaces the horizon/)
    assert.match(
      guide,
      /\*\*Iterations\*\* \(`board\.fields\.iteration`\)[^-]*only the children of\s+parents in the nearest horizon/,
    )
    // the three incoherences
    assert.match(guide, /a child in an open milestone whose parent is past the next horizon/)
    assert.match(guide, /a parent in the nearest horizon with no child in an open milestone/)
    assert.match(guide, /a child in the current iteration whose parent is not in the nearest horizon/)
  })

  test('plan-round produces the base, and with each add-on what enters the next release or iteration', () => {
    const guide = readFileSync(join(SKILLS, 'plan-round', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ')
    assert.match(
      guide,
      /\*\*The base:\*\* the parents to bring to the nearest horizon, and their children to make\s+ready/,
    )
    assert.match(guide, /\*\*With milestones:\*\* also what enters the next release/)
    assert.match(guide, /\*\*With iterations:\*\* also what enters the next iteration/)
  })

  test('roadmap shows the parents by horizon, and with each add-on the release or the iteration', () => {
    const guide = readFileSync(join(SKILLS, 'roadmap', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ')
    assert.match(guide, /\*\*The base:\*\* the parents by horizon/)
    assert.match(guide, /\*\*With milestones:\*\* how each open release is advancing/)
    assert.match(guide, /\*\*With iterations:\*\* the current iteration/)
  })

  test('plan-round and roadmap hand the board to the adapter board.provider names, and stop when it has none', () => {
    for (const name of ['plan-round', 'roadmap']) {
      const guide = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8')
      assert.match(guide, /`board\.provider`/, name)
      assert.match(guide, /\*\*No adapter for the\s+provider:\*\* stop/, name)
      assert.match(guide, /`github-board`[^.]*`github`[^.]*default|`github` \(the default\): `github-board`/, name)
    }
  })

  test('every configuration key they cite is a key of the schema', () => {
    for (const name of BOARD) {
      for (const content of text(name)) {
        for (const [key] of content.matchAll(
          /(?<![\w/])(?:board|cycle|team|delivery|recording)(?:\.(?:[a-zA-Z]+|<key>))+/g,
        )) {
          assert.ok(node(key), `${name}: ${key} is not in the schema`)
        }
      }
    }
  })

  test('an issue that stands alone takes the type docs/process/board.md says, a child type when it says nothing', () => {
    const guide = readFileSync(resolve(HERE, '../skills/github-board/SKILL.md'), 'utf8')
    assert.match(guide, /stands alone[^.]*`docs\/process\/board\.md`[^.]*child type when it says nothing/)
  })

  test('github-board adds what the configuration declares with lntt board sync: a dry run, --apply on the go', () => {
    const guide = readFileSync(join(SKILLS, 'github-board', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ')
    assert.match(
      guide,
      /`lntt board sync` shows what it would add \(a dry run\), and `lntt board sync --apply` adds it, with the person's go/,
    )
    const reference = readFileSync(resolve(HERE, '../skills/github-board/references/github-project.md'), 'utf8')
    assert.match(reference, /An option passed with its `id`\s+keeps it, and every item keeps its value/)
  })

  test('views are created through the API, and grouped by hand', () => {
    const reference = readFileSync(resolve(HERE, '../skills/github-board/references/github-project.md'), 'utf8')
    assert.doesNotMatch(reference, /no API to create or edit a saved view/)
    assert.match(reference, /createProjectV2View/)
    assert.match(reference, /updateProjectV2View\(input:\{viewId:\$v, filter:\$f\}\)/)
    assert.match(
      reference,
      /the grouping, the\s+sort and \*Show hierarchy\* have no input and are set by a person in the UI/,
    )
    assert.match(reference, /A new view\s+is a change to the Project: only with the person's go/)
  })

  // A guard against values carried over from wai and pelion, not a proof that a guide is
  // generic: a value of another project is not in the list.
  test('carry over none of the issue types, fields or options of wai and pelion', () => {
    const values = [
      /\bFeature\b/,
      /\bTask\b/,
      /\bP[0-3]\b/,
      /\bNot now\b/,
      /\bScope\b/,
      /\bClasse\b|\bDebito\b/,
      /\bwai\b|discent|\bpelion\b/i,
      /\bIn review\b|\bBacklog\b/,
    ]
    for (const name of BOARD) {
      for (const content of text(name)) {
        for (const value of values) assert.ok(!value.test(content), `${name}: ${value}`)
      }
    }
  })
})

describe('the mutation-check skill', () => {
  const guide = () => readFileSync(join(SKILLS, 'mutation-check', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ')
  // The kinds of mutation the tests lens proposes: the author and the reviewer try the same ones.
  const KINDS = [
    'a polarity flipped',
    'an argument dropped',
    'a guard or early return removed',
    'the optimistic constant returned',
    'the call removed',
  ]

  test('ships in the package beside the other shared skills', () => {
    assert.ok(sharedSkills().includes('mutation-check'))
  })

  test('runs each mutation with lntt check tests mutate, and stops and proposes the levels when they are missing', () => {
    assert.match(guide(), /lntt check tests mutate/)
    assert.match(guide(), /\*\*No `tests\.levels`:\*\* stop/)
  })

  test('proposes the kinds of mutation the tests lens proposes', () => {
    const brief = readFileSync(resolve(HERE, '../agents/review/tests.md'), 'utf8').replace(/\s+/g, ' ')
    for (const kind of KINDS) {
      assert.ok(brief.includes(kind), `the tests lens: ${kind}`)
      assert.ok(guide().includes(kind), `mutation-check: ${kind}`)
    }
  })

  test('cites the rule from its record instead of restating it, and reports to the pull request body', () => {
    assert.ok(guide().includes('https://github.com/LunetteOrg/starter/blob/main/docs/adr/test-checks.md'))
    assert.match(guide(), /pull request body/)
  })
})
