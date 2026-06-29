// @ts-nocheck — fake imports for arch boundary test fixtures
// `import type` still couples layers at the source level and must be caught by
// the boundary scanner (ADR-0004): a type-only import of a forbidden module is
// still a forbidden import.
import type { Thing } from '~/domain/type-only'

export type Wrapper = { thing: Thing }
