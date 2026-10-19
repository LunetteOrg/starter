import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { annotate, footer, message, refsIn, TITLE_MAX } from './issue-titles.mjs'

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

  test('a long title is cut', () => {
    const long = 'x'.repeat(TITLE_MAX + 20)
    const { lines } = show(['#7 here\n'], new Map([[7, { title: long, url: url(7) }]]))
    assert.ok(lines[0].includes(`${'x'.repeat(TITLE_MAX - 1)}…`))
    assert.ok(!lines[0].includes('x'.repeat(TITLE_MAX + 1)))
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

  test('no box when the message cites nothing found', () => {
    const { m } = show(['Nothing here, and #999.\n'])
    assert.equal(footer(m, known), '')
  })
})
