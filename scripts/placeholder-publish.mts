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
import { spawnSync } from 'node:child_process'
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
if (!dryRun && !(process.stdin.isTTY && process.stdout.isTTY)) {
  fail('npm asks for 2FA through a browser prompt: run this in a terminal a person can answer, or with --dry-run')
}

const listed = spawnSync(process.execPath, ['scripts/packages-version.mts', 'list'], { encoding: 'utf8' })
if (listed.status !== 0) fail(`cannot list the packages:\n${listed.stderr}`)

let published = 0
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
  if (!view.stderr.includes('E404')) fail(`cannot ask npm for ${name}:\n${view.stderr}`)

  if (dryRun) {
    console.log(`${name}: would publish ${PLACEHOLDER} from ${dir}`)
    continue
  }
  console.log(`${name}: publishing ${PLACEHOLDER} from ${dir}`)
  writeFileSync(file, original.replace(/("version":\s*)"[^"]*"/, `$1"${PLACEHOLDER}"`))
  let status: number | null
  try {
    status = spawnSync('npm', ['publish', '--access', 'public'], { cwd: dir, stdio: 'inherit' }).status
  } finally {
    writeFileSync(file, original)
  }
  if (status !== 0) fail(`npm publish failed for ${name} (exit ${status}); package.json restored`)
  published++
}
console.log(dryRun ? 'dry run: nothing published' : `${published} placeholders published`)
