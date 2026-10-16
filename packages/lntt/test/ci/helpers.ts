import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

export function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

// A repository with `files` committed on main, and a branch `feat/x` checked out
// that adds `changed` on top.
export function repo(files: Record<string, string>, changed: Record<string, string> = { 'src/a.ts': 'x\n' }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-ci-')))
  write(root, files)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(root, 'switch', '-q', '-c', 'feat/x')
  write(root, changed)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'change')
  return root
}
