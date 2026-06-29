// @ts-nocheck — fake imports for arch boundary test fixtures
// Re-exports also carry a `from '...'` specifier, so they MUST be visible to
// the boundary scanner (ADR-0004): a layer must not launder a forbidden
// dependency through a barrel re-export.
export * from '~/domain/reexported-all'
export { something } from '~/domain/reexported-named'
export { default as Renamed } from '~/domain/default-reexport'
