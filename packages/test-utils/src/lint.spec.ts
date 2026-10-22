import { describe, expect, it } from 'vitest'
import { assertBiomeDomainsDeclared, assertLintFailsOnWarnings, enabledBiomeDomains, parseJsonc } from './lint.ts'
import { probeProject } from './probe-kit.ts'

const manifest = (fields: object) => JSON.stringify({ name: 'x', ...fields })

describe('parseJsonc', () => {
  it('reads comments and trailing commas, and leaves them alone inside strings', () => {
    expect(parseJsonc('{\n  // a comment\n  "a": "http://x/*y*/", /* block */\n  "b": [1, 2,],\n}\n')).toEqual({
      a: 'http://x/*y*/',
      b: [1, 2],
    })
  })

  it.each([
    ['{ "a": [1, 2, // last\n], }', { a: [1, 2] }],
    ['{ "a": 1, /* x */ }', { a: 1 }],
    ['{ "a": "x,]", }', { a: 'x,]' }],
  ])('drops a trailing comma with a comment between it and the bracket: %s', (text, parsed) => {
    expect(parseJsonc(text)).toEqual(parsed)
  })
})

describe('enabledBiomeDomains', () => {
  it('reads linter.domains and the overrides, through relative and package extends, and skips "none"', () => {
    const root = probeProject({
      'biome.jsonc': '// the root\n{ "extends": ["./packages/biome-config/biome.json", "@acme/biome/biome"] }\n',
      'packages/biome-config/biome.json':
        '{ "linter": { "domains": { "react": "recommended", "vue": "none" } }, "overrides": [{ "linter": { "domains": { "test": "all" } } }] }',
      'node_modules/@acme/biome/package.json': '{ "name": "@acme/biome", "exports": { "./biome": "./biome.json" } }',
      'node_modules/@acme/biome/biome.json': '{ "linter": { "domains": { "drizzle": "recommended" } } }',
    })
    expect([...enabledBiomeDomains(root)].sort()).toEqual(['drizzle', 'react', 'test'])
  })

  it('fails naming an extends it cannot resolve', () => {
    const root = probeProject({ 'biome.json': '{ "extends": ["@missing/biome"] }' })
    expect(() => enabledBiomeDomains(root)).toThrow(/@missing\/biome/)
  })
})

describe('assertBiomeDomainsDeclared', () => {
  it('fails naming each dependency whose domain is not switched on', () => {
    const root = probeProject({
      'package.json': manifest({ devDependencies: { vitest: 'catalog:' } }),
      'biome.json': '{ "linter": { "domains": { "test": "recommended", "react": "none" } } }',
      'apps/web/package.json': manifest({ dependencies: { react: 'catalog:', 'drizzle-orm': '^1.0.0' } }),
    })
    expect(() => assertBiomeDomainsDeclared(root)).toThrow(
      /apps\/web\/package\.json: drizzle-orm → drizzle[\s\S]*apps\/web\/package\.json: react → react[\s\S]*test-guards\.md/,
    )
    expect(() => assertBiomeDomainsDeclared(root)).not.toThrow(/vitest/)
  })

  it('takes the dependency table and the config as options', () => {
    const root = probeProject({
      'package.json': manifest({ dependencies: { mylib: '1.0.0' } }),
      'config/biome.json': '{ "linter": { "domains": { "next": "all" } } }',
    })
    expect(() =>
      assertBiomeDomainsDeclared(root, { config: 'config/biome.json', domains: { mylib: 'next' } }),
    ).not.toThrow()
    expect(() =>
      assertBiomeDomainsDeclared(root, { config: 'config/biome.json', domains: { mylib: 'solid' } }),
    ).toThrow(/mylib → solid/)
  })

  it('fails when no dependency has a domain, rather than pass on nothing', () => {
    const root = probeProject({ 'package.json': manifest({}), 'biome.json': '{}' })
    expect(() => assertBiomeDomainsDeclared(root)).toThrow(/no dependency/)
  })
})

describe('assertLintFailsOnWarnings', () => {
  it('fails naming each lint script whose biome or stylelint lets a warning through', () => {
    const root = probeProject({
      'package.json': manifest({ scripts: { lint: 'turbo run lint', 'lint:fix': 'biome check --write' } }),
      'packages/ui/package.json': manifest({
        scripts: { lint: 'biome check . --error-on-warnings && stylelint "**/*.css"', test: 'biome check .' },
      }),
      'apps/web/package.json': manifest({
        scripts: { lint: 'biome check --error-on-warnings . && biome lint src' },
      }),
    })
    let message = ''
    try {
      assertLintFailsOnWarnings(root)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message.match(/^ {2}- .*$/gm)).toEqual([
      '  - package.json → lint:fix: `biome check --write` needs --error-on-warnings',
      '  - apps/web/package.json → lint: `biome lint src` needs --error-on-warnings',
      '  - packages/ui/package.json → lint: `stylelint "**/*.css"` needs --max-warnings 0',
    ])
    expect(message).toMatch(/test-guards\.md/)
  })

  it.each([
    ['&&', 'biome check --error-on-warnings && biome lint src'],
    ['||', 'biome check --error-on-warnings || biome lint src'],
    [';', 'biome check --error-on-warnings; biome lint src'],
    ['|', 'biome check --error-on-warnings | biome lint src'],
  ])('reads each step of a script chained with %s', (_, lint) => {
    const root = probeProject({ 'package.json': manifest({ scripts: { lint } }) })
    expect(() => assertLintFailsOnWarnings(root)).toThrow(/`biome lint src` needs --error-on-warnings/)
  })

  it('fails naming a manifest that does not parse', () => {
    const root = probeProject({
      'package.json': manifest({ scripts: { lint: 'biome check --error-on-warnings' } }),
      'packages/ui/package.json': '{ "name": "ui", }}',
    })
    expect(() => assertLintFailsOnWarnings(root)).toThrow(/packages\/ui\/package\.json/)
  })

  it('passes scripts that fail on a warning', () => {
    const root = probeProject({
      'package.json': manifest({ scripts: { lint: 'biome check --error-on-warnings' } }),
      'packages/ui/package.json': manifest({ scripts: { lint: 'stylelint "**/*.css" --max-warnings=0' } }),
    })
    expect(() => assertLintFailsOnWarnings(root)).not.toThrow()
  })

  it('fails when it finds no lint script, rather than pass on nothing', () => {
    const root = probeProject({ 'package.json': manifest({ scripts: { test: 'vitest' } }) })
    expect(() => assertLintFailsOnWarnings(root)).toThrow(/no lint script/)
  })
})
