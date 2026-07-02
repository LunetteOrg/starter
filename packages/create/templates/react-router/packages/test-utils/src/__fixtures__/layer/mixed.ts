// @ts-nocheck — fake imports for arch boundary test fixtures
import { staticDep } from '~/domain/static-dep'

const LazyDep = () => import('~/domain/lazy-dep')

export { staticDep, LazyDep }
