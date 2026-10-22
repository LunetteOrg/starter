// Reserve the npm name of each published package that is not on npm yet, so its
// trusted publisher can be configured (docs/process/delivery.md, "A new package").
//
//   node scripts/placeholder-publish.mts --dry-run   print what would be published
//   node scripts/placeholder-publish.mts             publish a 0.0.0 placeholder of each
//
// A package that npm already has, at any version, is skipped: a `0.0.0-stage`
// placeholder left by an `npm publish` that failed with EOTP counts, and is enough to
// configure the trusted publisher. `package.json` is restored after every publish.
// The publish asks for 2FA in the browser, so it needs a terminal a person can answer:
// run it there, not from an agent's shell. Run from the repository root.
//
// LNTT_PLACEHOLDER_NO_TTY=1 lifts the terminal check; the tests set it.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PLACEHOLDER = '0.0.0'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
if (args.some((a) => a !== '--dry-run')) fail('usage: placeholder-publish.mts [--dry-run]')
if (!dryRun && process.env.LNTT_PLACEHOLDER_NO_TTY !== '1' && !(process.stdin.isTTY && process.stdout.isTTY)) {
  fail('npm asks for 2FA through a browser prompt: run this in a terminal a person can answer, or with --dry-run')
}

// Ctrl-C reaches this process as well as npm: stop npm and put the manifest back.
let restore: (() => void) | undefined
let running: ChildProcess | undefined
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    running?.kill()
    restore?.()
    process.exit(130)
  })
}

const listed = spawnSync(process.execPath, ['scripts/packages-version.mts', 'list'], { encoding: 'utf8' })
if (listed.status !== 0) fail(`cannot list the packages:\n${listed.stderr}`)

// Everything that can refuse is checked before the first publish, so a run does not
// stop half-way through the batch for a reason known at the start.
const missing: { name: string; dir: string; file: string; original: string; placeholder: string }[] = []
for (const dir of listed.stdout.split('\n').filter(Boolean)) {
  const file = join(dir, 'package.json')
  const original = readFileSync(file, 'utf8')
  const name: string = JSON.parse(original).name

  const view = spawnSync('npm', ['view', name, 'version'], { encoding: 'utf8' })
  if (view.status === 0) {
    console.log(`${name} is already on npm (${view.stdout.trim()}): skipped`)
    continue
  }
  // Only a missing package is published; a registry or network error stops the run.
  if (!view.stderr?.includes('E404')) fail(`cannot ask npm for ${name}:\n${view.error?.message ?? view.stderr}`)

  const placeholder = original.replace(/("version":\s*)"[^"]*"/, `$1"${PLACEHOLDER}"`)
  if (JSON.parse(placeholder).version !== PLACEHOLDER) fail(`${file}: cannot set the top-level "version" field`)
  missing.push({ name, dir, file, original, placeholder })
}

let published = 0
for (const { name, dir, file, original, placeholder } of missing) {
  if (dryRun) {
    console.log(`${name}: would publish ${PLACEHOLDER} from ${dir}`)
    continue
  }
  console.log(`${name}: publishing ${PLACEHOLDER} from ${dir}`)
  writeFileSync(file, placeholder)
  restore = () => writeFileSync(file, original)
  let outcome: string
  try {
    outcome = await new Promise<string>((done) => {
      running = spawn('npm', ['publish', '--access', 'public'], { cwd: dir, stdio: 'inherit' })
      running.on('error', (e) => done(e.message))
      running.on('close', (code) => done(code === 0 ? '' : `exit ${code}`))
    })
  } finally {
    restore()
    restore = undefined
    running = undefined
  }
  if (outcome) fail(`npm publish failed for ${name} (${outcome}); package.json restored`)
  published++
}
console.log(dryRun ? 'dry run: nothing published' : `${published} placeholders published`)
