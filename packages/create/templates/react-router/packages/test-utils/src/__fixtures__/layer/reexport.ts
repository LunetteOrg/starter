// @ts-nocheck — fake imports for arch boundary test fixtures
// Re-exports also carry a `from '...'` specifier, so they MUST be visible to
// the boundary scanner (docs/adr/architecture-and-boundaries.md — import boundaries): a layer must not launder a forbidden
// dependency through a barrel re-export.
export * from '~/domain/reexported-all'
export { something } from '~/domain/reexported-named'
export { default as Renamed } from '~/domain/default-reexport'
