/**
 * This package's jsdom setup, as a module specifier or a path: the published name
 * `@lntt/test-utils/jsdom-setup`, the built file under `node_modules`
 * (`@lntt/test-utils/dist/jsdom-setup.js`), or a path whose last directories are
 * `test-utils/src` or `test-utils/dist` (the source or the build in a workspace), with
 * no extension or one of `.js`, `.ts`, `.mjs`, `.cjs`, `.mts`, `.cts`. An app's own
 * file named `jsdom-setup`, an alias, or a copy under another directory name is not
 * it; an app's own file at `test-utils/src/jsdom-setup` or `test-utils/dist/jsdom-setup`
 * is, since a path does not say which package holds it. `appTest()` refuses it in
 * `setupFiles`, and `findJsdomSetupImports()` reports an import of it.
 */
export const JSDOM_SETUP_PATH =
  /(^|[/\\])(@lntt[/\\]test-utils([/\\]dist)?|test-utils[/\\](src|dist))[/\\]jsdom-setup(\.[cm]?[jt]s)?$/
