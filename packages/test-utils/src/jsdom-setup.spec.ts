// @vitest-environment jsdom
/// <reference lib="dom" />
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearCookies, clearStorage, installDomStubs, removeHeadNodesAddedSince } from './jsdom-env.ts'
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
    const own = () => null
    document.elementFromPoint = own
    installDomStubs()
    expect(document.elementFromPoint).toBe(own)
  })

  it('make act() flush synchronously in every file', () => {
    expect((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT).toBe(true)
  })
})

// The two tests run in order: the second sees what the first left.
describe('after each test', () => {
  it('a test renders and moves to fake timers', () => {
    render(createElement('p', null, 'left behind'))
    vi.useFakeTimers()
    expect(document.body.textContent).toBe('left behind')
  })

  it('the next one finds the tree unmounted and the real clock', () => {
    expect(document.body.textContent).toBe('')
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
