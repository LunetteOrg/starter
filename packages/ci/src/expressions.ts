// GitHub Actions expressions (`if:`, `${{ }}`), evaluated with @actions/expressions
// against what a local run knows of the event. A value the run cannot know (the
// outputs of another job, a secret not declared fake, a label on the pull request)
// is not guessed: the result is unknown and names it, and the caller reports it.
// Only the paths actually evaluated count, so `a && b` with a false `a` never asks
// for `b`, as on GitHub.

import { data, Evaluator, Lexer, Parser } from '@actions/expressions'
import { ContextAccess, type Expr, type FunctionCall, IndexAccess, Literal } from '@actions/expressions/ast'
import { truthy } from '@actions/expressions/result'

export type Context = Record<string, unknown>

export interface JobStatus {
  failed: boolean
  // success() when it differs from !failed: for a job, every need passed.
  success?: boolean
}

export type Outcome<T> = { known: true; value: T } | { known: false; unknown: string[] }

const CONTEXTS = ['github', 'env', 'vars', 'secrets', 'inputs', 'needs', 'steps', 'job', 'runner', 'strategy', 'matrix']

// A missing key of these contexts is an empty value, as GitHub gives it; in every
// other context it is something only the cloud knows.
const LENIENT = new Set(['env'])

const STATUS = ['success', 'failure', 'always', 'cancelled']

// Workflow functions the parser must accept, but a local run cannot compute.
const CLOUD_ONLY = [{ name: 'hashFiles', minArgs: 1, maxArgs: 255 }]

// The built-in functions @actions/expressions implements; hashFiles and the others
// it does not are unknown locally.
const BUILT_IN = new Set(['contains', 'endswith', 'format', 'fromjson', 'join', 'startswith', 'tojson'])

function parse(expression: string): Expr {
  const lexed = new Lexer(expression).lex()
  return new Parser(lexed.tokens, CONTEXTS, [
    ...STATUS.map((name) => ({ name, minArgs: 0, maxArgs: 0 })),
    ...CLOUD_ONLY,
  ]).parse()
}

// `a.b['c']` as ['a', 'b', 'c'], or null when an index is not a literal.
function pathOf(expr: Expr): string[] | null {
  if (expr instanceof ContextAccess) return [expr.name.lexeme]
  if (expr instanceof IndexAccess && expr.index instanceof Literal) {
    const parent = pathOf(expr.expr)
    const key = expr.index.literal
    if (parent && key instanceof data.StringData) return [...parent, key.value]
  }
  return null
}

function toData(value: unknown): data.ExpressionData {
  return JSON.parse(JSON.stringify(value ?? null), data.reviver)
}

class LocalEvaluator extends Evaluator {
  readonly unknown: string[] = []
  private readonly values: Context

  constructor(expr: Expr, values: Context, status: JobStatus) {
    const results: Record<string, boolean> = {
      success: status.success ?? !status.failed,
      failure: status.failed,
      always: true,
      cancelled: false,
    }
    super(
      expr,
      new data.Dictionary(),
      new Map(
        STATUS.map((name) => [name, { name, minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(results[name]) }]),
      ),
    )
    this.values = values
  }

  private resolve(path: string[]): data.ExpressionData {
    let value: unknown = this.values
    for (const [i, key] of path.entries()) {
      if (value !== null && typeof value === 'object' && Object.hasOwn(value, key)) {
        value = (value as Record<string, unknown>)[key]
      } else if (i === 1 && LENIENT.has(path[0]) && Object.hasOwn(this.values, path[0])) {
        return new data.StringData('')
      } else {
        this.unknown.push(path.join('.'))
        return new data.Null()
      }
    }
    return toData(value)
  }

  override visitContextAccess(access: ContextAccess): data.ExpressionData {
    return this.resolve([access.name.lexeme])
  }

  override visitIndexAccess(access: IndexAccess): data.ExpressionData {
    const path = pathOf(access)
    return path ? this.resolve(path) : super.visitIndexAccess(access)
  }

  override visitFunctionCall(call: FunctionCall): data.ExpressionData {
    const name = call.functionName.lexeme
    const lower = name.toLowerCase()
    if (!STATUS.includes(lower) && !BUILT_IN.has(lower)) {
      this.unknown.push(`${name}()`)
      return new data.Null()
    }
    return super.visitFunctionCall(call)
  }
}

function run(expression: string, context: Context, status: JobStatus): Outcome<data.ExpressionData> {
  const evaluator = new LocalEvaluator(parse(expression), context, status)
  const result = evaluator.evaluate()
  if (evaluator.unknown.length > 0) return { known: false, unknown: [...new Set(evaluator.unknown)] }
  return { known: true, value: result }
}

// A condition: true when the step or job runs.
export function evaluate(expression: string, context: Context, status: JobStatus): Outcome<boolean> {
  const outcome = run(expression, context, status)
  return outcome.known ? { known: true, value: truthy(outcome.value) } : outcome
}

// A value: `${{ }}` inside a string reaches here as the parser's `format(…)`.
export function interpolate(expression: string, context: Context): Outcome<string> {
  const outcome = run(expression, context, { failed: false })
  return outcome.known ? { known: true, value: outcome.value.coerceString() } : outcome
}
