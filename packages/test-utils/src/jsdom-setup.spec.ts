// @vitest-environment jsdom
/// <reference lib="dom" />
import { render } from '@testing-library/react'
import { createElement, useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearCookies,
  clearStorage,
  installDomStubs,
  installJsdomStorage,
  removeHeadNodesAddedSince,
} from './jsdom-env.ts'
// The subject: its hooks attach to this file. A project lists it in setupFiles.
import './jsdom-setup.ts'

describe('the stubs', () => {
  it('fill what jsdom lacks', () => {
    expect(typeof ResizeObserver).toBe('function')
    expect(() => new ResizeObserver(() => {}).observe(document.body)).not.toThrow()
    expect(() => document.body.scrollIntoView()).not.toThrow()
    expect([...document.createRange().getClientRects()]).toEqual([])
    expect(document.createRange().getBoundingClientRect()).toMatchObject({ width: 0, height: 0 })
    expect(document.elementFromPoint(0, 0)).toBeNull()
    expect(window.matchMedia('(prefers-color-scheme: dark)')).toMatchObject({
      matches: false,
      media: '(prefers-color-scheme: dark)',
    })
  })

  it('leave an API the environment already has alone', () => {
    const saved = {
      ResizeObserver: globalThis.ResizeObserver,
      scrollIntoView: Element.prototype.scrollIntoView,
      getClientRects: Range.prototype.getClientRects,
      getBoundingClientRect: Range.prototype.getBoundingClientRect,
      elementFromPoint: document.elementFromPoint,
      matchMedia: window.matchMedia,
    }
    const own = {
      ResizeObserver: class {} as unknown as typeof ResizeObserver,
      scrollIntoView: () => {},
      getClientRects: () => [] as unknown as DOMRectList,
      getBoundingClientRect: () => new DOMRect(1, 1),
      elementFromPoint: () => null,
      matchMedia: (() => null) as unknown as typeof window.matchMedia,
    }
    try {
      globalThis.ResizeObserver = own.ResizeObserver
      Element.prototype.scrollIntoView = own.scrollIntoView
      Range.prototype.getClientRects = own.getClientRects
      Range.prototype.getBoundingClientRect = own.getBoundingClientRect
      document.elementFromPoint = own.elementFromPoint
      window.matchMedia = own.matchMedia
      installDomStubs()
      expect({
        ResizeObserver: globalThis.ResizeObserver,
        scrollIntoView: Element.prototype.scrollIntoView,
        getClientRects: Range.prototype.getClientRects,
        getBoundingClientRect: Range.prototype.getBoundingClientRect,
        elementFromPoint: document.elementFromPoint,
        matchMedia: window.matchMedia,
      }).toEqual(own)
    } finally {
      globalThis.ResizeObserver = saved.ResizeObserver
      Element.prototype.scrollIntoView = saved.scrollIntoView
      Range.prototype.getClientRects = saved.getClientRects
      Range.prototype.getBoundingClientRect = saved.getBoundingClientRect
      document.elementFromPoint = saved.elementFromPoint
      window.matchMedia = saved.matchMedia
    }
  })

  it('give the page jsdom’s storage where the global is missing', () => {
    // The setup ran installJsdomStorage: on Node 25 and later Node's localStorage
    // is undefined here without it.
    const { window: dom } = (globalThis as unknown as { jsdom: { window: Window } }).jsdom
    expect(localStorage).toBe(dom.localStorage)
    expect(() => localStorage.setItem('k', 'v')).not.toThrow()
    localStorage.clear()
  })

  it('leave a storage the environment already has alone', () => {
    const own = { clear() {} } as Storage
    vi.stubGlobal('localStorage', undefined)
    vi.stubGlobal('sessionStorage', own)
    installJsdomStorage()
    const { window: dom } = (globalThis as unknown as { jsdom: { window: Window } }).jsdom
    expect(localStorage).toBe(dom.localStorage)
    expect(sessionStorage).toBe(own)
    vi.unstubAllGlobals()
  })

  it('make act() flush synchronously in every file', () => {
    expect((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT).toBe(true)
  })
})

// The two tests run in order: the second sees what the first left.
describe('after each test', () => {
  let unmountTimerRan = false
  // An editor destroyed in `setTimeout(…, 1)` when its component unmounts.
  function Editor() {
    useEffect(
      () => () => {
        setTimeout(() => {
          unmountTimerRan = true
        }, 1)
      },
      [],
    )
    return createElement('p', null, 'left behind')
  }

  it('a test renders and moves to fake timers', () => {
    render(createElement(Editor))
    vi.useFakeTimers()
    expect(document.body.textContent).toBe('left behind')
  })

  it('the next one finds the tree unmounted, its unmount timer run, and the real clock', () => {
    expect(document.body.textContent).toBe('')
    expect(unmountTimerRan).toBe(true)
    expect(vi.isFakeTimers()).toBe(false)
  })
})

describe('what a file leaves in the environment', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('clearStorage empties local and session storage', () => {
    // jsdom's own: on Node 25 and later the global is Node's, undefined here.
    const { window: dom } = (globalThis as unknown as { jsdom: { window: Window } }).jsdom
    vi.stubGlobal('localStorage', dom.localStorage)
    vi.stubGlobal('sessionStorage', dom.sessionStorage)
    localStorage.setItem('a', '1')
    sessionStorage.setItem('b', '2')
    clearStorage()
    expect([localStorage.length, sessionStorage.length]).toEqual([0, 0])
  })

  it('clearStorage does nothing when the environment has no storage', () => {
    vi.stubGlobal('localStorage', undefined)
    vi.stubGlobal('sessionStorage', undefined)
    expect(() => clearStorage()).not.toThrow()
  })

  it('clearCookies expires the cookies the page reads', () => {
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API
    document.cookie = 'session=abc; path=/'
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API
    document.cookie = 'theme=dark'
    clearCookies()
    expect(document.cookie).toBe('')
  })

  it('clearCookies expires a cookie set on the current path', () => {
    history.pushState({}, '', '/a/b')
    try {
      // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API
      document.cookie = 'deep=1; path=/a/b'
      expect(document.cookie).toBe('deep=1')
      clearCookies()
      expect(document.cookie).toBe('')
    } finally {
      history.pushState({}, '', '/')
    }
  })

  it('removeHeadNodesAddedSince removes only the nodes added after the snapshot', () => {
    const kept = document.head.appendChild(document.createElement('meta'))
    const before = new Set(document.head.childNodes)
    document.head.appendChild(document.createElement('style'))
    document.head.appendChild(document.createElement('link'))
    removeHeadNodesAddedSince(before)
    expect([...document.head.childNodes]).toEqual([...before])
    expect(kept.isConnected).toBe(true)
  })
})
