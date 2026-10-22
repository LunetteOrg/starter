import { describe, expect, it } from 'vitest'
import { probeProject } from './probe-kit.ts'
import { assertWaitingWorkspacesRunTheGuard, assertWaitsDeclareTimeout, findWaits } from './waits.ts'

const pkg = '{ "name": "x" }'

function untimed(source: string) {
  return findWaits(source, 'tsx').filter((wait) => !wait.timed)
}

describe('findWaits', () => {
  it.each([
    `await screen.findByText('x')`,
    `await screen.findByRole('button', { name: 'Send' })`,
    `await findAllByTestId('row')`,
    `await within(list).findByLabelText('Name', undefined, { timeout: 5_000 })`,
    `await waitFor(() => expect(spy).toHaveBeenCalled())`,
    `await waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 5_000 })`,
    `await vi.waitFor(() => expect(spy).toHaveBeenCalled())`,
    `await waitForElementToBeRemoved(() => screen.queryByText('x'))`,
    `await canvas.findByText('x', {}, OTHER)`,
    `const view = <List onLoad={() => waitFor(check)} />`,
  ])('catches %s', (line) => {
    expect(untimed(line)).toHaveLength(1)
  })

  it.each([
    `await screen.findByText('x', undefined, WAIT)`,
    `await screen.findByRole('button', { name: 'Send' }, WAIT)`,
    `await waitFor(() => expect(spy).toHaveBeenCalled(), WAIT)`,
    `await vi.waitFor(() => expect(spy).toHaveBeenCalled(), WAIT)`,
    `await waitForElementToBeRemoved(() => screen.queryByText('x'), WAIT)`,
    `await repo.findById(id)`,
    `await authorRepo.findBySlug('home')`,
    `screen.getByText('x')`,
    `const code = "screen.findByText('x')"`,
    `// await screen.findByText('x')`,
    // Playwright's locator.waitFor(options?) is no testing-library wait.
    `await page.getByRole('button').waitFor({ state: 'visible' })`,
    `await dialog.waitFor()`,
  ])('lets %s through', (line) => {
    expect(untimed(line)).toEqual([])
  })

  it('reports the line of the call, timed or not', () => {
    expect(
      findWaits(`const WAIT = { timeout: 5_000 }\n\nawait screen.findByText('x')\nawait waitFor(f, WAIT)`, 'ts'),
    ).toEqual([
      { line: 3, call: 'findByText', timed: false },
      { line: 4, call: 'waitFor', timed: true },
    ])
  })

  it('parses TypeScript without JSX in a .ts file', () => {
    expect(findWaits('const n = <number>(x as unknown)\nawait screen.findByText(String(n))', 'ts')).toHaveLength(1)
  })
})

describe('assertWaitsDeclareTimeout', () => {
  it('fails naming each untimed wait, in specs, stories, kits and test/ helpers, not in e2e', () => {
    const workspace = probeProject({
      'app/page.spec.tsx': `await screen.findByText('x', undefined, WAIT)\nawait screen.findByText('y')`,
      'app/page.stories.tsx': `export const play = () => waitFor(check)`,
      'app/gate-kit.tsx': `export const shown = () => screen.findByRole('dialog')`,
      'test/render.ts': `export const shown = () => screen.findByText('x')`,
      'e2e/login.spec.ts': `await waitFor(check)`,
      'app/page.tsx': `await waitFor(check)`,
    })
    let message = ''
    try {
      assertWaitsDeclareTimeout(workspace, 'apps/web')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message.match(/apps\/web\/\S+:\d+ \w+/g)).toEqual([
      'apps/web/app/gate-kit.tsx:1 findByRole',
      'apps/web/app/page.spec.tsx:2 findByText',
      'apps/web/app/page.stories.tsx:1 waitFor',
      'apps/web/test/render.ts:1 findByText',
    ])
    expect(message).toMatch(/const WAIT = \{ timeout: 5_000 \}[\s\S]*docs\/adr\/test-guards\.md/)
  })

  it('passes a workspace whose every wait passes WAIT', () => {
    const workspace = probeProject({
      'app/page.spec.tsx': `const WAIT = { timeout: 5_000 }\nawait screen.findByText('x', undefined, WAIT)`,
    })
    expect(() => assertWaitsDeclareTimeout(workspace)).not.toThrow()
  })

  it('fails when it finds no test file, rather than pass on nothing', () => {
    expect(() => assertWaitsDeclareTimeout(probeProject({ 'app/page.tsx': '' }))).toThrow(/no test file/)
  })

  it('skips the paths it is told to ignore, relative to the workspace', () => {
    const workspace = probeProject({
      'app/page.spec.tsx': `await screen.findByText('x', undefined, WAIT)`,
      'test/fixtures/broken.ts': 'const = (',
      'test/fixtures/untimed.ts': `await waitFor(check)`,
    })
    expect(() => assertWaitsDeclareTimeout(workspace, 'apps/web')).toThrow(/test\/fixtures/)
    expect(() => assertWaitsDeclareTimeout(workspace, 'apps/web', { ignore: ['test/fixtures/**'] })).not.toThrow()
  })

  it('names the file it cannot parse', () => {
    expect(() => assertWaitsDeclareTimeout(probeProject({ 'app/broken.spec.ts': 'const = (' }))).toThrow(
      /app\/broken\.spec\.ts/,
    )
  })
})

describe('assertWaitingWorkspacesRunTheGuard', () => {
  const guard = `import { assertWaitsDeclareTimeout } from '@lntt/test-utils/waits'\nit('waits declare their timeout', () => {\n  assertWaitsDeclareTimeout(WORKSPACE)\n})\n`

  it('fails naming a workspace that waits without a guard calling assertWaitsDeclareTimeout', () => {
    const root = probeProject({
      'apps/web/package.json': pkg,
      'apps/web/app/page.spec.tsx': `await screen.findByText('x', undefined, WAIT)`,
      'apps/web/app/waits.spec.ts': guard,
      'packages/ui/package.json': pkg,
      'packages/ui/test/render.ts': `export const shown = () => screen.findByText('x', undefined, WAIT)`,
      // Naming the guard in a comment, or calling it from a helper no test runs, does not arm it.
      'packages/ui/test/guard-kit.ts': guard,
      'packages/ui/src/waits.spec.ts': `// assertWaitsDeclareTimeout(WORKSPACE)\nit('x', () => {})\n`,
      'packages/std/package.json': pkg,
      'packages/std/src/sum.spec.ts': `it('adds', () => expect(1 + 1).toBe(2))`,
    })
    expect(() => assertWaitingWorkspacesRunTheGuard(root)).toThrow(
      /packages\/ui \(test\/render\.ts\)[\s\S]*test-guards\.md/,
    )
    expect(() => assertWaitingWorkspacesRunTheGuard(root)).not.toThrow(/apps\/web|packages\/std/)
  })

  it('counts a guard call that follows a regex literal holding a quote', () => {
    const root = probeProject({
      'apps/web/package.json': pkg,
      'apps/web/app/page.spec.tsx': `await screen.findByText('x', undefined, WAIT)`,
      'apps/web/app/waits.spec.ts': `const r = /'/\nassertWaitsDeclareTimeout(WORKSPACE)\n`,
    })
    expect(() => assertWaitingWorkspacesRunTheGuard(root)).not.toThrow()
  })

  it('passes when every waiting workspace runs the guard', () => {
    const root = probeProject({
      'apps/web/package.json': pkg,
      'apps/web/app/page.spec.tsx': `await screen.findByText('x', undefined, WAIT)`,
      'apps/web/app/waits.spec.ts': guard,
    })
    expect(() => assertWaitingWorkspacesRunTheGuard(root)).not.toThrow()
  })

  it('fails when the project has no workspace, rather than pass on nothing', () => {
    expect(() => assertWaitingWorkspacesRunTheGuard(probeProject({ 'README.md': '' }))).toThrow(/no workspace/)
  })
})
