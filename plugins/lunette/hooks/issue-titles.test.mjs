import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { annotate, entry, footer, label, message, refsIn, TITLE_MAX } from './issue-titles.mjs'

const dim = (text) => `\u001b[2m${text}\u001b[22m`
const HOME = 'o/r'
const url = (n, repo = HOME) => `https://github.com/${repo}/issues/${n}`
const k = (n, repo = HOME) => `${repo}#${n}`
const known = new Map([
  [k(138), { title: 'Publish @lntt/lntt with the other @lntt packages', url: url(138) }],
  [k(134), { title: 'lntt review stops at delivery.review.maxRounds', url: url(134) }],
])
const show = (deltas, info = known, home = HOME) => {
  const m = message()
  return { lines: deltas.map((d) => annotate(d, m, info, home)), m }
}

describe('the numbers a message cites', () => {
  test('each #N outside code, once per message', () => {
    assert.deepEqual(refsIn('do #138, then #134 and #138 again\n', message(), HOME), [k(138), k(134)])
  })

  test('#0 is not a reference: GitHub numbers from 1', () => {
    assert.deepEqual(refsIn('#0 and #01 and #10\n', message(), HOME), [k(10)])
  })

  test('not inside a code span, a fence, a URL or an HTML entity', () => {
    const text = 'see `#12` and https://x.org/issues/9#13 and &#39;\n```\n#14\n```\n'
    assert.deepEqual(refsIn(text, message(), HOME), [])
  })

  test('a number cited in an earlier delta of the message is not asked again', () => {
    const m = message()
    annotate('first #138\n', m, known, HOME)
    assert.deepEqual(refsIn('again #138 and #134\n', m, HOME), [k(134)])
  })
})

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

  test('each message starts over: a title shown in another message does not count', () => {
    const a = show(['#138 first.\n']).lines[0]
    const b = show(['#138 again.\n']).lines[0]
    assert.match(a, /Publish @lntt/)
    assert.match(b, /Publish @lntt/)
  })

  test('a fence opened in one delta keeps the next delta as code', () => {
    const { lines } = show(['```sh\n', 'gh issue view #138\n```\n', 'Now #134.\n'])
    assert.equal(lines[1], 'gh issue view #138\n```\n')
    assert.equal(lines[2], `Now #134 ${dim(`· ${known.get(k(134)).title}`)}.\n`)
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

describe('references to other repositories', () => {
  const other = new Map([
    [k(94, 'o/starter'), { title: 'Local routes on one Caddy', url: url(94, 'o/starter') }],
    [k(3, 'x/pelion'), { title: 'Pelion three', url: url(3, 'x/pelion') }],
    [k(65), { title: 'Home sixty-five', url: url(65) }],
  ])

  test('owner/repo#N is that repository; repo#N is the same owner', () => {
    assert.deepEqual(refsIn('see x/pelion#3, starter#94 and #65\n', message(), HOME), [k(3, 'x/pelion'), k(94, 'o/starter')])
  })

  test('after a reference to another repository, a bare #N is left as it is: it may mean either', () => {
    const { lines, m } = show(['#65 first, then x/pelion#3, then #65 and #7 again.\n'], other)
    assert.match(lines[0], /^#65 .*Home sixty-five.*x\/pelion#3 .*Pelion three.*then #65 and #7 again\.\n$/)
    assert.deepEqual(m.cited, [k(65), k(3, 'x/pelion')])
  })

  test('a reference to the session repository written in full does not make the message foreign', () => {
    assert.deepEqual(refsIn('o/r#7 then #8\n', message(), HOME), [k(7), k(8)])
  })

  test('without the session repository, only owner/repo#N is read', () => {
    assert.deepEqual(refsIn('#5, r#6 and o/r#7\n', message(), null), [k(7)])
  })

  test('the box labels each reference as short as stays clear', () => {
    assert.equal(label(k(4), HOME), '#4')
    assert.equal(label(k(4, 'o/starter'), HOME), 'starter#4')
    assert.equal(label(k(4, 'x/pelion'), HOME), 'x/pelion#4')
    const { m } = show(['#65 and x/pelion#3\n'], other)
    const box = footer(m, other, HOME).split('\n')
    assert.equal(box[2], `${dim('│')} #65        ${dim('Home sixty-five')}`)
    assert.equal(box[4], `${dim('│')} x/pelion#3 ${dim('Pelion three')}`)
  })
})

describe('what is not a reference to another repository', () => {
  test('a word that cannot be a repository makes no reference: C#5, issue#4, v1.2#3', () => {
    assert.deepEqual(refsIn('C#5, F#1, issue#4, PR#2, v1.2#3 and #7\n', message(), HOME), [k(7)])
  })

  test('. and .. are never a name', () => {
    assert.deepEqual(refsIn('x/..#5 and ../r#6 then #7\n', message(), HOME), [k(7)])
  })

  test('names are not case-sensitive: O/R#7 is the session repository, Starter#9 the same owner', () => {
    assert.deepEqual(refsIn('O/R#7, Starter#9\n', message(), HOME), [k(7), k(9, 'o/starter')])
  })

  test('a reference to the session repository written in full leaves the next #N titled', () => {
    const info = new Map([[k(8), { title: 'Eight', url: url(8) }]])
    const [line] = show(['o/r#7 then #8\n'], info).lines
    assert.equal(line, `o/r#7 then #8 ${dim('· Eight')}\n`)
  })

  test('before the session repository is known, any reference makes the message foreign', () => {
    const m = message()
    annotate('see x/pelion#3\n', m, new Map(), null)
    assert.equal(m.foreign, true)
    assert.deepEqual(refsIn('then #8\n', m, HOME), [])
  })
})

describe('references in Markdown links', () => {
  test('a reference just before a link keeps its title beside it', () => {
    const [line] = show(['#138[a](u) end\n']).lines
    assert.equal(line, `#138 ${dim(`· ${known.get(k(138)).title}`)}[a](u) end\n`)
  })

  test('a link whose text holds code is still found', () => {
    const [line] = show(['[`x` #138](https://x.org/1) end\n']).lines
    assert.equal(line, `[\`x\` #138](https://x.org/1) ${dim(`· ${known.get(k(138)).title}`)} end\n`)
  })

  test('the title goes after the link, not inside its text', () => {
    const [line] = show(['see [#138](https://github.com/o/r/pull/138) now\n']).lines
    assert.equal(line, `see [#138](https://github.com/o/r/pull/138) ${dim(`· ${known.get(k(138)).title}`)} now\n`)
  })

  test("a link's URL is not read for references", () => {
    assert.deepEqual(refsIn('[here](https://x.org/a#134) and [docs](https://x.org/b/#138)\n', message(), HOME), [])
  })
})
