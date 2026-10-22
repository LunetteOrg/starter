import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { annotate, entry, footer, label, message, TITLE_MAX } from './issue-titles.mjs'

const dim = (text) => `\u001b[2m${text}\u001b[22m`
const HOME = 'o/r'
const url = (n, repo = HOME) => `https://github.com/${repo}/issues/${n}`
const k = (n, repo = HOME) => `${repo}#${n}`
const known = new Map([
  [k(138), { title: 'Publish @lntt/lntt with the other @lntt packages', url: url(138) }],
  [k(134), { title: 'lntt review stops at delivery.review.maxRounds', url: url(134) }],
])
// The mentions `lntt refs` gives for a text, for these tests: `#N` and `owner/repo#N`,
// a title right after each. Which numbers are references is lntt's, tested there.
const find = (text) =>
  [...text.matchAll(/(?:([a-z]+\/[a-z]+))?#([1-9]\d*)/g)].map((x) => ({
    text: x[0],
    ref: `${x[1] ?? HOME}#${x[2]}`,
    index: x.index,
    after: x.index + x[0].length,
  }))
// Each delta annotated with the mentions of the message so far, as the hook does; the
// last one is final when `final` says so.
const show = (deltas, info = known, final = false) => {
  const m = message()
  return { lines: deltas.map((d, i) => annotate(d, m, find(m.text + d), info, final && i === deltas.length - 1)), m }
}

describe('the title beside the number', () => {
  test('the first #N of a message gets its title, dimmed', () => {
    const { lines } = show(['Start with #138, then #138 again.\n'])
    assert.deepEqual(lines, [`Start with #138 ${dim(`· ${known.get(k(138)).title}`)}, then #138 again.\n`])
  })

  test('a number whose title the message already gives is left as it is', () => {
    const line = '#134, "lntt review stops at delivery.review.maxRounds and hands what is open", first.\n'
    assert.deepEqual(show([line]).lines, [line])
  })

  test('a title given in an earlier line of the same message counts', () => {
    const { lines } = show(['"Publish @lntt/lntt with the other @lntt packages" is first.\n', 'So #138 goes first.\n'])
    assert.equal(lines[1], 'So #138 goes first.\n')
  })

  test('a number cited in an earlier delta gets no title again, and the next delta is placed in its own text', () => {
    const { lines, m } = show(['first #138\n', 'again #138 and #134\n'])
    assert.equal(lines[1], `again #138 and #134 ${dim(`· ${known.get(k(134)).title}`)}\n`)
    assert.deepEqual(m.cited, [k(138), k(134)])
  })

  test('each message starts over: a title shown in another message does not count', () => {
    const a = show(['#138 first.\n']).lines[0]
    const b = show(['#138 again.\n']).lines[0]
    assert.match(a, /Publish @lntt/)
    assert.match(b, /Publish @lntt/)
  })

  test('the title goes where lntt says, after a link that holds the reference', () => {
    const text = 'see [#138](https://x.org/1) now\n'
    const m = message()
    const at = text.indexOf(' now')
    const line = annotate(text, m, [{ text: '#138', ref: k(138), index: 5, after: at }], known)
    assert.equal(line, `see [#138](https://x.org/1) ${dim(`· ${known.get(k(138)).title}`)} now\n`)
  })

  test('a mention lntt gave that does not fit the text, or has no ref, is skipped', () => {
    const m = message()
    const bad = [
      { ref: k(138), index: 0, after: 99 },
      { ref: k(138), index: 3, after: 1 },
      { ref: null, index: 0, after: 4 },
      { ref: 'nonsense', index: 0, after: 4 },
      { ref: k(138), index: '0', after: 4 },
    ]
    assert.equal(annotate('#138\n', m, bad, known), '#138\n')
    assert.deepEqual(m.cited, [])
  })

  test('a long title is cut by what a reader sees as one character, never inside an emoji', () => {
    const family = '👨‍👩‍👧'
    const title = `${'x'.repeat(TITLE_MAX - 2)}${family}${family}${family}`
    const { lines } = show(['#8 here\n'], new Map([[k(8), { title, url: url(8) }]]))
    assert.ok(lines[0].includes(`${'x'.repeat(TITLE_MAX - 2)}${family}…`))
  })

  test('a long title is cut', () => {
    const long = 'x'.repeat(TITLE_MAX + 20)
    const { lines } = show(['#7 here\n'], new Map([[k(7), { title: long, url: url(7) }]]))
    assert.ok(lines[0].includes(`${'x'.repeat(TITLE_MAX - 1)}…`))
    assert.ok(!lines[0].includes('x'.repeat(TITLE_MAX + 1)))
  })

  test('two numbers on one line each get their title, in place', () => {
    const { lines } = show(['#138 and #134.\n'])
    assert.equal(lines[0], `#138 ${dim(`· ${known.get(k(138)).title}`)} and #134 ${dim(`· ${known.get(k(134)).title}`)}.\n`)
  })

  test('a short title: given in the message it is left alone, not given it is shown', () => {
    const short = new Map([[k(5), { title: 'Fix CI', url: url(5) }]])
    assert.equal(show(['#5, "Fix CI", first.\n'], short).lines[0], '#5, "Fix CI", first.\n')
    assert.equal(show(['#5 first.\n'], short).lines[0], `#5 ${dim('· Fix CI')} first.\n`)
  })

  test('a title given in the message is matched once cleaned of control characters', () => {
    const info = new Map([[k(6), entry('Fix\u0007 the CI', url(6))]])
    assert.equal(show(['#6, "Fix the CI", first.\n'], info).lines[0], '#6, "Fix the CI", first.\n')
  })

  test('a number split across deltas is the one the message cites, its title in the delta where it ends', () => {
    const info = new Map([...known, [k(1), { title: 'One', url: url(1) }]])
    const { lines, m } = show(['See #1', '38 now.', ' end'], info, true)
    assert.deepEqual(lines, ['See #1', `38 ${dim(`· ${known.get(k(138)).title}`)} now.`, ' end'])
    assert.deepEqual(m.cited, [k(138)])
  })

  test('a number at the end of a delta waits for the next one: its title goes at its start', () => {
    const { lines, m } = show(['See #138', ' now.\n'])
    assert.deepEqual(lines, ['See #138', ` ${dim(`· ${known.get(k(138)).title}`)} now.\n`])
    assert.deepEqual(m.cited, [k(138)])
  })

  test('a number at the end of the last delta is cited and gets its title', () => {
    const { lines, m } = show(['See #138'], known, true)
    assert.deepEqual(lines, [`See #138 ${dim(`· ${known.get(k(138)).title}`)}`])
    assert.deepEqual(m.cited, [k(138)])
  })

  test('a ref that is not a lower-case owner/repo#N is ignored: no title, nothing cited', () => {
    const m = message()
    const bad = ['o/r\u001b]0;pwned\u0007#5', 'O/R#5', 'o/.r#5', '-o/r#5', 'o/r#05', 'o/r/x#5']
    const found = bad.map((ref) => ({ ref, index: 0, after: 2 }))
    const info = new Map(bad.map((ref) => [ref, { title: 'T', url: url(5) }]))
    assert.equal(annotate('#5 x\n', m, found, info), '#5 x\n')
    assert.deepEqual(m.cited, [])
  })

  test('a number with no title found is left as it is', () => {
    assert.deepEqual(show(['#999 is unknown.\n']).lines, ['#999 is unknown.\n'])
  })
})

describe('the box of what the message cited', () => {
  test('every number found, in the order cited, its title dimmed and its URL plain', () => {
    const { m } = show(['#134, "lntt review stops at delivery.review.maxRounds", then #138.\n', 'And #999.\n'])
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
    const { m } = show(['#7 then #138.\n'], info)
    const box = footer(m, info, HOME).split('\n')
    assert.equal(box[2], `${dim('│')} #7   ${dim('Seven')}`)
    assert.equal(box[3], `${dim('│')}      ${url(7)}`)
    assert.equal(box[5], `${dim('│')}      ${url(138)}`)
  })

  test('no box when the message cites nothing found', () => {
    const { m } = show(['Nothing here, and #999.\n'])
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
    const { m } = show(['#65 and x/pelion#3\n'], other)
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
