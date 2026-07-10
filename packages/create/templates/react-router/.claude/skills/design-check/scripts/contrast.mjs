#!/usr/bin/env node
/**
 * WCAG contrast check over the design tokens (design-check skill).
 *
 * Parses `packages/ui-tokens/tokens.css`, resolves var() chains per theme
 * (`:root` = light, `[data-theme="dark"]` overrides = dark) and reports the
 * contrast ratio of every `--color-fg*` over every `--color-bg*` pair (text,
 * AA ≥ 4.5) plus brand/feedback colors over the backgrounds (UI, AA ≥ 3).
 *
 * Usage: node contrast.mjs [path/to/tokens.css]
 * Exit code 1 if any pair fails its threshold.
 */
import { readFileSync } from 'node:fs'

const path = process.argv[2] ?? 'packages/ui-tokens/tokens.css'
const css = readFileSync(path, 'utf8')

function parseScope(source, selectorRe) {
  const tokens = {}
  const re = new RegExp(`${selectorRe.source}\\s*\\{([^}]*)\\}`, 'g')
  for (const m of source.matchAll(re)) {
    for (const decl of m[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
      tokens[`--${decl[1]}`] = decl[2].trim()
    }
  }
  return tokens
}

const light = parseScope(css, /:root/)
const dark = { ...light, ...parseScope(css, /\[data-theme="dark"\]/) }

function resolve(tokens, value, depth = 0) {
  if (depth > 10) return null
  const ref = value.match(/^var\((--[\w-]+)\)$/)
  if (ref) return tokens[ref[1]] ? resolve(tokens, tokens[ref[1]], depth + 1) : null
  return value
}

function hexToRgb(value) {
  const m = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!m) return null // color-mix, rgb(), named colors: out of scope, skip
  let h = m[1]
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16))
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

let failures = 0
for (const [theme, tokens] of [
  ['light', light],
  ['dark', dark],
]) {
  const color = (name) => {
    const raw = resolve(tokens, tokens[name] ?? '')
    return raw ? hexToRgb(raw) : null
  }
  const names = Object.keys(tokens)
  const bgs = names.filter((n) => /^--color-bg/.test(n))
  const fgs = names.filter((n) => /^--color-fg/.test(n))
  // Ink-on-background candidates: brand shades ≥300 and feedback colors.
  // Light tints (-50/-100/-200) are surfaces, not ink — pairing them against
  // a background is meaningless, so they are excluded.
  const ui = names.filter(
    (n) => /^--color-(brand-[3-9]\d\d|success|warning|danger)$/.test(n),
  )

  console.log(`\n[${theme}]`)
  for (const bg of bgs) {
    const bgRgb = color(bg)
    if (!bgRgb) continue
    for (const [fg, min] of [...fgs.map((f) => [f, 4.5]), ...ui.map((u) => [u, 3])]) {
      const fgRgb = color(fg)
      if (!fgRgb) continue
      const r = ratio(fgRgb, bgRgb)
      const ok = r >= min
      if (!ok) failures++
      console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${fg} on ${bg}  ${r.toFixed(2)}:1  (min ${min}:1)`,
      )
    }
    // Border is 3:1 only when it is the sole visible boundary of a component
    // (WCAG 1.4.11) — report it as a note, don't fail the run on it.
    const borderRgb = color('--color-border')
    if (borderRgb) {
      const r = ratio(borderRgb, bgRgb)
      console.log(
        `  ${r >= 3 ? 'PASS' : 'NOTE'}  --color-border on ${bg}  ${r.toFixed(2)}:1  (3:1 only if sole boundary)`,
      )
    }
  }
}

process.exit(failures > 0 ? 1 : 0)
