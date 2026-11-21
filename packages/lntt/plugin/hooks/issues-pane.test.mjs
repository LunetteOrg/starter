import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { announce, EMPTY, issuesPane, KEPT, merge, PANE, recall, remember, rowsOf, TRIES, textOf } from './issues-pane.mjs'

const row = (n, at, i = 0, repo = 'o/r') => ({ ref: `${repo}#${n}`, title: `Title ${n}`, url: `https://github.com/${repo}/issues/${n}`, at, i })
const fresh = (n, repo = 'o/r') => ({ ref: `${repo}#${n}`, title: `Title ${n}`, url: `https://github.com/${repo}/issues/${n}` })

// A fake `$.state` for one value: `get` answers what stands and its version, `set` honours
// `ifVersion`. `beat` runs before each write (another write landing first); `broken` makes
// every call throw.
function fakeState({ value, broken = false, beat = null } = {}) {
  const s = { value, version: value === undefined ? 0 : 1, gets: 0, sets: 0, refs: [] }
  s.$ = {
    state: {
      get: async (ref) => {
        if (broken) throw new Error('state is down')
        s.gets += 1
        s.refs.push(ref)
        return { value: s.value, version: s.version }
      },
      set: async (ref, v, opts) => {
        s.sets += 1
        s.refs.push(ref)
        beat?.(s)
        if (opts?.ifVersion !== undefined && opts.ifVersion !== s.version) return { isSet: false, version: s.version }
        s.value = v
        s.version += 1
        return { isSet: true, version: s.version }
      },
    },
  }
  return s
}

const el = (type) => (props) => ({ type, props })
// What a drawn tree reads as, one line per row.
const flatten = (node) => {
  if (typeof node === 'string') return node
  const kids = node.props.children
  return node.props.flexDirection === 'column' ? kids.map(flatten).join('\n') : kids.map(flatten).join('')
}

describe('the list of what the session cited', () => {
  test('rowsOf lists the most recently cited first, a block\'s references in the order of its text', () => {
    const rows = rowsOf({ rows: [row(1, 10, 1), row(2, 30, 0), row(3, 10, 0)] })
    assert.deepEqual(rows.map((r) => r.ref), ['o/r#2', 'o/r#3', 'o/r#1'])
  })

  test('rowsOf reads what an earlier version stored in another shape as nothing', () => {
    for (const value of [undefined, null, [], 'x', { rows: 'x' }, [row(1, 1)]]) assert.deepEqual(rowsOf(value), [])
  })

  test('rowsOf drops a row that is no reference with a title and a URL', () => {
    const good = row(1, 5)
    const bad = [
      { ...row(2, 5), ref: 'not a ref' },
      { ...row(3, 5), ref: 'O/R#3' },
      { ...row(4, 5), title: '  ' },
      { ...row(5, 5), url: 'http://github.com/o/r/issues/5' },
      { ...row(6, 5), at: 'now' },
      { ...row(7, 5), i: undefined },
      null,
    ]
    assert.deepEqual(rowsOf({ rows: [...bad, good] }).map((r) => r.ref), ['o/r#1'])
  })

  test('rowsOf cleans a title as the box does: no control or format character reaches the screen', () => {
    const [r] = rowsOf({ rows: [{ ...row(1, 1), title: 'Fix\u001b[31m it‮' }] })
    assert.equal(r.title, 'Fix[31m it')
  })

  test('merge puts a block\'s references first, in its order, and a reference cited again moves up', () => {
    const rows = merge([row(1, 10), row(2, 10, 1), row(3, 5)], [fresh(3), fresh(4)], 20)
    assert.deepEqual(rows.map((r) => [r.ref, r.at, r.i]), [
      ['o/r#3', 20, 0],
      ['o/r#4', 20, 1],
      ['o/r#1', 10, 0],
      ['o/r#2', 10, 1],
    ])
  })

  test('merge: a block read earlier that finds a title late updates it and leaves the later citation on top', () => {
    const rows = merge([row(1, 20), row(2, 10)], [{ ...fresh(1), title: 'Renamed' }, fresh(3)], 15)
    assert.deepEqual(rows.map((r) => [r.ref, r.at, r.title]), [
      ['o/r#1', 20, 'Renamed'],
      ['o/r#3', 15, 'Title 3'],
      ['o/r#2', 10, 'Title 2'],
    ])
  })

  test('merge: a row stored at the same stamp is replaced by the block\'s own place, one stored later keeps its place', () => {
    const same = merge([row(1, 15, 5), row(2, 15, 0)], [fresh(1)], 15)
    assert.deepEqual(same.map((r) => [r.ref, r.at, r.i]), [['o/r#1', 15, 0], ['o/r#2', 15, 0]])
    const later = merge([row(2, 20, 0), row(1, 20, 5)], [fresh(1)], 15)
    assert.deepEqual(later.map((r) => [r.ref, r.at, r.i]), [['o/r#2', 20, 0], ['o/r#1', 20, 5]])
  })

  test('merge keeps KEPT rows, the oldest cited forgotten first', () => {
    const many = Array.from({ length: KEPT }, (_, n) => row(n + 1, n + 1))
    const rows = merge(many, [fresh(999)], KEPT + 10)
    assert.equal(rows.length, KEPT)
    assert.equal(rows[0].ref, 'o/r#999')
    assert.ok(!rows.some((r) => r.ref === 'o/r#1'))
  })
})

describe('the plugin\'s contract', () => {
  test('plugin.json names a types file that declares what the plugin keeps', () => {
    const dir = new URL('../', import.meta.url)
    const manifest = JSON.parse(readFileSync(new URL('.claude-plugin/plugin.json', dir), 'utf8'))
    assert.equal(manifest.types, './types/index.d.ts')
    const file = new URL(manifest.types, dir)
    assert.ok(existsSync(file))
    assert.match(readFileSync(file, 'utf8'), /interface PluginState \{\s*lunette: \{ cited: /)
  })
})

describe('remember and recall', () => {
  test('remember writes the references with a title under the lunette.cited name, with the repository', async () => {
    const s = fakeState()
    await remember(s.$, { home: 'o/r', fresh: [fresh(1), fresh(2)], at: 7 })
    assert.deepEqual(s.refs[0], { plugin: 'lunette', key: 'cited' })
    assert.equal(s.value.home, 'o/r')
    assert.deepEqual(s.value.rows.map((r) => [r.ref, r.at, r.i]), [['o/r#1', 7, 0], ['o/r#2', 7, 1]])
  })

  test('remember with nothing to say reads and writes nothing', async () => {
    const s = fakeState()
    await remember(s.$, { home: 'o/r', fresh: [], at: 7 })
    assert.equal(s.gets + s.sets, 0)
  })

  test('remember keeps the repository it knew when it is given none', async () => {
    const s = fakeState({ value: { home: 'o/r', rows: [] } })
    await remember(s.$, { home: null, fresh: [fresh(1)], at: 1 })
    assert.equal(s.value.home, 'o/r')
  })

  test('a write another one beat is made again on what stands, and loses neither', async () => {
    let beaten = false
    const s = fakeState({
      value: { home: 'o/r', rows: [row(1, 1)] },
      beat: (st) => {
        if (beaten) return
        beaten = true
        st.value = { home: 'o/r', rows: [row(1, 1), row(9, 2)] }
        st.version += 1
      },
    })
    await remember(s.$, { home: 'o/r', fresh: [fresh(2)], at: 3 })
    assert.deepEqual(s.value.rows.map((r) => r.ref), ['o/r#2', 'o/r#9', 'o/r#1'])
    assert.equal(s.sets, 2)
  })

  test('a write that keeps losing is let go after a few tries', async () => {
    const s = fakeState({ value: { rows: [] }, beat: (st) => (st.version += 1) })
    await remember(s.$, { home: 'o/r', fresh: [fresh(1)], at: 1 })
    assert.equal(s.sets, TRIES)
  })

  test('a state that fails never throws: the box does not depend on it', async () => {
    await remember(fakeState({ broken: true }).$, { home: 'o/r', fresh: [fresh(1)], at: 1 })
    await remember({}, { home: 'o/r', fresh: [fresh(1)], at: 1 })
    assert.deepEqual(await recall(fakeState({ broken: true }).$), { home: null, rows: [] })
  })

  test('recall gives the rows as stored, ordered', async () => {
    const s = fakeState({ value: { home: 'o/r', rows: [row(1, 1), row(2, 2)] } })
    const { home, rows } = await recall(s.$)
    assert.equal(home, 'o/r')
    assert.deepEqual(rows.map((r) => r.ref), ['o/r#2', 'o/r#1'])
  })
})

describe('the /issues command and its pane', () => {
  function plugin({ state = fakeState(), placed = true, open = null, register = null } = {}) {
    const hooks = []
    const opened = []
    const registered = []
    issuesPane((event, matcher, hook) => {
      hooks.push({ event, matcher, hook })
      return { catch: () => {} }
    })
    const $ = {
      ...state.$,
      command: { register: register ?? (async (spec) => registered.push(spec)) },
      ui: {
        open: open ?? (async (args) => (opened.push(args), { isPlaced: placed })),
        resolve: () => ({ Box: el('Box'), Text: el('Text') }),
      },
    }
    const hook = (event, requestId) => hooks.find((h) => h.event === event && (!requestId || h.matcher?.requestId === requestId)).hook
    return { $, hooks, opened, registered, state, command: () => hook('command.run')($), pane: () => hook('ui.render', PANE)($, { surface: 'terminal', component: 'Pane', requestId: PANE, props: {} }, async () => 'ENGINE') }
  }

  test('the plugin hooks the command and the pane of its id, nothing else', () => {
    const { hooks } = plugin()
    assert.deepEqual(hooks.map((h) => [h.event, h.matcher]), [
      ['command.run', { command: 'issues' }],
      ['ui.render', { component: 'Pane', requestId: PANE }],
    ])
  })

  test('announce registers /issues with a description', async () => {
    const { $, registered } = plugin()
    await announce($)
    assert.equal(registered.length, 1)
    assert.equal(registered[0].name, 'issues')
    assert.ok(registered[0].description)
  })

  test('announce never throws: a refused registration leaves the session as it was', async () => {
    let asked = 0
    const { $ } = plugin({ register: async () => { asked += 1; throw new Error('refused') } })
    await announce($)
    assert.equal(asked, 1)
  })

  test('the command opens the pane by its id and title, and says so', async () => {
    const p = plugin()
    assert.deepEqual(await p.command(), { text: 'Issues pane opened.' })
    assert.deepEqual(p.opened, [{ id: PANE, title: 'Issues and pull requests' }])
  })

  test('where no surface seats the pane, the command answers with the list as text', async () => {
    const state = fakeState({ value: { home: 'o/r', rows: [row(1, 1), row(2, 2)] } })
    const { text } = await plugin({ state, placed: false }).command()
    assert.equal(text, '#2 Title 2\n  https://github.com/o/r/issues/2\n#1 Title 1\n  https://github.com/o/r/issues/1')
  })

  test('a pane that cannot be opened (the call fails) also answers with the list', async () => {
    const state = fakeState({ value: { home: 'o/r', rows: [row(1, 1)] } })
    const { text } = await plugin({ state, open: async () => { throw new Error('no ui') } }).command()
    assert.equal(text, '#1 Title 1\n  https://github.com/o/r/issues/1')
  })

  test('the pane lists each reference: number, title, URL under it, the most recent first', async () => {
    const state = fakeState({ value: { home: 'o/r', rows: [row(1, 1), row(12, 2), row(7, 2, 1, 'o/other')] } })
    const tree = await plugin({ state }).pane()
    assert.equal(
      flatten(tree),
      [
        '#12     Title 12',
        '        https://github.com/o/r/issues/12',
        'other#7 Title 7',
        '        https://github.com/o/other/issues/7',
        '#1      Title 1',
        '        https://github.com/o/r/issues/1',
      ].join('\n'),
    )
  })

  test('the pane draws only elements of the surface and no terminal sequence', async () => {
    const state = fakeState({ value: { home: 'o/r', rows: [{ ...row(1, 1), title: 'A \u001b[2J title' }] } })
    const tree = JSON.stringify(await plugin({ state }).pane())
    assert.doesNotMatch(tree, /\\u001b|\u001b/)
  })

  test('the pane says nothing is cited yet while the list is empty', async () => {
    const tree = await plugin().pane()
    assert.equal(flatten(tree), EMPTY)
  })

  test('a pane whose state cannot be read says nothing is cited, and a drawing that fails goes to the engine', async () => {
    assert.equal(flatten(await plugin({ state: fakeState({ broken: true }) }).pane()), EMPTY)
    const p = plugin()
    p.$.ui.resolve = () => { throw new Error('no elements') }
    const hook = p.hooks.find((h) => h.event === 'ui.render').hook
    assert.equal(await hook(p.$, { component: 'Pane', requestId: PANE }, async () => 'ENGINE'), 'ENGINE')
  })

  test('textOf of an empty list says nothing is cited', () => {
    assert.equal(textOf({ home: null, rows: [] }), EMPTY)
  })
})
