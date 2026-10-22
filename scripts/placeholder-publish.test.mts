import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)))

let root: string
afterEach(() => rmSync(root, { recursive: true, force: true }))

/**
 * A repo with the given published packages, and a fake `npm` first on PATH: `view`
 * answers from `onNpm` (a version, or E404), `publish` is logged to `npm.log`.
 */
function repo(names: string[], onNpm: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'lntt-placeholder-'))
  mkdirSync(join(root, 'scripts'))
  cpSync(join(SCRIPTS, 'packages-version.mts'), join(root, 'scripts', 'packages-version.mts'))
  cpSync(join(SCRIPTS, 'placeholder-publish.mts'), join(root, 'scripts', 'placeholder-publish.mts'))
  for (const name of names) {
    const dir = join(root, 'packages', name.replace('@lntt/', ''))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, version: '1.2.0' }, null, 2)}\n`)
  }
  mkdirSync(join(root, 'bin'))
  const cases = Object.entries(onNpm).map(([n, v]) => `    ${n}) echo ${v}; exit 0;;`)
  writeFileSync(
    join(root, 'bin', 'npm'),
    `#!/bin/sh
if [ "$1" = view ]; then
  case "$2" in
${cases.join('\n')}
    *) echo "npm error code E404" >&2; exit 1;;
  esac
fi
if [ "$1" = publish ]; then
  echo "$(basename "$PWD") $(grep '"version"' package.json)" >> "${root}/npm.log"
fi
`,
  )
  chmodSync(join(root, 'bin', 'npm'), 0o755)
  return root
}

function run(args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['scripts/placeholder-publish.mts', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`, ...env },
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

const published = () => {
  try {
    return readFileSync(join(root, 'npm.log'), 'utf8')
  } catch {
    return ''
  }
}
const manifest = (pkg: string) => readFileSync(join(root, 'packages', pkg, 'package.json'), 'utf8')

test('dry run names the packages npm lacks, skips the ones it has, and writes nothing', () => {
  repo(['@lntt/a', '@lntt/b'], { '@lntt/a': '0.0.0-stage' })
  const r = run(['--dry-run'])
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /@lntt\/a is already on npm \(0\.0\.0-stage\): skipped/)
  assert.match(r.out, /@lntt\/b: would publish 0\.0\.0/)
  assert.match(manifest('b'), /"version": "1\.2\.0"/)
  assert.equal(published(), '')
})

test('a registry error that is not a 404 stops the run', () => {
  repo(['@lntt/a'], {})
  writeFileSync(join(root, 'bin', 'npm'), '#!/bin/sh\necho "npm error code ENOTFOUND" >&2\nexit 1\n')
  const r = run(['--dry-run'])
  assert.equal(r.status, 1)
  assert.match(r.out, /cannot ask npm for @lntt\/a/)
})

test('without a terminal the real run refuses before touching npm', () => {
  repo(['@lntt/a'], {})
  const r = run()
  assert.equal(r.status, 1)
  assert.match(r.out, /2FA/)
  assert.equal(published(), '')
  assert.match(manifest('a'), /"version": "1\.2\.0"/)
})

test('an unknown argument is a usage error', () => {
  repo(['@lntt/a'], {})
  const r = run(['--now'])
  assert.equal(r.status, 1)
  assert.match(r.out, /usage/)
})

const NO_TTY = { LNTT_PLACEHOLDER_NO_TTY: '1' }

test('the real run publishes 0.0.0 from the directory of each missing package only, and restores package.json', () => {
  repo(['@lntt/a', '@lntt/b', '@lntt/c'], { '@lntt/b': '0.0.0-stage' })
  const r = run([], NO_TTY)
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(
    published()
      .trim()
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ')),
    ['a "version": "0.0.0"', 'c "version": "0.0.0"'],
  )
  for (const pkg of ['a', 'b', 'c']) assert.match(manifest(pkg), /"version": "1\.2\.0"/)
  assert.match(r.out, /2 placeholders published/)
})

test('a failed publish stops the run and still restores package.json', () => {
  repo(['@lntt/a', '@lntt/b'], {})
  writeFileSync(
    join(root, 'bin', 'npm'),
    `#!/bin/sh
[ "$1" = view ] && { echo "npm error code E404" >&2; exit 1; }
echo "$(basename "$PWD")" >> "${root}/npm.log"
exit 1
`,
  )
  const r = run([], NO_TTY)
  assert.equal(r.status, 1)
  assert.match(r.out, /npm publish failed for @lntt\/a/)
  assert.equal(published().trim(), 'a')
  assert.match(manifest('a'), /"version": "1\.2\.0"/)
})

test('a manifest without a version is refused before anything is published', () => {
  repo(['@lntt/a'], {})
  writeFileSync(join(root, 'packages', 'a', 'package.json'), '{ "name": "@lntt/a" }\n')
  const r = run([], NO_TTY)
  assert.equal(r.status, 1)
  assert.match(r.out, /no "version" field/)
  assert.equal(published(), '')
})

test('a package list that cannot be read stops the run', () => {
  repo(['@lntt/a'], {})
  rmSync(join(root, 'scripts', 'packages-version.mts'))
  const r = run(['--dry-run'])
  assert.equal(r.status, 1)
  assert.match(r.out, /cannot list the packages/)
})

test('a missing npm is a message, not a stack trace', () => {
  repo(['@lntt/a'], {})
  rmSync(join(root, 'bin', 'npm'))
  const r = run(['--dry-run'], { PATH: join(root, 'bin') })
  assert.equal(r.status, 1)
  assert.match(r.out, /cannot ask npm for @lntt\/a/)
  assert.doesNotMatch(r.out, /TypeError/)
})
