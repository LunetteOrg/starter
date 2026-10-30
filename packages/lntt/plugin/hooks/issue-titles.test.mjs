import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { cite, entry, footer, label, message, settled, TITLE_MAX } from './issue-titles.mjs'

const dim = (text) => `\u001b[2m${text}\u001b[22m`
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
// A message of these deltas, cited the way the hook does at the last one: whole.
const show = (deltas) => {
  const m = message()
  for (const d of deltas) m.text += d
  cite(m, find(m.text), m.text)
  return m
}

describe('what a message cites', () => {
  test('every reference once, in the order the text gives them', () => {
    assert.deepEqual(show(['first #138\n', 'again #138 and #134\n']).cited, [k(138), k(134)])
  })

  test('a number split across deltas is the one the message cites', () => {
    assert.deepEqual(show(['See #1', '38 now.', ' end']).cited, [k(138)])
  })

  test('a number at the very end of the text is cited', () => {
    assert.deepEqual(show(['See #138']).cited, [k(138)])
  })

  test('each message starts over: what another message cited does not count', () => {
    show(['#138 first.\n'])
    assert.deepEqual(show(['#134 only.\n']).cited, [k(134)])
  })

  test('a mention lntt gave that does not fit the text, or has no ref, is skipped', () => {
    const m = message()
    m.text = '#138\n'
    const bad = [
      { ref: k(138), index: 0, after: 99 },
      { ref: k(138), index: 3, after: 1 },
      { ref: null, index: 0, after: 4 },
      { ref: 'nonsense', index: 0, after: 4 },
      { ref: k(138), index: '0', after: 4 },
    ]
    cite(m, bad, m.text)
    assert.deepEqual(m.cited, [])
    for (const x of bad) assert.equal(settled(x, m.text), false)
  })

  test('a ref that is not a lower-case owner/repo#N is ignored: nothing cited', () => {
    const m = message()
    m.text = '#5 x\n'
    const bad = ['o/r\u001b]0;pwned\u0007#5', 'O/R#5', 'o/.r#5', '-o/r#5', 'o/r#05', 'o/r/x#5']
    cite(m, bad.map((ref) => ({ ref, index: 0, after: 2 })), m.text)
    assert.deepEqual(m.cited, [])
  })
})

describe('the box of what the message cited', () => {
  test('every number found, in the order cited, its title dimmed and its URL plain', () => {
    const m = show(['#134, "lntt review stops at delivery.review.maxRounds", then #138.\n', 'And #999.\n'])
    const box = footer(m, known, HOME)
    assert.equal(
      box,
      [
        '',
        dim('╭─ cited'),
        `${dim('│')} #134 ${dim(known.get(k(134)).title)}`,
        `${dim('│')}      ${url(134)}`,
        `${dim('│')} #138 ${dim(known.get(k(138)).title)}`,
        `${dim('│')}      ${url(138)}`,
        dim('╰─'),
      ].join('\n'),
    )
  })

  test('titles and URLs line up under the widest number', () => {
    const info = new Map([...known, [k(7), { title: 'Seven', url: url(7) }]])
    const m = show(['#7 then #138.\n'])
    const box = footer(m, info, HOME).split('\n')
    assert.equal(box[2], `${dim('│')} #7   ${dim('Seven')}`)
    assert.equal(box[3], `${dim('│')}      ${url(7)}`)
    assert.equal(box[5], `${dim('│')}      ${url(138)}`)
  })

  test('a long title is cut by what a reader sees as one character, never inside an emoji', () => {
    const family = '👨‍👩‍👧'
    const title = `${'x'.repeat(TITLE_MAX - 2)}${family}${family}${family}`
    const info = new Map([[k(8), { title, url: url(8) }]])
    assert.ok(footer(show(['#8 here\n']), info, HOME).includes(`${'x'.repeat(TITLE_MAX - 2)}${family}…`))
  })

  test('a long title is cut', () => {
    const info = new Map([[k(7), { title: 'x'.repeat(TITLE_MAX + 20), url: url(7) }]])
    const box = footer(show(['#7 here\n']), info, HOME)
    assert.ok(box.includes(`${'x'.repeat(TITLE_MAX - 1)}…`))
    assert.ok(!box.includes('x'.repeat(TITLE_MAX + 1)))
  })

  test('no box when the message cites nothing found', () => {
    const m = show(['Nothing here, and #999.\n'])
    assert.equal(footer(m, known, HOME), '')
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
    const box = footer(m, other, HOME).split('\n')
    assert.equal(box[2], `${dim('│')} #65        ${dim('Home sixty-five')}`)
    assert.equal(box[4], `${dim('│')} x/pelion#3 ${dim('Pelion three')}`)
  })
})

describe('what lntt gave, checked again before it is shown', () => {
  test('control characters in a title are dropped, so it cannot write to the terminal', () => {
    assert.deepEqual(entry('ok\u001b]0;pwned\u0007 title', url(6)), { title: 'ok]0;pwned title', url: url(6) })
  })

  test('a title of control characters only, or a URL that is not plain https, gives nothing', () => {
    assert.equal(entry('\u001b\u0007', url(6)), null)
    assert.equal(entry('ok', 'http://x.org/1'), null)
    assert.equal(entry('ok', 'https://x.org/1\u001b[2m'), null)
    assert.equal(entry('ok', 'https://x.org/a‮b'), null)
    assert.equal(entry('ok', undefined), null)
  })
})
