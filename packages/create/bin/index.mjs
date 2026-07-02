#!/usr/bin/env node
// SPIKE — @lntt/create in the create-vite shape: template VARIANTS are folders
// bundled inside this package under `templates/`. The CLI copies the chosen one.
// No self-exclusion (the CLI's own files aren't mixed with template files), and
// adding a variant = adding a folder. This is the shape that unlocks issue #3
// (multi-template + interactive prompt).
//
// npm strips/renames some dotfiles in published tarballs, so templates store them
// with a leading `_` (`_gitignore`, `_npmrc`, `_env`) and we restore them here.

import { execSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { argv, cwd, exit, stderr, stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const TEMPLATES_DIR = resolve(fileURLToPath(import.meta.url), '../../templates')
const DOTFILES = { _gitignore: '.gitignore', _npmrc: '.npmrc', _env: '.env', _nvmrc: '.nvmrc' }
const PLACEHOLDER_SCOPE = '@starter'

function log(m) {
  stdout.write(`${m}\n`)
}
function die(m) {
  stderr.write(`${m}\n`)
  exit(1)
}

function variants() {
  return readdirSync(TEMPLATES_DIR)
    .filter((d) => statSync(join(TEMPLATES_DIR, d)).isDirectory())
    .sort()
}

function parseArgs() {
  const args = argv.slice(2)
  let name
  let template
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-t' || a === '--template') template = args[++i]
    else if (!a.startsWith('-') && !name) name = a
  }
  if (name && !/^[a-z][a-z0-9-]*$/.test(name))
    die(`Error: project name "${name}" must be kebab-case.`)
  return { name, template }
}

async function prompt(question, fallback) {
  if (!stdin.isTTY) return fallback
  const rl = createInterface({ input: stdin, output: stdout })
  const answer = (await rl.question(question)).trim()
  rl.close()
  return answer || fallback
}

// Copy a template folder, restoring `_dotfile` names.
function copyTemplate(srcDir, destDir) {
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stats = statSync(full)
      if (stats.isDirectory()) walk(full)
      else if (stats.isFile()) {
        let rel = relative(srcDir, full)
        const base = basename(rel)
        if (DOTFILES[base]) rel = join(dirname(rel), DOTFILES[base])
        cpSync(full, join(destDir, rel))
      }
    }
  }
  walk(srcDir)
}

function renamePlaceholders(rootDir, name) {
  const scope = `@${name}`
  const scopeRe = new RegExp(`${PLACEHOLDER_SCOPE}(?=[\\\\/])`, 'g')
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      const original = readFileSync(full, 'utf8')
      let content = original
        .replace(scopeRe, scope)
        .replaceAll('starter-db', `${name}-db`)
        .replaceAll('starter-web', `${name}-web`)
      if (full.endsWith('package.json'))
        content = content.replace(/"name":\s*"starter"/g, `"name": "${name}"`)
      if (content !== original) writeFileSync(full, content)
    }
  }
  walk(rootDir)
}

function gitInit(rootDir, name) {
  try {
    execSync('git init -q -b main', { cwd: rootDir, stdio: 'ignore' })
    execSync('git add .', { cwd: rootDir, stdio: 'ignore' })
    execSync(`git commit -q -m "chore: scaffold ${name} from @lntt/create"`, {
      cwd: rootDir,
      stdio: 'ignore',
    })
  } catch {
    // git missing/failed — non-fatal
  }
}

async function main() {
  const available = variants()
  let { name, template } = parseArgs()

  if (!name) name = await prompt('Project name: ', '')
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) die('Error: a kebab-case project name is required.')

  if (!template) {
    template = await prompt(`Template [${available.join(', ')}] (default): `, 'default')
  }
  if (!available.includes(template))
    die(`Error: unknown template "${template}". Available: ${available.join(', ')}.`)

  const targetDir = resolve(cwd(), name)
  if (existsSync(targetDir)) die(`Error: "${name}" already exists.`)

  log(`Scaffolding "${name}" from template "${template}"...`)
  copyTemplate(join(TEMPLATES_DIR, template), targetDir)
  renamePlaceholders(targetDir, name)
  gitInit(targetDir, name)
  log(`\n✔ Created ${name} (template: ${template})\n\nNext:\n  cd ${name}\n  pnpm install`)
}

main().catch((e) =>
  die(`\nUnexpected error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`),
)
