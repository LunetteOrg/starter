import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { BRANCH, cli, type Project, project } from './cli-project.ts'

// --query <jq> beside every --json: the query runs on the document --json prints, with the
// jq of lntt review status --query and its errors.
let p: Project
beforeEach(() => {
  p = project({ rounds: 2 })
})
afterEach(() => p.remove())

const run = (args: string[]) => {
  const r = cli(p, args)
  return { code: r.status, out: r.stdout, err: r.stderr }
}

// Each command that takes --json, a query on a string of its document, and that string.
const COMMANDS: [string, string[], string, string][] = [
  ['check cite', ['check', 'cite', 'long.txt:2'], '.message', 'short "line"'],
  ['check, an area', ['check', 'agents-md'], '.area', 'agents-md'],
  ['browser', ['browser'], '.app', 'web'],
  ['dump', ['dump'], '.sections[0].title', 'lntt'],
  ['review cost', ['review', 'cost'], '.branch', BRANCH],
  ['review status', ['review', 'status'], '.branch', BRANCH],
]

describe('--query on every command that takes --json', () => {
  for (const [name, args, expression, value] of COMMANDS) {
    describe(name, () => {
      test('prints the result: a string raw, JSON with --json', () => {
        const raw = run([...args, `--query=${expression}`])
        assert.equal(raw.out, `${value}\n`, raw.err)
        const json = run([...args, '--query', expression, '--json'])
        assert.equal(json.out, `${JSON.stringify(value)}\n`, json.err)
      })

      test('a compact value per line, nothing at all for no result', () => {
        assert.equal(run([...args, '--query=[1, {"a": 2}], "b"']).out, '[1,{"a":2}]\nb\n')
        assert.equal(run([...args, '--query=empty']).out, '')
      })

      test('a failing expression: exit 2, nothing on stdout, the error of lntt review status', () => {
        const bad = run([...args, '--query=.x |'])
        const reference = run(['review', 'status', '--query=.x |'])
        assert.deepEqual([bad.code, bad.out], [2, ''])
        assert.equal(bad.err, reference.err)
        const failing = run([...args, '--query=1, error("boom")'])
        assert.deepEqual([failing.code, failing.out], [2, ''], 'what came before the failure is not printed')
        assert.match(failing.err, /boom/)
      })

      test('a missing or empty expression is a usage error', () => {
        assert.equal(run([...args, '--query']).code, 2)
        assert.equal(run([...args, '--query=']).code, 2)
      })
    })
  }

  test('lntt check runs the query on each result, and keeps its exit code', () => {
    const r = run(['check', 'cite', 'long.txt:2', 'long.txt:9', '--query=.status'])
    assert.deepEqual([r.code, r.out], [1, 'PASS\nFAIL\n'])
  })

  test('lntt dump on a configuration that does not validate: the result, then the error, exit 1', () => {
    writeFileSync(join(p.root, '.agents/config.jsonc'), '{"bogus": true}\n')
    const r = run(['dump', '--query=.sections[0].title'])
    assert.deepEqual([r.code, r.out], [1, 'lntt\n'])
    assert.match(r.err, /^lntt dump: .*does not match the schema/)
  })

  test('lntt issue, which takes no --json, takes no --query', () => {
    const r = run(['issue', '-', '--query=.'])
    assert.equal(r.code, 2)
    assert.match(r.err, /--query is an option of lntt dump/)
  })
})
