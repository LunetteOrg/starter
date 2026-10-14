// @ts-nocheck — fixture. Anti-pattern: throwing instead of returning a typed error.
export function bad() {
  throw new Error('boom') // real violation on this line
}
