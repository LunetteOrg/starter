import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/index.ts')

// A scaffolded project must be green on its OWN toolchain, not merely
// structurally correct. This installs a generated project and runs its lint +
// typecheck, so a template-tooling regression — a malformed grit plugin, a broken
// Biome override, a type error in a shipped package, an `@starter` reference a
// rename misses — fails HERE rather than only in a scaffolded project's CI after
// push (the exact class the residue/structure checks don't cover).
//
// Installing the full template takes minutes, so it is gated behind
// SCAFFOLD_SMOKE=1 (set by CI) to keep the default `pnpm test` fast for local runs.
test('scaffolded project installs, lints and typechecks clean', {
  skip: process.env.SCAFFOLD_SMOKE ? false : 'set SCAFFOLD_SMOKE=1 to run (installs the full template)',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'lntt-smoke-'))
  const app = join(root, 'smoke-app')
  // Any non-zero exit throws → the test fails with the tool's own output.
  const run = (cmd: string, args: string[], cwd: string): void =>
    void execFileSync(cmd, args, { cwd, stdio: 'inherit' })
  try {
    run('node', [BIN, 'smoke-app', '--template', 'react-router'], root)
    // `--ignore-scripts`: skip lifecycle scripts (lefthook install, only-allow) —
    // hermetic and faster; lint/typecheck need none of them.
    run('pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts'], app)
    run('pnpm', ['lint'], app)
    run('pnpm', ['typecheck'], app)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
