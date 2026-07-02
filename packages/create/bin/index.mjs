#!/usr/bin/env node
// @lntt/create — scaffolds a new project from a bundled starter template.
//
// Templates are folders under `templates/` (create-vite style). The CLI copies
// the chosen one verbatim, restores npm-mangled dotfiles (`_gitignore` etc.),
// strips the `.lunette-template` marker, and rewrites the `@starter/*` scope and
// `starter` credentials to the project name.

import { execSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { argv, cwd, exit, stderr, stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const TEMPLATES_DIR = resolve(fileURLToPath(import.meta.url), '../../templates')
const DOTFILES = { _gitignore: '.gitignore', _npmrc: '.npmrc', _env: '.env' }
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.turbo', '.react-router', 'coverage', '.jest-cache'])
// Files whose contents carry placeholders. `.editorconfig` and dotless names are
// matched too — the earlier miss that let `@starter/biome-config` survive.
const TEXT = /\.(json|jsonc|ya?ml|tsx?|jsx?|mjs|cjs|md|mdx|css|html|env|nvmrc|npmrc|gitignore|editorconfig|template)$|(^|\/)(Dockerfile|compose\.yaml|render\.yaml|lefthook\.yml|turbo\.json|biome\.json|\.editorconfig|_gitignore|_npmrc)$/

const log = (m) => stdout.write(`${m}\n`)
const die = (m) => {
  stderr.write(`${m}\n`)
  exit(1)
}
const variants = () => readdirSync(TEMPLATES_DIR).filter((d) => statSync(join(TEMPLATES_DIR, d)).isDirectory()).sort()

async function prompt(question, fallback) {
  if (!stdin.isTTY) return fallback
  const rl = createInterface({ input: stdin, output: stdout })
  const answer = (await rl.question(question)).trim()
  rl.close()
  return answer || fallback
}

function copyTemplate(srcDir, destDir) {
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      let rel = relative(srcDir, full)
      const b = basename(rel)
      if (DOTFILES[b]) rel = join(dirname(rel), DOTFILES[b])
      cpSync(full, join(destDir, rel))
    }
  }
  walk(srcDir)
  rmSync(join(destDir, '.lunette-template'), { force: true }) // absence marks a scaffolded project
}

function renamePlaceholders(rootDir, name) {
  const scope = `@${name}`
  const scopeRe = new RegExp('@starter(?=[\\\\/])', 'g')
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!TEXT.test(full)) continue
      const orig = readFileSync(full, 'utf8')
      let c = orig
        .replace(scopeRe, scope)
        .replaceAll('starter-db', `${name}-db`)
        .replaceAll('starter-web', `${name}-web`)
        .replaceAll('POSTGRES_USER: starter', `POSTGRES_USER: ${name}`)
        .replaceAll('POSTGRES_PASSWORD: starter', `POSTGRES_PASSWORD: ${name}`)
        .replaceAll('POSTGRES_DB: starter', `POSTGRES_DB: ${name}`)
        .replaceAll("pg_isready', '-U', 'starter'", `pg_isready', '-U', '${name}'`)
        .replaceAll('databaseName: starter', `databaseName: ${name}`)
        .replaceAll('user: starter', `user: ${name}`)
        .replaceAll('postgresql://starter:starter@localhost:5432/starter', `postgresql://${name}:${name}@localhost:5432/${name}`)
      if (full.endsWith('package.json') || full.endsWith('devcontainer.json')) {
        c = c.replace(/"name":\s*"starter"/g, `"name": "${name}"`)
      }
      if (c !== orig) writeFileSync(full, c)
    }
  }
  walk(rootDir)
}

function gitInit(rootDir, name) {
  try {
    execSync('git init -q -b main', { cwd: rootDir, stdio: 'ignore' })
    execSync('git add .', { cwd: rootDir, stdio: 'ignore' })
    execSync(`git commit -q -m "chore: scaffold ${name} from @lntt/create"`, { cwd: rootDir, stdio: 'ignore' })
  } catch {
    // git missing/failed — non-fatal
  }
}

async function main() {
  const args = argv.slice(2)
  if (args.includes('-h') || args.includes('--help')) {
    log(`Usage: pnpm create @lntt <project-name> [--template <name>]\nTemplates: ${variants().join(', ')}`)
    exit(0)
  }
  let name = args.find((a) => !a.startsWith('-'))
  const tIdx = args.findIndex((a) => a === '-t' || a === '--template')
  let template = tIdx >= 0 ? args[tIdx + 1] : undefined

  if (!name) name = await prompt('Project name: ', '')
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) die('Error: a kebab-case project name is required.')
  if (!template) template = await prompt(`Template [${variants().join(', ')}] (default): `, 'default')
  if (!variants().includes(template)) die(`Error: unknown template "${template}". Available: ${variants().join(', ')}.`)

  const targetDir = resolve(cwd(), name)
  if (existsSync(targetDir)) die(`Error: "${name}" already exists.`)

  log(`Scaffolding "${name}" from template "${template}"...`)
  copyTemplate(join(TEMPLATES_DIR, template), targetDir)
  renamePlaceholders(targetDir, name)
  gitInit(targetDir, name)
  log(`\n✔ Created ${name} (template: ${template})\n\nNext:\n  cd ${name}\n  pnpm install\n  pnpm infra:up\n  pnpm dev`)
}

main().catch((e) => die(`\nUnexpected error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`))
