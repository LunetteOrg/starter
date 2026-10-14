// CircleCI workflow conditions (`when:`), evaluated against the pipeline values of
// the event a local run stands in for. `circleci config process` evaluates them too,
// but without event values, so a workflow chosen by the base of a pull request would
// be chosen wrong; the selection is made here instead.
//
// Supported: booleans, `<< pipeline.parameters.x >>` (substituted first), the logic
// maps (and, or, not, equal, matches) and the expression strings (==, !=, and, or,
// not, parentheses, string, number and boolean literals, pipeline values), with
// `and`/`or` short-circuited as CircleCI does. A pipeline value the local run does not
// have makes the result unknown.

import type { Decision } from './plan.ts'

export type PipelineValues = Record<string, string>

// Replaces `<< pipeline.parameters.x >>` everywhere in a parsed YAML value. A string
// that is only the placeholder takes the parameter's own type.
export function substituteParameters<T>(value: T, parameters: Record<string, unknown>): T {
  const pattern = /<<\s*pipeline\.parameters\.([\w-]+)\s*>>/g
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const whole = /^<<\s*pipeline\.parameters\.([\w-]+)\s*>>$/.exec(v)
      if (whole && Object.hasOwn(parameters, whole[1])) return parameters[whole[1]]
      return v.replace(pattern, (match, name) => (Object.hasOwn(parameters, name) ? String(parameters[name]) : match))
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(value) as T
}

class Unknown extends Error {
  readonly value: string
  constructor(value: string) {
    super(`unknown pipeline value ${value}`)
    this.value = value
  }
}

type Value = string | number | boolean | null

function tokenize(text: string): string[] {
  const tokens: string[] = []
  const pattern = /\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|==|!=|\(|\)|[^\s()=!]+)/gy
  for (const match of text.matchAll(pattern)) tokens.push(match[1])
  if (tokens.join('').length !== text.replace(/\s+/g, '').length) throw new Error(`cannot parse when: ${text}`)
  return tokens
}

// A recursive-descent evaluator: or > and > not > comparison > primary. Each level
// returns a thunk, so a branch `and`/`or` does not need is never evaluated.
function expression(text: string, values: PipelineValues): boolean {
  const tokens = tokenize(text)
  let i = 0
  const peek = () => tokens[i]
  const next = () => tokens[i++]

  const primary = (): (() => Value) => {
    const token = next()
    if (token === '(') {
      const inner = or()
      if (next() !== ')') throw new Error(`missing ) in when: ${text}`)
      return inner
    }
    if (token === undefined) throw new Error(`unexpected end of when: ${text}`)
    if (/^["']/.test(token)) return () => token.slice(1, -1)
    if (token === 'true' || token === 'false') return () => token === 'true'
    if (/^-?\d+(\.\d+)?$/.test(token)) return () => Number(token)
    return () => {
      if (!Object.hasOwn(values, token)) throw new Unknown(token)
      return values[token]
    }
  }
  const comparison = (): (() => Value) => {
    const left = primary()
    if (peek() === '==' || peek() === '!=') {
      const operator = next()
      const right = primary()
      return () => (left() === right()) === (operator === '==')
    }
    return left
  }
  const not = (): (() => Value) => {
    if (peek() === 'not') {
      next()
      const inner = not()
      return () => !inner()
    }
    return comparison()
  }
  const and = (): (() => Value) => {
    let left = not()
    while (peek() === 'and') {
      next()
      const l = left
      const right = not()
      left = () => Boolean(l()) && Boolean(right())
    }
    return left
  }
  const or = (): (() => Value) => {
    let left = and()
    while (peek() === 'or') {
      next()
      const l = left
      const right = and()
      left = () => Boolean(l()) || Boolean(right())
    }
    return left
  }
  const result = or()
  if (i !== tokens.length) throw new Error(`unexpected ${peek()} in when: ${text}`)
  return Boolean(result())
}

function logic(when: unknown, values: PipelineValues): boolean {
  if (when === undefined || when === null) return true
  if (typeof when === 'boolean') return when
  if (typeof when === 'string') {
    if (when === 'true' || when === 'false') return when === 'true'
    return expression(when, values)
  }
  if (typeof when === 'object') {
    const map = when as Record<string, unknown>
    if ('and' in map) return (map.and as unknown[]).every((c) => logic(c, values))
    if ('or' in map) return (map.or as unknown[]).some((c) => logic(c, values))
    if ('not' in map) return !logic(map.not, values)
    if ('equal' in map) {
      const [first, ...rest] = map.equal as unknown[]
      return rest.every((v) => JSON.stringify(v) === JSON.stringify(first))
    }
    if ('matches' in map) {
      const { pattern, value } = map.matches as { pattern: string; value: string }
      return new RegExp(pattern).test(String(value))
    }
    if ('condition' in map) return logic(map.condition, values)
  }
  throw new Error(`cannot evaluate when: ${JSON.stringify(when)}`)
}

export function evaluateWhen(when: unknown, values: PipelineValues): Decision {
  try {
    return { known: true, value: logic(when, values) }
  } catch (error) {
    if (error instanceof Unknown) return { known: false, unknown: [error.value] }
    throw error
  }
}
