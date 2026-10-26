import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import jsonc from 'jsonc-parser'
import { loadConfig } from '../src/index.ts'

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

// The schema's fields that `value` does not set. An array or a free-form map
// (`additionalProperties` as a schema) is covered by what any of its items sets; of a
// `oneOf`, by the closest branch.
function missing(schema: Node, root: Node, value: unknown, at = ''): string[] {
  const s = schema.$ref
    ? (root.definitions as Record<string, Node>)[String(schema.$ref).split('/').pop() as string]
    : schema
  if (Array.isArray(s.oneOf)) {
    return (s.oneOf as Node[])
      .map((branch) => missing(branch, root, value, at))
      .sort((a, b) => a.length - b.length)[0] as string[]
  }
  if (s.type === 'array') {
    if (!Array.isArray(value) || value.length === 0) return [`${at}[]`]
    return s.items ? absentFromAll(value.map((item) => missing(s.items as Node, root, item, `${at}[]`))) : []
  }
  if (s.type !== 'object') return value === undefined ? [at] : []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [at]
  const object = value as Node
  const props = (s.properties ?? {}) as Record<string, Node>
  if (s.additionalProperties && typeof s.additionalProperties === 'object' && !Object.keys(props).length) {
    const entries = Object.values(object)
    if (entries.length === 0) return [`${at}.*`]
    return absentFromAll(entries.map((entry) => missing(s.additionalProperties as Node, root, entry, `${at}.*`)))
  }
  return Object.entries(props).flatMap(([key, child]) =>
    key in object ? missing(child, root, object[key], `${at}.${key}`) : [`${at}.${key}`],
  )
}

// What every item lacks: a field set by any one of them is set.
function absentFromAll(lists: string[][]): string[] {
  return (lists[0] as string[]).filter((path) => lists.every((list) => list.includes(path)))
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

  test('missing reports what a value leaves unset', () => {
    const schema: Node = {
      type: 'object',
      definitions: { leaf: { type: 'object', properties: { value: { type: 'string' } } } },
      properties: {
        ref: { $ref: '#/definitions/leaf' },
        shaped: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'string' } },
        name: { type: 'string' },
        list: {
          type: 'array',
          items: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } },
        },
        map: { type: 'object', additionalProperties: { type: 'object', properties: { x: { type: 'string' } } } },
        nested: { type: 'object', properties: { deep: { type: 'object', properties: { leaf: { type: 'string' } } } } },
        either: { oneOf: [{ const: false }, { type: 'object', properties: { with: { type: 'string' } } }] },
      },
    }
    const full = {
      ref: { value: 'v' },
      shaped: { a: '1' },
      name: 'n',
      list: [{ a: '1' }, { b: '2' }],
      map: { k: { x: '1' } },
      nested: { deep: { leaf: 'l' } },
      either: false,
    }
    assert.deepEqual(missing(schema, schema, full), [])
    assert.deepEqual(missing(schema, schema, {}), ['.ref', '.shaped', '.name', '.list', '.map', '.nested', '.either'])
    assert.deepEqual(missing(schema, schema, { ...full, ref: {} }), ['.ref.value'])
    assert.deepEqual(missing(schema, schema, { ...full, shaped: {} }), ['.shaped.a'])
    assert.deepEqual(missing(schema, schema, { ...full, nested: [] }), ['.nested'])
    assert.deepEqual(missing(schema, schema, { ...full, list: [{ a: '1' }] }), ['.list[].b'])
    assert.deepEqual(missing(schema, schema, { ...full, list: [] }), ['.list[]'])
    assert.deepEqual(missing(schema, schema, { ...full, map: {} }), ['.map.*'])
    assert.deepEqual(missing(schema, schema, { ...full, map: { k: {} } }), ['.map.*.x'])
    assert.deepEqual(missing(schema, schema, { ...full, nested: { deep: {} } }), ['.nested.deep.leaf'])
    assert.deepEqual(missing(schema, schema, { ...full, either: { with: 'w' } }), [])
  })

  test('a fixture cut down to its version is incomplete against the current schema', () => {
    const schema = JSON.parse(readFileSync(resolve(HERE, '../schema/config.schema.json'), 'utf8')) as Node
    const absent = missing(schema, schema, { lunette: { template: 'react-router', version: '0.6.2' } })
    assert.ok(absent.includes('.delivery'))
    assert.ok(absent.includes('.ci'))
    assert.ok(!absent.some((path) => path.startsWith('.lunette')))
  })

  test('a fixture with an unknown field or an invalid value is rejected', () => {
    setup()
    try {
      const fixture = read('0.6.2')
      const unknown = fixture.replace('"lunette": {', '"lunette": {\n    "renamed": "x",')
      assert.match(unknown, /"renamed"/)
      assert.throws(() => loadConfig(inTree(root, unknown)), /renamed/)
      const invalid = fixture.replace(/"maxRounds": \d+/, '"maxRounds": 0')
      assert.match(invalid, /"maxRounds": 0/)
      assert.throws(() => loadConfig(inTree(root, invalid)), /maxRounds/)
    } finally {
      teardown()
    }
  })
})
