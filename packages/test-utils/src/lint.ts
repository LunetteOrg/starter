import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { TEST_GUARDS_RECORD, workspaces } from './test-modules.ts'

/**
 * The Biome rule domain each dependency calls for. Biome switches a domain on by
 * itself only when it can read the dependency's version from a manifest; a `catalog:`
 * or `workspace:` spec is no version it can read, and the domain stays off without a
 * diagnostic.
 */
export const BIOME_DOMAIN_OF_DEPENDENCY: Readonly<Record<string, string>> = {
  react: 'react',
  'react-native': 'reactNative',
  next: 'next',
  'solid-js': 'solid',
  '@builder.io/qwik': 'qwik',
  svelte: 'svelte',
  vue: 'vue',
  vitest: 'test',
  jest: 'test',
  '@playwright/test': 'playwright',
  'drizzle-orm': 'drizzle',
  turbo: 'turborepo',
  tailwindcss: 'tailwind',
}

export interface BiomeDomainsOptions {
  /** The project's Biome config, relative to the root. Default: `biome.json`, else `biome.jsonc`. */
  config?: string
  /** Dependency name → domain. Default: {@link BIOME_DOMAIN_OF_DEPENDENCY}. */
  domains?: Readonly<Record<string, string>>
}

type Manifest = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

type LinterSection = { domains?: Record<string, string> }
type BiomeConfig = { extends?: string | string[]; linter?: LinterSection; overrides?: { linter?: LinterSection }[] }

/** JSON with comments and trailing commas (`biome.jsonc`, `tsconfig.json`), parsed. */
export function parseJsonc(text: string): unknown {
  // Comments go first, so a comment between a trailing comma and its bracket is gone
  // by the time the commas are read.
  return JSON.parse(dropTrailingCommas(dropComments(text)))
}

/** Walks `text` outside its strings; `step` returns how far it consumed and what to emit. */
function outsideStrings(text: string, step: (i: number) => [next: number, emitted: string]): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; ) {
    const c = text[i] as string
    if (inString) {
      const escaped = c === '\\' ? (text[i + 1] ?? '') : ''
      if (c === '"') inString = false
      out += c + escaped
      i += 1 + escaped.length
    } else if (c === '"') {
      inString = true
      out += c
      i++
    } else {
      const [next, emitted] = step(i)
      out += emitted
      i = next
    }
  }
  return out
}

function dropComments(text: string): string {
  return outsideStrings(text, (i) => {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i)
      return [end === -1 ? text.length : end, '']
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2)
      return [end === -1 ? text.length : end + 2, ' ']
    }
    return [i + 1, text[i] as string]
  })
}

function dropTrailingCommas(text: string): string {
  return outsideStrings(text, (i) => [
    i + 1,
    text[i] === ',' && /^\s*[}\]]/.test(text.slice(i + 1)) ? ' ' : (text[i] as string),
  ])
}

function readJson<T>(path: string): T {
  try {
    return parseJsonc(readFileSync(path, 'utf8')) as T
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** `package.json` at the root, then each workspace's: `[path relative to root, manifest]`. */
function manifests(root: string): [string, Manifest][] {
  const paths = [
    ...(existsSync(join(root, 'package.json')) ? ['package.json'] : []),
    ...workspaces(root).map((workspace) => `${workspace}/package.json`),
  ]
  return paths.map((path) => [path, readJson<Manifest>(join(root, path))])
}

function defaultConfig(root: string): string {
  const found = ['biome.json', 'biome.jsonc'].find((name) => existsSync(join(root, name)))
  if (found === undefined) throw new Error(`No biome.json or biome.jsonc at ${root}`)
  return found
}

function resolveExtends(spec: string, from: string): string {
  if (spec.startsWith('.') || spec.startsWith('/')) return resolve(dirname(from), spec)
  try {
    return createRequire(from).resolve(spec)
  } catch {
    throw new Error(`${from} extends "${spec}", which does not resolve from there`)
  }
}

/**
 * The Biome rule domains a config switches on, in `linter.domains` or any override's,
 * following its `extends` (relative paths and packages). A domain set to `none` is off.
 */
export function enabledBiomeDomains(root: string, config: string = defaultConfig(root)): Set<string> {
  const enabled = new Set<string>()
  const seen = new Set<string>()
  const visit = (path: string) => {
    if (seen.has(path)) return
    seen.add(path)
    const parsed = readJson<BiomeConfig>(path)
    const sections = [parsed.linter, ...(parsed.overrides ?? []).map((override) => override.linter)]
    for (const section of sections) {
      for (const [domain, value] of Object.entries(section?.domains ?? {})) {
        if (value !== 'none') enabled.add(domain)
      }
    }
    const parents = parsed.extends === undefined ? [] : [parsed.extends].flat()
    // `//` is Biome's "the root config of the monorepo": the project's own config here.
    for (const parent of parents.filter((spec) => spec !== '//')) visit(resolveExtends(parent, path))
  }
  visit(resolve(root, config))
  return enabled
}

/**
 * Every dependency of the root manifest and of the workspaces (`apps/*`, `packages/*`)
 * that has a Biome rule domain finds it switched on in the project's Biome config: a
 * domain is declared, never left to Biome's detection.
 *
 * @example
 * ```ts
 * it('the rule domains of the stack are declared', () => {
 *   assertBiomeDomainsDeclared(resolve(__dirname, '../../..'))
 * })
 * ```
 */
export function assertBiomeDomainsDeclared(root: string, options: BiomeDomainsOptions = {}): void {
  const config = options.config ?? defaultConfig(root)
  const table = options.domains ?? BIOME_DOMAIN_OF_DEPENDENCY
  const enabled = enabledBiomeDomains(root, config)
  const required = manifests(root).flatMap(([path, manifest]) =>
    [...new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})])]
      .sort()
      .flatMap((dependency) => {
        const domain = table[dependency]
        return domain === undefined ? [] : [{ path, dependency, domain }]
      }),
  )
  if (required.length === 0) {
    throw new Error(`assertBiomeDomainsDeclared: no dependency of ${root} has a Biome rule domain`)
  }
  const missing = required.filter(({ domain }) => !enabled.has(domain))
  if (missing.length > 0) {
    throw new Error(
      `These dependencies call for a Biome rule domain that ${config} does not switch on ` +
        `(linter.domains or an override):\n` +
        missing.map(({ path, dependency, domain }) => `  - ${path}: ${dependency} → ${domain}`).join('\n') +
        `\nIts rules stay off without a warning. See ${TEST_GUARDS_RECORD} (lint).`,
    )
  }
}

const BIOME = /\bbiome\s+(check|lint|ci)\b/
const STYLELINT = /\bstylelint\b/

/**
 * Every `lint` or `lint:*` script of the root manifest and of the workspaces fails on a
 * warning: each `biome check|lint|ci` it runs carries `--error-on-warnings`, each
 * `stylelint` `--max-warnings 0`.
 */
export function assertLintFailsOnWarnings(root: string): void {
  const scripts = manifests(root).flatMap(([path, manifest]) =>
    Object.entries(manifest.scripts ?? {})
      .filter(([name]) => name === 'lint' || name.startsWith('lint:'))
      .map(([name, command]) => ({ where: `${path} → ${name}`, command })),
  )
  if (scripts.length === 0) throw new Error(`assertLintFailsOnWarnings: no lint script found in ${root}`)
  const offenders = scripts.flatMap(({ where, command }) =>
    command
      .split(/&&|\|\||;|\|/)
      .map((step) => step.trim())
      .flatMap((step) => {
        if (BIOME.test(step) && !/--error-on-warnings\b/.test(step)) {
          return [`  - ${where}: \`${step}\` needs --error-on-warnings`]
        }
        if (STYLELINT.test(step) && !/--max-warnings[\s=]+0\b/.test(step)) {
          return [`  - ${where}: \`${step}\` needs --max-warnings 0`]
        }
        return []
      }),
  )
  if (offenders.length > 0) {
    throw new Error(
      `These lint scripts let a warning through:\n${offenders.join('\n')}\n` +
        `A warning fails the script like an error. See ${TEST_GUARDS_RECORD} (lint).`,
    )
  }
}
