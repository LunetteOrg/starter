import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import jsonc from 'jsonc-parser'
import { ConfigError, loadConfig } from '../src/index.ts'

// One configuration per released version of @lntt/lntt, written with every field that
// version knew. The schema only grows (the compatibility rule in docs/adr/lntt-command.md):
// a newer lntt must read each of them. A release adds its fixture (docs/process/delivery.md).
const HERE = dirname(fileURLToPath(import.meta.url))
const RELEASED = resolve(HERE, 'fixtures/released')
const SCHEMA = 'packages/lntt/schema/config.schema.json'

// The release a version belongs to: a dry run (X.Y.Z-rc.N) and a build (X.Y.Z+sha) carry
// the fixture of X.Y.Z.
function releaseOf(version: string): string {
  return version.split(/[-+]/)[0] as string
}

const current = releaseOf(
  (JSON.parse(readFileSync(resolve(HERE, '../package.json'), 'utf8')) as { version: string }).version,
)

const versions = readdirSync(RELEASED)
  .filter((file) => file.endsWith('.jsonc'))
  .map((file) => file.slice(0, -'.jsonc'.length))

type Node = Record<string, unknown>

// The schema's fields that `value` does not set. Free-form maps (`additionalProperties`
// as a schema) are covered by any one entry; of a `oneOf`, by the closest branch.
function missing(schema: Node, root: Node, value: unknown, at = ''): string[] {
  const s = schema.$ref
    ? ((root.definitions as Record<string, Node>)[String(schema.$ref).split('/').pop() as string] as Node)
    : schema
  if (Array.isArray(s.oneOf)) {
    return (s.oneOf as Node[])
      .map((branch) => missing(branch, root, value, at))
      .sort((a, b) => a.length - b.length)[0] as string[]
  }
  if (s.type === 'array') {
    return Array.isArray(value) && value.length > 0 && s.items
      ? missing(s.items as Node, root, value[0], `${at}[]`)
      : Array.isArray(value)
        ? []
        : [at]
  }
  if (s.type !== 'object') return value === undefined ? [at] : []
  const object = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Node) : undefined
  if (!object) return [at]
  const props = (s.properties ?? {}) as Record<string, Node>
  const own = Object.entries(props).flatMap(([key, child]) =>
    key in object ? missing(child, root, object[key], `${at}.${key}`) : [`${at}.${key}`],
  )
  const entries = Object.values(object)
  if (s.additionalProperties && typeof s.additionalProperties === 'object' && !Object.keys(props).length) {
    return entries.length ? missing(s.additionalProperties as Node, root, entries[0], `${at}.*`) : [`${at}.*`]
  }
  return own
}

function inTree(root: string, content: string): string {
  mkdirSync(join(root, '.agents'), { recursive: true })
  writeFileSync(join(root, '.agents/config.jsonc'), content)
  return root
}

describe('the configuration of each released version', () => {
  let root: string
  const read = (version: string) => readFileSync(join(RELEASED, `${version}.jsonc`), 'utf8')
  const setup = () => {
    root = mkdtempSync(join(tmpdir(), 'lntt-released-'))
  }
  const teardown = () => rmSync(root, { recursive: true, force: true })

  test('the version in package.json has its fixture', () => {
    assert.ok(versions.includes(current), `add packages/lntt/test/fixtures/released/${current}.jsonc`)
  })

  test('releaseOf drops a pre-release and build metadata', () => {
    assert.equal(releaseOf('1.2.3'), '1.2.3')
    assert.equal(releaseOf('1.2.3-rc.1'), '1.2.3')
    assert.equal(releaseOf('1.2.3+sha.5114f85'), '1.2.3')
    assert.equal(releaseOf('1.2.3-rc.1+sha.5114f85'), '1.2.3')
  })

  for (const version of versions) {
    test(`${version} validates against the current schema`, () => {
      setup()
      try {
        const { data } = loadConfig(inTree(root, read(version)))
        assert.equal((data.lunette as { version: string }).version, version)
      } finally {
        teardown()
      }
    })

    // The schema of the tag is the only record of what the version knew. It is in the
    // history of a full clone, and of the checkout of a release; a clone without the tag
    // cannot check completeness.
    let tagged: string | undefined
    try {
      tagged = execFileSync('git', ['show', `v${version}:${SCHEMA}`], {
        cwd: HERE,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      tagged = undefined
    }
    test(`${version} sets every field its tag's schema knew`, {
      skip: tagged === undefined && `tag v${version} is not in this clone`,
    }, () => {
      const schema = JSON.parse(tagged as string) as Node
      assert.deepEqual(missing(schema, schema, jsonc.parse(read(version))), [])
    })
  }

  test('a fixture cut down to its version is reported incomplete', () => {
    const schema = JSON.parse(readFileSync(resolve(HERE, '../schema/config.schema.json'), 'utf8')) as Node
    const cut = { lunette: { template: 'react-router', version: '0.6.2' } }
    const absent = missing(schema, schema, cut)
    assert.ok(absent.includes('.delivery'))
    assert.ok(absent.includes('.ci'))
    assert.deepEqual(
      missing(schema, schema, cut).filter((path) => path.startsWith('.lunette')),
      [],
    )
  })

  test('a fixture with an unknown field or an invalid value is rejected', () => {
    setup()
    try {
      const fixture = read(current)
      const unknown = fixture.replace('"lunette": {', '"lunette": {\n    "renamed": "x",')
      assert.notEqual(unknown, fixture)
      assert.throws(() => loadConfig(inTree(root, unknown)), ConfigError)
      const invalid = fixture.replace(/"maxRounds": \d+/, '"maxRounds": 0')
      assert.notEqual(invalid, fixture)
      assert.throws(() => loadConfig(inTree(root, invalid)), ConfigError)
    } finally {
      teardown()
    }
  })
})
