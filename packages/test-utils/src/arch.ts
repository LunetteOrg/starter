import { readFile } from 'node:fs/promises'
import { glob } from 'glob'
import { expect } from 'vitest'

/**
 * Scans files matching `pattern` and returns a map of file path → import specifiers.
 *
 * @param pattern - Must be an absolute path or an absolute-anchored glob
 *   (e.g. `resolve(__dirname, '../domain/**\/*.ts')`). Relative paths resolve
 *   against `process.cwd()` and may produce unexpected results.
 * @param opts.ignore - Glob patterns to exclude. Defaults to
 *   `['**\/*.spec.ts', '**\/*.test.ts']` so test files don't pollute boundary checks.
 */
export async function getImports(
  pattern: string,
  opts?: { ignore?: string[] },
): Promise<Map<string, string[]>> {
  const ignore = opts?.ignore ?? ['**/*.spec.ts', '**/*.test.ts']
  const files = await glob(pattern, { ignore })
  if (files.length === 0) {
    throw new Error(`No files matched pattern: ${pattern}`)
  }
  const result = new Map<string, string[]>()
  for (const file of files) {
    let content: string
    try {
      content = await readFile(file, 'utf-8')
    } catch (e) {
      throw new Error(`Failed to read ${file}: ${e instanceof Error ? e.message : String(e)}`)
    }

    const staticImports = [...content.matchAll(/from\s+['"]([^'"]+)['"]/g)]
      .map((m) => m[1])
      .filter((s): s is string => s !== undefined)

    const dynamicImports = [...content.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)]
      .map((m) => m[1])
      .filter((s): s is string => s !== undefined)

    // Template-literal dynamic imports: capture the static prefix before interpolation.
    const templateImports = [...content.matchAll(/import\(\s*`([^`$]*)/g)]
      .map((m) => m[1])
      .filter((s): s is string => s !== undefined && s.length > 0)

    result.set(file, [...staticImports, ...dynamicImports, ...templateImports])
  }
  return result
}

export function assertNoForbiddenImports(
  imports: Map<string, string[]>,
  forbidden: RegExp[],
  layerName: string,
) {
  for (const [file, deps] of imports) {
    for (const dep of deps) {
      for (const pattern of forbidden) {
        expect(dep, `${layerName} violation in ${file}: imports "${dep}"`).not.toMatch(pattern)
      }
    }
  }
}

const DEFAULT_TEST_IGNORE = ['**/*.spec.ts', '**/*.test.ts']

export interface LayerBoundaryOptions {
  /**
   * Absolute glob for the layer's source files
   * (e.g. `resolve(__dirname, '**\/*.{ts,tsx}')`).
   */
  pattern: string
  /** Layer name shown in violation messages (e.g. `'domain'`). */
  layer: string
  /** Import specifiers that must NOT appear in the layer, as regexes. */
  forbidden: RegExp[]
  /** Extra ignore globs, merged with the default `*.spec.ts`/`*.test.ts` excludes. */
  ignore?: string[]
}

/**
 * Auto-discovers a layer's source files and asserts none import a forbidden
 * specifier. Built on {@link getImports}, so it also catches dynamic
 * `import()` (static and template-literal forms) that inline regex guards miss.
 *
 * Mirror the matching Biome `noRestrictedImports` override (ADR-0004): the same
 * violation should fail both lint and this test. `getImports` throws when the
 * pattern matches no files, so a misconfigured path fails loudly instead of
 * passing vacuously.
 *
 * @example
 * ```ts
 * await assertLayerBoundaries({
 *   pattern: resolve(__dirname, '**\/*.{ts,tsx}'),
 *   layer: 'domain',
 *   forbidden: [/^react-router/, /^#app\/lib\//],
 * })
 * ```
 */
export async function assertLayerBoundaries(opts: LayerBoundaryOptions): Promise<void> {
  const ignore = [...DEFAULT_TEST_IGNORE, ...(opts.ignore ?? [])]
  const imports = await getImports(opts.pattern, { ignore })
  assertNoForbiddenImports(imports, opts.forbidden, opts.layer)
}
