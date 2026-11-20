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

// The shared skills as the package ships them: the folders of skills/ holding a SKILL.md.
function sharedSkills(): string[] {
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(SKILLS, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort()
}

// The main paths of the shared skills through the CLI, from the package's own skills/; what sync
// writes and the check reads: src/skills.spec.ts, src/sync/project.spec.ts, src/sync/command.spec.ts.
describe('the shared skills', () => {
  test('are the folders of skills/ holding a SKILL.md, every one of them', () => {
    assert.ok(sharedSkills().includes('commit-message') && sharedSkills().includes('decisions'))
    assert.deepEqual(sharedSkills(), readdirSync(SKILLS).sort())
  })

  test('lntt sync writes the stubs and lntt check skills fails until it has', () => {
    const before = lntt(['check', 'skills'])
    assert.equal(before.status, 1)
    assert.match(before.stdout, /FAIL {5}skills\/installed {2}\.agents\/skills\/decisions — .*run pnpm exec lntt sync/)
    assert.equal(lntt(['sync']).status, 0)
    assert.ok(existsSync(join(root, 'AGENTS.md')), 'sync still writes the managed block')
    const after = lntt(['check', 'skills'])
    assert.equal(after.status, 0, after.stdout)
    assert.match(after.stdout, /^PASS {5}skills\/installed — /)
  })

  test('lntt guide prints a guide, lists the skills alone, and fails on a skill it does not have', () => {
    const r = lntt(['guide', 'commit-message'])
    assert.equal(r.status, 0)
    assert.equal(
      r.stdout,
      `<!-- lntt guide commit-message: relative links start from ${join(SKILLS, 'commit-message')} -->\n\n${readFileSync(join(SKILLS, 'commit-message/SKILL.md'), 'utf8')}`,
    )
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
      /`pnpm exec lntt board sync` shows what it would add \(a dry run\), and `pnpm exec lntt board sync --apply` adds it, with the person's go/,
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
      /the grouping, the\s+sort and [*_]Show hierarchy[*_] have no input and are set by a person in the UI/,
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
  // The body after the frontmatter, so the description cannot satisfy what a section must say.
  const body = () =>
    readFileSync(join(SKILLS, 'mutation-check', 'SKILL.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
  const guide = () => body().replace(/\s+/g, ' ')
  const section = (n: number) =>
    (
      body()
        .split(/^## /m)
        .find((s) => s.startsWith(`${n}. `)) ?? ''
    ).replace(/\s+/g, ' ')
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
    assert.match(section(3), /lntt check tests mutate <path:line> --text='[^']+' --to='[^']+'/)
    assert.match(section(1), /\*\*No `tests\.levels`:\*\* stop/)
    assert.match(section(3), /`--to=''` to delete/)
    assert.match(section(3), /single quote goes between double quotes/)
    assert.match(section(3), /Write `--text=\.\.\.` with the `=` when the text starts with `-`/)
  })

  test('is a tool run by hand, when a test is in doubt or a review note proposes a mutation, never required', () => {
    assert.match(guide(), /a tool the author runs by hand, never required/)
    assert.match(guide(), /a test the author doubts/)
    assert.match(guide(), /a note of the `tests` lens/)
    assert.doesNotMatch(guide(), /before the first review round/)
    assert.match(section(2), /For each test in doubt/)
  })

  test('proposes the kinds of mutation the tests lens proposes', () => {
    const brief = readFileSync(resolve(HERE, '../agents/review/tests.md'), 'utf8').replace(/\s+/g, ' ')
    for (const kind of KINDS) {
      assert.ok(brief.includes(kind), `the tests lens: ${kind}`)
      assert.ok(guide().includes(kind), `mutation-check: ${kind}`)
    }
  })

  test('states the rule, and asks for no mutation in the pull request body', () => {
    assert.ok(guide().includes('A test fails for the right reason, not only passes'))
    assert.match(section(5), /^5\. Report /)
    assert.match(section(5), /Nothing in the process or in `lntt check body` asks for one/)
    assert.doesNotMatch(section(5), /one line per test that guards a line/)
  })
})

describe('the open decisions of a child', () => {
  const text = (name: string) => readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ')

  test('the coordinate skill collects them in one batch before the children code', () => {
    assert.match(
      text('coordinate'),
      /A child's open decisions come first\.\*\* Before its first commit each child asks/,
    )
    assert.match(text('coordinate'), /to the orchestrator in one batch before the children code/)
    assert.match(
      text('coordinate'),
      /needs the person's go for the new rounds \(past `delivery\.review\.maxRounds`, `lntt review allow`\)/,
    )
    assert.match(text('coordinate'), /settle what the issues, the records and the code settle, and send the rest/)
  })

  test('the review skill restarts a converged loop only on the person’s go', () => {
    assert.match(text('review'), /After the loop converged, a new decision that changes the change does not restart it/)
    assert.match(
      text('review'),
      /ask whether it is applied in this pull request or in a follow-up, and new rounds start only on the person's go/,
    )
    assert.match(text('review'), /past `delivery\.review\.maxRounds` is `lntt review allow <rounds>`/)
  })
})

// The review state is read through lntt review status, never from the files in a git
// directory: each worktree keeps its own (#225).
describe('the review state, read with lntt review status', () => {
  const text = (name: string) => readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ')

  test('the review skill names the verdict, the command, its exit codes and --clear', () => {
    const review = text('review')
    assert.match(
      review,
      /`\.state\.findings`, one list, each with a `verdict` \(`confirmed`, `undecided`, `unverified`; `withdrawn` after a reply/,
    )
    assert.match(review, /The state between rounds is read only with `lntt review status`, never by opening its files/)
    assert.match(
      review,
      /Exit 0: this branch's last round is clean\. 1: something to act on\. 3: at the limit\. 4: no round on this branch\./,
    )
    assert.match(review, /`pnpm exec lntt review status --clear` removes the current branch's state once it is merged/)
    assert.match(review, /`pnpm exec lntt review status\s+--prune` removes those of branches that are gone/)
    assert.match(review, /stdout is a summary/)
    assert.match(review, /`\.state\.refuted`/)
    assert.match(review, /`\.state\.repeated`/)
    assert.match(review, /`closedWhat`, entry `closedBy`/)
  })

  test("the coordinate skill reads a child's state in its worktree", () => {
    assert.match(
      text('coordinate'),
      /A child's review state is read in its worktree\*\* with `pnpm exec lntt review status` \(or asked of the child\), never from its files/,
    )
  })
})

describe('the retrospective skill, harvest', () => {
  const skill = () => readFileSync(join(SKILLS, 'retrospective', 'SKILL.md'), 'utf8')
  const section4 = () =>
    skill()
      .split(/^## /m)
      .find((s) => s.startsWith('4. ')) ?? ''
  // The harvest steps (numbered list items), whitespace folded; the paragraphs after the last step apart.
  const steps = () => section4().split(/\n\n(?=[A-Z])/)[0] ?? ''
  const step = (n: number) =>
    steps()
      .replace(/\s+/g, ' ')
      .match(new RegExp(`(?:^| )${n}\\. \\*\\*(.*?)(?= \\d+\\. \\*\\*|$)`))?.[1] ?? ''
  const after = () => section4().replace(/\s+/g, ' ')
  const guardrails = () =>
    skill()
      .split(/^## Guardrails/m)[1]
      ?.replace(/\s+/g, ' ') ?? ''

  test('publishing opens no issue: the proposals are numbered and discussed first, one at a time', () => {
    assert.match(step(9), /Publish\*\* at/)
    assert.match(step(9), /numbered in order in the published body/)
    assert.match(step(9), /Publishing opens no issue for any proposal/)
    assert.match(step(10), /^Discuss the proposals with the person,\*\* after publishing, one proposal at a time/)
    assert.match(step(10), /the proposals still marked `later` in the previous Discussion included/)
  })

  test('each proposal ends adopted, dropped with its reason, or later', () => {
    assert.match(step(10), /\*\*adopted:\*\*/)
    assert.match(step(10), /\*\*dropped:\*\* it will not, and the reason is said/)
    assert.match(step(10), /\*\*later:\*\*/)
  })

  test('the outcome of each proposal is written in the Discussion, in a line the next harvest reads', () => {
    assert.match(step(11), /as a comment per proposal \(or an edit of the body\)/)
    assert.ok(step(11).includes('`Proposal <n>: adopted #<issue>`'))
    assert.ok(step(11).includes('`Proposal <n>: dropped, <reason>`'))
    assert.ok(step(11).includes('`Proposal <n>: later`'))
    assert.match(step(11), /`<n>` is the number the proposal has in the published body/)
    assert.match(step(11), /a proposal carried over as `later` takes a new number and cites the one it had/)
    assert.match(step(11), /Where `adopted` has no issue number yet, step 12 comes first/)
  })

  test('only an adopted proposal becomes an issue, citing the Discussion and its cluster', () => {
    assert.match(step(12), /^Open an issue only for an adopted proposal\*\* \(the `github-board` skill\)/)
    assert.match(step(12), /citing the Discussion and the proposal's cluster/)
    assert.match(step(12), /Nothing is opened before the discussion/)
    assert.match(step(12), /a proposal that is dropped or later gets no issue/)
  })

  test('a proposal with no outcome is never built and is asked again; the guardrail says the same', () => {
    assert.match(
      after(),
      /without an outcome written in its Discussion, is never built and is asked again at the next harvest/,
    )
    assert.match(guardrails(), /An issue exists only for a proposal the person adopted in the discussion/)
  })

  test('the next harvest reads the outcomes for its previous proposals, and asks a later one again', () => {
    assert.match(step(5), /starts from the outcome written in the previous retrospective's Discussion/)
    assert.match(step(5), /`dropped` keeps its reason and is not proposed again unless new signals say otherwise/)
    assert.match(step(5), /a cluster that recurs after a drop is such a signal/)
    assert.match(step(5), /a proposal still marked `later` is asked again/)
    assert.match(step(5), /A proposal with no outcome was never discussed: say so, and put it in the discussion too/)
  })

  test('the steps cited in the text are the steps that carry those titles', () => {
    assert.match(step(5), /\(step 11\)/)
    assert.match(step(5), /\(step 10\)/)
    assert.match(step(12), /\(step 11\)/)
    assert.match(step(11), /\(step 9 numbers them in order\)/)
    assert.match(step(9), /^Publish\*\*/)
    assert.match(guardrails(), /steps 10–12/)
    assert.match(step(11), /^Write each outcome in the Discussion/)
    assert.match(step(10), /^Discuss the proposals/)
    assert.match(step(12), /^Open an issue only/)
  })
})
