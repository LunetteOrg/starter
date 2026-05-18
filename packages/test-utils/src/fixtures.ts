type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K]
}

function deepMerge<T extends Record<string, unknown>>(base: T, overrides: DeepPartial<T>): T {
  const result = { ...base }
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const baseVal = base[key]
    const overrideVal = overrides[key]
    if (
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      ) as T[keyof T]
    } else {
      result[key] = overrideVal as T[keyof T]
    }
  }
  return result
}

/**
 * Generic fixture builder. Creates entities with sensible defaults
 * that can be overridden per-test.
 *
 * Nested objects are deep-merged — overriding one field inside a nested object
 * preserves all other fields in that object.
 *
 * Usage:
 *   const buildUser = defineFixture({ email: 'test@example.com', name: 'Test' })
 *   const user = buildUser({ name: 'Custom' }) // { email: 'test@example.com', name: 'Custom' }
 */
export function defineFixture<T extends Record<string, unknown>>(
  defaults: T,
): (overrides?: DeepPartial<T>) => T {
  return (overrides) => deepMerge(defaults, overrides ?? {})
}
