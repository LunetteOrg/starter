/// <reference lib="dom" />
/**
 * The pieces of `jsdom-setup.ts`, kept free of hooks so they can be imported and
 * tested: a module imported by a setup file runs once per worker, so nothing here
 * registers anything or keeps state.
 */

/**
 * What jsdom does not implement and a real DOM always has. Each stub fills an
 * environment gap, not a detail of one case: a `typeof … === 'function'` guard in a
 * component would be production code written to please jsdom. A test that wants to
 * assert one of these calls puts its own `vi.spyOn` on top. An API jsdom already has
 * is left alone.
 */
export function installDomStubs(): void {
  // Components that measure themselves build one on mount (toolbars, scroll areas,
  // floating dropdowns); without it the render throws. No layout, nothing to observe.
  if (typeof globalThis.ResizeObserver !== 'function') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }

  // Missing, not a no-op: calling it is a TypeError. Editors and comboboxes call it
  // on the selected option or the moved selection.
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = () => {}
  }

  // Rich-text editors measure ranges after a dispatch; the missing method surfaces
  // as an unhandled error that fails the run with every test green. No layout, so
  // empty and zeroed rects.
  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  }
  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = () => new DOMRect()
  }

  // With no layout no element is at any point: `null` is the true answer.
  if (typeof document.elementFromPoint !== 'function') {
    document.elementFromPoint = () => null
  }

  // Colour scheme, reduced motion and responsive components read it. No query
  // matches; a test can override it.
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  }
}

/**
 * The jsdom instance vitest's jsdom environment exposes as `globalThis.jsdom`, an
 * internal of vitest rather than a documented API: without it the storages stay as
 * Node left them.
 */
type WithJsdom = { jsdom?: { window: Window } }

/**
 * Gives the page jsdom's own `localStorage` and `sessionStorage` where the global is
 * missing. From Node 25, Node defines both globals itself, and vitest's jsdom
 * environment keeps Node's: `localStorage` is `undefined` unless Node runs with
 * `--localstorage-file`, so a component that reads it throws. A storage the
 * environment already has, Node's `sessionStorage` included, is left alone.
 */
export function installJsdomStorage(): void {
  const dom = (globalThis as WithJsdom).jsdom?.window
  if (!dom) return
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    if ((globalThis as Partial<Record<typeof name, Storage>>)[name] === undefined) {
      Object.defineProperty(globalThis, name, { value: dom[name], configurable: true, writable: true })
    }
  }
}

/** Empties `localStorage` and `sessionStorage`, when the environment has them. */
export function clearStorage(): void {
  const storages = globalThis as { localStorage?: Storage; sessionStorage?: Storage }
  storages.localStorage?.clear()
  storages.sessionStorage?.clear()
}

/**
 * Expires every cookie the page can read, on path `/` and on the current path. A
 * cookie set on another path or domain is not readable from here, and stays.
 */
export function clearCookies(): void {
  const paths = new Set(['/', window.location.pathname])
  for (const pair of document.cookie.split(';')) {
    const name = pair.split('=')[0]?.trim()
    if (!name) continue
    for (const path of paths) {
      // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}`
    }
  }
}

/** Removes from `document.head` every node that is not in `before`. */
export function removeHeadNodesAddedSince(before: ReadonlySet<Node>): void {
  for (const node of [...document.head.childNodes]) if (!before.has(node)) node.remove()
}
