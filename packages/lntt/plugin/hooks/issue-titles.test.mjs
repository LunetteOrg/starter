import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { box, cite, entry, label, message, settled, TITLE_MAX } from './issue-titles.mjs'

const HOME = 'o/r'
const url = (n, repo = HOME) => `https://github.com/${repo}/issues/${n}`
const k = (n, repo = HOME) => `${repo}#${n}`
const known = new Map([
  [k(138), { title: 'Publish @lntt/lntt with the other @lntt packages', url: url(138) }],
  [k(134), { title: 'lntt review stops at delivery.review.maxRounds', url: url(134) }],
])
// The mentions `lntt refs` gives for a text, for these tests: `#N` and `owner/repo#N`,
// each ending where its number does. Which numbers are references is lntt's, tested there.
const find = (text) =>
  [...text.matchAll(/(?:([a-z]+\/[a-z]+))?#([1-9]\d*)/g)].map((x) => ({
    text: x[0],
    ref: `${x[1] ?? HOME}#${x[2]}`,
    index: x.index,
    after: x.index + x[0].length,
  }))
// A block of these pieces of text, cited the way the hook does: whole.
const show = (pieces) => {
  const m = message()
  const text = pieces.join('')
  cite(m, find(text), text)
  return m
}
// What the box reads as, a line of text per row, and which segments are dim.
const rows = (lines) => lines.map((line) => line.map((g) => g.text).join(''))

describe('what a message cites', () => {
  test('every reference once, in the order the text gives them', () => {
    assert.deepEqual(show(['first #138\n', 'again #138 and #134\n']).cited, [k(138), k(134)])
  })

  test('a number at the very end of the text is cited', () => {
    assert.deepEqual(show(['See #138']).cited, [k(138)])
  })

  test('each block starts over: what another block cited does not count', () => {
    show(['#138 first.\n'])
    assert.deepEqual(show(['#134 only.\n']).cited, [k(134)])
  })

  test('a mention lntt gave that does not fit the text, or has no ref, is skipped', () => {
    const m = message()
    const text = '#138\n'
    const bad = [
      { ref: k(138), index: 0, after: 99 },
      { ref: k(138), index: 3, after: 1 },
      { ref: null, index: 0, after: 4 },
      { ref: 'nonsense', index: 0, after: 4 },
      { ref: k(138), index: '0', after: 4 },
    ]
    cite(m, bad, text)
    assert.deepEqual(m.cited, [])
    for (const x of bad) assert.equal(settled(x, text), false)
  })

  test('a ref that is not a lower-case owner/repo#N is ignored: nothing cited', () => {
    const m = message()
    const text = '#5 x\n'
    const bad = ['o/r\u001b]0;pwned\u0007#5', 'O/R#5', 'o/.r#5', '-o/r#5', 'o/r#05', 'o/r/x#5']
    cite(m, bad.map((ref) => ({ ref, index: 0, after: 2 })), text)
    assert.deepEqual(m.cited, [])
  })
})

describe('the box of what the block cited', () => {
  test('every number found, in the order cited, its title dimmed and its URL plain', () => {
    const m = show(['#134, "lntt review stops at delivery.review.maxRounds", then #138.\n', 'And #999.\n'])
    const lines = box(m, known, HOME)
    assert.deepEqual(rows(lines), [
      '╭─ cited',
      `│ #134 ${known.get(k(134)).title}`,
      `│      ${url(134)}`,
      `│ #138 ${known.get(k(138)).title}`,
      `│      ${url(138)}`,
      '╰─',
    ])
    assert.deepEqual(
      lines[1].map((g) => g.dim),
      [true, false, true],
    )
    assert.deepEqual(
      lines[2].map((g) => g.dim),
      [true, false, false],
    )
  })

  test('no terminal sequence is put in a segment', () => {
    const m = show(['#134 and #138\n'])
    for (const g of box(m, known, HOME).flat()) assert.ok(!g.text.includes('\u001b'))
  })

  test('titles and URLs line up under the widest number', () => {
    const info = new Map([...known, [k(7), { title: 'Seven', url: url(7) }]])
    const m = show(['#7 then #138.\n'])
    const lines = rows(box(m, info, HOME))
    assert.equal(lines[1], '│ #7   Seven')
    assert.equal(lines[2], `│      ${url(7)}`)
    assert.equal(lines[4], `│      ${url(138)}`)
  })

  test('a long title is cut by what a reader sees as one character, never inside an emoji', () => {
    const family = '👨‍👩‍👧'
    const title = `${'x'.repeat(TITLE_MAX - 2)}${family}${family}${family}`
    const info = new Map([[k(8), { title, url: url(8) }]])
    assert.ok(rows(box(show(['#8 here\n']), info, HOME))[1].includes(`${'x'.repeat(TITLE_MAX - 2)}${family}…`))
  })

  test('a long title is cut', () => {
    const info = new Map([[k(7), { title: 'x'.repeat(TITLE_MAX + 20), url: url(7) }]])
    const line = rows(box(show(['#7 here\n']), info, HOME))[1]
    assert.ok(line.includes(`${'x'.repeat(TITLE_MAX - 1)}…`))
    assert.ok(!line.includes('x'.repeat(TITLE_MAX + 1)))
  })

  test('no box when the block cites nothing found', () => {
    const m = show(['Nothing here, and #999.\n'])
    assert.deepEqual(box(m, known, HOME), [])
  })

  test('the box labels each reference as short as stays clear', () => {
    assert.equal(label(k(4), HOME), '#4')
    assert.equal(label(k(4, 'o/starter'), HOME), 'starter#4')
    assert.equal(label(k(4, 'x/pelion'), HOME), 'x/pelion#4')
    const other = new Map([
      [k(3, 'x/pelion'), { title: 'Pelion three', url: url(3, 'x/pelion') }],
      [k(65), { title: 'Home sixty-five', url: url(65) }],
    ])
    const m = show(['#65 and x/pelion#3\n'])
    const lines = rows(box(m, other, HOME))
    assert.equal(lines[1], '│ #65        Home sixty-five')
    assert.equal(lines[3], '│ x/pelion#3 Pelion three')
  })
})
