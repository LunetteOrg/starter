// @ts-nocheck — fake imports for arch boundary test fixtures
const LazyRoute = () =>
  import(
    '~/domain/multiline-route'
  )

export default LazyRoute
