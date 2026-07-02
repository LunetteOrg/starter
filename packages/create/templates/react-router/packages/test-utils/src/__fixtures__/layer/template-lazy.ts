// @ts-nocheck — fake imports for arch boundary test fixtures
const routeName = 'example'
const LazyRoute = () => import(`~/domain/${routeName}`)

export default LazyRoute
