#!/usr/bin/env node
// Aggregate every `coverage/coverage-summary.json` in the monorepo into one
// markdown table and append it to the GitHub Actions job summary (or print it
// locally). Self-arming: with no coverage reports yet it says so and exits 0,
// so it never fails a pipeline just because a package has no tests.
//
// Coverage is produced by `vitest run --coverage` (json-summary reporter, see
// each package's vitest.config). Totals across packages are summed at the file
// level (packages don't share files), then the percentage is recomputed.

import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { cwd, env, stdout } from 'node:process'

const METRICS = ['statements', 'branches', 'functions', 'lines']
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.turbo', '.react-router'])

function findSummaries(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'coverage') {
        try {
          statSync(join(full, 'coverage-summary.json'))
          found.push(join(full, 'coverage-summary.json'))
        } catch {
          // no summary in this coverage dir — keep walking
        }
      }
      findSummaries(full, found)
    }
  }
  return found
}

function emit(text) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`)
  else stdout.write(`${text}\n`)
}

const files = findSummaries(cwd())
if (files.length === 0) {
  emit('## Test Coverage\n\n_No coverage reports found — no packages produced coverage yet._')
  process.exit(0)
}

const totals = Object.fromEntries(METRICS.map((m) => [m, { covered: 0, total: 0 }]))
for (const file of files) {
  const { total } = JSON.parse(readFileSync(file, 'utf8'))
  for (const m of METRICS) {
    totals[m].covered += total[m].covered
    totals[m].total += total[m].total
  }
}

const pct = ({ covered, total }) => (total === 0 ? 100 : (covered / total) * 100)
const row = (label, d) => `| ${label} | ${pct(d).toFixed(2)}% (${d.covered}/${d.total}) |`

emit(
  [
    '## Test Coverage',
    '',
    `Merged from ${files.length} package(s).`,
    '',
    '| Metric | Result |',
    '| ------ | ------ |',
    row('Statements', totals.statements),
    row('Branches', totals.branches),
    row('Functions', totals.functions),
    row('Lines', totals.lines),
  ].join('\n'),
)
