// @ts-nocheck — fake imports for arch boundary test fixtures
// Side-effect import: no `from`, no binding. Still couples the layer to the
// module and MUST be caught by the boundary scanner (ADR-0004).
import '~/domain/side-effect-dep'
