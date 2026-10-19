import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { annotate, entry, footer, message, refsIn, TITLE_MAX } from './issue-titles.mjs'

const dim = (text) => `\u001b[2m${text}\u001b[22m`
const url = (n) => `https://github.com/o/r/issues/${n}`
const known = new Map([
  [138, { title: 'Publish @lntt/lntt with the other @lntt packages', url: url(138) }],
  [134, { title: 'lntt review stops at delivery.review.maxRounds', url: url(134) }],
])
const show = (deltas, info = known) => {
  const m = message()
  return { lines: deltas.map((d) => annotate(d, m, info)), m }
}

describe('the numbers a message cites', () => {
  test('each #N outside code, once per message', () => {
    assert.deepEqual(refsIn('do #138, then #134 and #138 again\n', message()), [138, 134])
  })

  test('#0 is not a reference: GitHub numbers from 1', () => {
    assert.deepEqual(refsIn('#0 and #01 and #10\n', message()), [10])
  })

  test('not inside a code span, a fence, a URL or an HTML entity', () => {
    const text = 'see `#12` and https://x.org/issues/9#13 and &#39;\n```\n#14\n```\n'
    assert.deepEqual(refsIn(text, message()), [])
  })

  test('a number cited in an earlier delta of the message is not asked again', () => {
    const m = message()
    annotate('first #138\n', m, known)
    assert.deepEqual(refsIn('again #138 and #134\n', m), [134])
  })
})

describe('the title beside the number', () => {
  test('the first #N of a message gets its title, dimmed', () => {
    const { lines } = show(['Start with #138, then #138 again.\n'])
    assert.deepEqual(lines, [`Start with #138 ${dim(`· ${known.get(138).title}`)}, then #138 again.\n`])
  })

  test('a number whose title the message already gives is left as it is', () => {
    const line = '#134, "lntt review stops at delivery.review.maxRounds and hands what is open", first.\n'
    assert.deepEqual(show([line]).lines, [line])
  })

  test('a title given in an earlier line of the same message counts', () => {
    const { lines } = show(['"Publish @lntt/lntt with the other @lntt packages" is first.\n', 'So #138 goes first.\n'])
    assert.equal(lines[1], 'So #138 goes first.\n')
  })

  test('each message starts over: a title shown in another message does not count', () => {
    const a = show(['#138 first.\n']).lines[0]
    const b = show(['#138 again.\n']).lines[0]
    assert.match(a, /Publish @lntt/)
    assert.match(b, /Publish @lntt/)
  })

  test('a fence opened in one delta keeps the next delta as code', () => {
    const { lines } = show(['```sh\n', 'gh issue view #138\n```\n', 'Now #134.\n'])
    assert.equal(lines[1], 'gh issue view #138\n```\n')
    assert.equal(lines[2], `Now #134 ${dim(`· ${known.get(134).title}`)}.\n`)
  })

  test('a long title is cut by what a reader sees as one character, never inside an emoji', () => {
    const family = '👨‍👩‍👧'
    const title = `${'x'.repeat(TITLE_MAX - 2)}${family}${family}${family}`
    const { lines } = show(['#8 here\n'], new Map([[8, { title, url: url(8) }]]))
    assert.ok(lines[0].includes(`${'x'.repeat(TITLE_MAX - 2)}${family}…`))
  })

  test('a long title is cut', () => {
    const long = 'x'.repeat(TITLE_MAX + 20)
    const { lines } = show(['#7 here\n'], new Map([[7, { title: long, url: url(7) }]]))
    assert.ok(lines[0].includes(`${'x'.repeat(TITLE_MAX - 1)}…`))
    assert.ok(!lines[0].includes('x'.repeat(TITLE_MAX + 1)))
  })

  test('two numbers on one line each get their title, in place', () => {
    const { lines } = show(['#138 and #134.\n'])
    assert.equal(lines[0], `#138 ${dim(`· ${known.get(138).title}`)} and #134 ${dim(`· ${known.get(134).title}`)}.\n`)
  })

  test('a short title: given in the message it is left alone, not given it is shown', () => {
    const short = new Map([[5, { title: 'Fix CI', url: url(5) }]])
    assert.equal(show(['#5, "Fix CI", first.\n'], short).lines[0], '#5, "Fix CI", first.\n')
    assert.equal(show(['#5 first.\n'], short).lines[0], `#5 ${dim('· Fix CI')} first.\n`)
  })

  test('a title given in the message is matched once cleaned of control characters', () => {
    const info = new Map([[6, entry('Fix\u0007 the CI', url(6))]])
    assert.equal(show(['#6, "Fix the CI", first.\n'], info).lines[0], '#6, "Fix the CI", first.\n')
  })

  test('a number with no title found is left as it is', () => {
    assert.deepEqual(show(['#999 is unknown.\n']).lines, ['#999 is unknown.\n'])
  })
})

describe('the box of what the message cited', () => {
  test('every number found, in the order cited, its title dimmed and its URL plain', () => {
    const { m } = show(['#134, "lntt review stops at delivery.review.maxRounds", then #138.\n', 'And #999.\n'])
    const box = footer(m, known)
    assert.equal(
      box,
      [
        '',
        dim('╭─ cited'),
        `${dim('│')} #134 ${dim(known.get(134).title)}`,
        `${dim('│')}      ${url(134)}`,
        `${dim('│')} #138 ${dim(known.get(138).title)}`,
        `${dim('│')}      ${url(138)}`,
        dim('╰─'),
      ].join('\n'),
    )
  })

  test('titles and URLs line up under the widest number', () => {
    const info = new Map([...known, [7, { title: 'Seven', url: url(7) }]])
    const { m } = show(['#7 then #138.\n'], info)
    const box = footer(m, info).split('\n')
    assert.equal(box[2], `${dim('│')} #7   ${dim('Seven')}`)
    assert.equal(box[3], `${dim('│')}      ${url(7)}`)
    assert.equal(box[5], `${dim('│')}      ${url(138)}`)
  })

  test('no box when the message cites nothing found', () => {
    const { m } = show(['Nothing here, and #999.\n'])
    assert.equal(footer(m, known), '')
  })
})

describe('what a lookup gave, made safe to show', () => {
  test('control characters in a title are dropped, so it cannot write to the terminal', () => {
    assert.deepEqual(entry('ok\u001b]0;pwned\u0007 title', url(6)), { title: 'ok]0;pwned title', url: url(6) })
  })

  test('characters that reorder or hide text are dropped too, at both ends of each range', () => {
    const hidden = [0x0, 0x1f, 0x7f, 0x9f, 0xad, 0x34f, 0x200b, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2066,
      0x2069, 0xfe00, 0xfe0f, 0xfeff, 0xe0001, 0xe0041, 0xe007f, 0xe0100, 0xe01ef]
    for (const cp of hidden) {
      assert.deepEqual(entry(`a${String.fromCodePoint(cp)}b`, url(6)), { title: 'ab', url: url(6) }, cp.toString(16))
      assert.equal(entry('ok', `https://x.org/1${String.fromCodePoint(cp)}`), null, cp.toString(16))
    }
    for (const cp of [0x20, 0xa0, 0x200a, 0x2030, 0xfdff, 0xfe10, 0xe0200]) {
      assert.equal(entry(`a${String.fromCodePoint(cp)}b`, url(6))?.title, `a${String.fromCodePoint(cp)}b`, cp.toString(16))
    }
  })

  test('a title of control characters only, or a URL that is not plain https, gives nothing', () => {
    assert.equal(entry('\u001b\u0007', url(6)), null)
    assert.equal(entry('ok', 'http://x.org/1'), null)
    assert.equal(entry('ok', 'https://x.org/1\u001b[2m'), null)
    assert.equal(entry('ok', 'https://x.org/a b'), null)
    assert.equal(entry('ok', undefined), null)
  })
})
