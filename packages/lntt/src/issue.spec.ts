import { assert, describe, it } from '@effect/vitest'
import type { Dump } from './dump.ts'
import { bodyTooLong, ISSUE_SECTIONS, IssueError, issueBody, parseDraft, upstreamRepository } from './issue.ts'

const DRAFT = [
  '# lntt review loses its state when the worktree changes branch',
  '',
  '## What happened',
  'The round started from zero after `git switch`.',
  '',
  '## Pull requests',
  '- acme/app#12',
  '- acme/app#15',
  '',
  '## Proposal',
  'Key the state by worktree, not by branch.',
].join('\n')

const DUMP: Dump = {
  sections: [
    { title: 'lntt', lines: ['version: 0.6.2', 'installed: a dependency of the project'] },
    { title: 'Runtime', lines: ['Node: v24.1.0', 'package manager: pnpm@10.16.1', 'OS: Darwin 27.0.0 arm64'] },
    { title: 'Harness', lines: ['harness: Claude Code 2.3.4', 'model: claude-opus-5-5'] },
  ],
  harness: 'Claude Code 2.3.4',
  model: 'claude-opus-5-5',
  lntt: '0.6.2',
}

describe('the upstream repository', () => {
  it('cycle.retrospective.upstream.repository, with no default: missing, it names the key', () => {
    assert.strictEqual(
      upstreamRepository({ cycle: { retrospective: { upstream: { repository: 'acme/lunette' } } } }),
      'acme/lunette',
    )
    assert.throws(() => upstreamRepository({}), /no cycle\.retrospective\.upstream\.repository in the configuration/)
    assert.throws(() => upstreamRepository({}), IssueError)
  })
})

describe('parseDraft', () => {
  it('the title and the three sections, headings matched ignoring case', () => {
    assert.deepStrictEqual(parseDraft(DRAFT), {
      title: 'lntt review loses its state when the worktree changes branch',
      whatHappened: 'The round started from zero after `git switch`.',
      pullRequests: '- acme/app#12\n- acme/app#15',
      proposal: 'Key the state by worktree, not by branch.',
    })
  })

  it('a missing title or section is named', () => {
    assert.throws(() => parseDraft(DRAFT.replace(/^# .*\n/, '')), /the draft has no title: a first line "# <title>"/)
    assert.throws(
      () => parseDraft(DRAFT.replace('## Proposal\nKey the state by worktree, not by branch.', '')),
      /the draft has no "## Proposal" section/,
    )
    assert.throws(
      () => parseDraft(DRAFT.replace('Key the state by worktree, not by branch.', '')),
      /"## Proposal" is empty/,
    )
  })
})

describe('issueBody', () => {
  it("the template's fields in its order, the whole dump at the end", () => {
    const body = issueBody(parseDraft(DRAFT), DUMP, 'acme-app')
    const headings = [...body.matchAll(/^### (.+)$/gm)].map((m) => m[1])
    assert.deepStrictEqual(headings.slice(0, ISSUE_SECTIONS.length), [...ISSUE_SECTIONS])
    assert.match(body, /^### Project\n\nacme-app\n/)
    assert.match(body, /### Harness\n\nClaude Code 2\.3\.4\n/)
    assert.match(body, /### Model\n\nclaude-opus-5-5\n/)
    assert.match(
      body,
      /### Versions\n\nlntt 0\.6\.2 \(a dependency of the project\), Node v24\.1\.0, pnpm@10\.16\.1, Darwin 27\.0\.0 arm64\n/,
    )
    assert.match(body, /<details><summary>lntt dump<\/summary>\n\n### lntt\n/)
    assert.match(body, /<\/details>\n$/)
  })
})

describe('bodyTooLong', () => {
  it('bodyTooLong counts characters, not UTF-16 units, and checks the title', () => {
    assert.strictEqual(bodyTooLong('t', '😀'.repeat(65536)), null)
    assert.match(bodyTooLong('t', 'x'.repeat(65537)) ?? '', /the body is 65537 characters/)
    assert.match(bodyTooLong('x'.repeat(257), 'b') ?? '', /the title is 257 characters, GitHub takes 256/)
    assert.strictEqual(bodyTooLong('x'.repeat(256), 'b'), null)
    assert.strictEqual(bodyTooLong('😀'.repeat(256), 'b'), null)
  })
})
