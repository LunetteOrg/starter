import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { bandLines, fold, readEvents, SPIN_MS, tokens } from './review-band.mjs'

const T = 1_000_000
const round = (extra = []) => [
  { t: T, type: 'round', pid: 42, round: 4, range: 'a..b', files: 6, optionalGraceMs: 120_000 },
  { t: T + 1, type: 'phase', phase: 'reviewers', total: 4 },
  { t: T + 2, type: 'start', phase: 'reviewers', label: 'decisions · claude sonnet', optional: false },
  { t: T + 3, type: 'start', phase: 'reviewers', label: 'code · claude sonnet', optional: false },
  { t: T + 4, type: 'start', phase: 'reviewers', label: 'code · opencode deepseek', optional: true },
  { t: T + 5, type: 'start', phase: 'reviewers', label: 'tests · claude sonnet', optional: false },
  ...extra,
]
const end = (t, label, outcome = 'done', tokens = 80_000) => ({ t, type: 'end', phase: 'reviewers', label, outcome, tokens })
const text = (lines) => lines?.map((l) => l.text)

describe('the band of a running round', () => {
  test('nothing to show without events', () => {
    assert.equal(bandLines(null, T, null), null)
    assert.equal(fold([]), null)
  })

  test('the round, its phase as a bar with done out of total, the tokens and the time; then what runs', () => {
    const view = fold(round([end(T + 20_000, 'decisions · claude sonnet'), end(T + 25_000, 'tests · claude sonnet')]))
    const [head, running] = bandLines(view, T + 30_000, true)
    assert.match(head.text, /lntt review · round 4 · reviewers ▕█{10}░{10}▏ 2\/4 · 160k tokens · 30s$/)
    assert.equal(head.tone, 'strong')
    assert.equal(running.text, '  running: code · claude sonnet (30s) · code · opencode deepseek (30s)')
  })

  test('the spinner turns with the clock', () => {
    const view = fold(round())
    const a = bandLines(view, T + 10_000, true)[0].text[0]
    const b = bandLines(view, T + 10_000 + SPIN_MS, true)[0].text[0]
    assert.notEqual(a, b)
  })

  test('a failure shows in red', () => {
    const view = fold(round([end(T + 9_000, 'code · claude sonnet', 'failed', null)]))
    assert.deepEqual(bandLines(view, T + 10_000, true)[1], { text: '  1 failed', tone: 'error' })
  })

  test('only optional agents left: the band says it waits on them, and when they stop', () => {
    const view = fold(
      round([
        end(T + 10_000, 'decisions · claude sonnet'),
        end(T + 20_000, 'code · claude sonnet'),
        end(T + 30_000, 'tests · claude sonnet'),
        { t: T + 75_000, type: 'beat', running: 1 },
      ]),
    )
    assert.equal(
      text(bandLines(view, T + 90_000, true))[1],
      '  waiting on optional: code · opencode deepseek (1m30s) · stops in 1m00s',
    )
  })

  test('lntt review gone without the end of its round: stopped, in red, never shown as working', () => {
    assert.deepEqual(bandLines(fold(round()), T + 10_000, false), [
      { text: 'lntt review · round 4 stopped without finishing (process 42 is gone)', tone: 'error' },
    ])
  })

  test('no event for more than 45 seconds: the band says so', () => {
    const lines = text(bandLines(fold(round()), T + 60_000, true))
    assert.ok(lines.includes('  no news from lntt review for 1m00s'))
  })

  test('the end of the round stays a minute, clean in green or with its findings', () => {
    const done = (clean) => fold(round([{ t: T + 70_000, type: 'done', round: 4, findings: clean ? 0 : 3, refuted: 2, failed: 0, skipped: 1, tokens: 2_300_000, clean }]))
    assert.deepEqual(bandLines(done(true), T + 80_000, null), [
      { text: 'lntt review · round 4 done · clean · 2 refuted · 2.3M tokens', tone: 'ok' },
    ])
    assert.equal(bandLines(done(false), T + 80_000, null)[0].text, 'lntt review · round 4 done · 3 findings, 0 failed · 2 refuted · 2.3M tokens')
    assert.equal(bandLines(done(true), T + 70_000 + 61_000, null), null)
  })

  test('a round that could not start says why, for a minute', () => {
    const view = fold([{ t: T, type: 'error', message: 'the working tree has uncommitted changes' }])
    assert.deepEqual(bandLines(view, T + 1000, null), [
      { text: 'lntt review · not started: the working tree has uncommitted changes', tone: 'error' },
    ])
    assert.equal(bandLines(view, T + 61_000, null), null)
  })

  test('a round past delivery.review.maxRounds says it did not start, and that the person decides, for a minute', () => {
    const view = fold([{ t: T, type: 'limit', round: 5, maxRounds: 4, allowed: 0, open: 2 }])
    assert.deepEqual(bandLines(view, T + 10_000, null), [
      { text: 'lntt review · round 5 not started: limit of 4 rounds · 2 open · the person decides', tone: 'strong' },
    ])
    const allowed = fold([{ t: T, type: 'limit', round: 7, maxRounds: 4, allowed: 2, open: 1 }])
    assert.match(bandLines(allowed, T, null)[0].text, /limit of 6 rounds/)
    const failed = fold([{ t: T, type: 'limit', round: 5, maxRounds: 4, allowed: 0, open: 0, failed: 1 }])
    assert.match(bandLines(failed, T, null)[0].text, /· 0 open · 1 failed · the person decides$/)
    assert.equal(bandLines(view, T + 61_000, null), null)
  })

  test('tokens read at a glance', () => {
    assert.deepEqual([tokens(999), tokens(1500), tokens(160_000), tokens(2_300_000)], ['999 tokens', '1.5k tokens', '160k tokens', '2.3M tokens'])
  })

  test('two agents with the same label are two agents: one ending leaves the other running', () => {
    const view = fold([
      ...round(),
      { t: T + 6, type: 'start', phase: 'reviewers', label: 'code · claude sonnet', optional: false },
      end(T + 9_000, 'code · claude sonnet'),
    ])
    assert.match(bandLines(view, T + 10_000, true)[1].text, /code · claude sonnet/)
  })

  test('an error after the round began is a stop, not a round that never started', () => {
    const view = fold(round([{ t: T + 9_000, type: 'error', message: 'interrupted by SIGINT' }]))
    assert.deepEqual(bandLines(view, T + 10_000, null), [{ text: 'lntt review · round 4 stopped: interrupted by SIGINT', tone: 'error' }])
  })

  test('a dead run stays in red for a minute after its last event, then the band clears', () => {
    const view = fold(round())
    assert.equal(bandLines(view, T + 30_000, false)[0].tone, 'error')
    assert.equal(bandLines(view, T + 5 + 61_000, false), null)
  })

  test('an end from the phase before never breaks the bar', () => {
    const view = fold([
      ...round(),
      { t: T + 10, type: 'phase', phase: 'verify', total: 1 },
      end(T + 11, 'decisions · claude sonnet'),
      { t: T + 12, type: 'end', phase: 'verify', label: 'x', outcome: 'done', tokens: 1 },
      { t: T + 13, type: 'end', phase: 'verify', label: 'y', outcome: 'done', tokens: 1 },
    ])
    assert.doesNotThrow(() => bandLines(view, T + 1000, true))
    assert.match(bandLines(view, T + 1000, true)[0].text, /verify ▕█{20}▏/)
  })

  test('numbers a done event leaves out read as zero, and tokens round up to the next unit', () => {
    const view = fold(round([{ t: T + 9, type: 'done', round: 4, clean: true }]))
    assert.equal(bandLines(view, T + 10, null)[0].text, 'lntt review · round 4 done · clean · 0 refuted · 0 tokens')
    assert.equal(tokens(999_700), '1M tokens')
    const unclean = fold(round([{ t: T + 9, type: 'done', round: 4, clean: false }]))
    assert.equal(bandLines(unclean, T + 10, null)[0].text, 'lntt review · round 4 done · 0 findings, 0 failed · 0 refuted · 0 tokens')
  })

  test('the progress file read line by line, a line that is not JSON skipped', () => {
    assert.deepEqual(readEvents('{"type":"round","t":1}\nnot json\n\n{"type":"beat","t":2}\n').map((e) => e.type), ['round', 'beat'])
  })
})
