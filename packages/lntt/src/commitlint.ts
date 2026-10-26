// The commitlint configuration of a Lunette project, built from `delivery.commits` in
// `.agents/config.*` so the tool and the `commit-message` skill read one list. Every
// rule that rejects a message says what to write instead and names the skill.

import { NoConfigError } from './files.ts'
import { loadConfig } from './index.ts'

interface Commits {
  maxLineLength?: number
  longTrailers?: string[]
  scopes?: string[]
}

type Outcome = [boolean, string]
type Rule = (parsed: {
  subject?: string | null
  scope?: string | null
  body?: string | null
  footer?: string | null
  raw?: string
}) => Outcome

const SEE = ' (see the commit-message skill)'

// A first word that names something rather than a capitalised word: a decision code,
// an issue key, CamelCase, a SCREAMING_SNAKE constant, a file name (AGENTS.md).
const IDENTIFIER = [
  /^(ADR|PDR)-[A-Z]{2,12}$/,
  /^[A-Z]{2,}-\d+$/,
  /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/,
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/,
  /^[A-Z][A-Za-z0-9_-]*\.[a-z0-9]+$/,
]

// No configuration file: the defaults. A file that does not validate is an error.
function commits(cwd: string): Commits {
  try {
    const delivery = loadConfig(cwd).data.delivery as { commits?: Commits } | undefined
    return delivery?.commits ?? {}
  } catch (e) {
    if (e instanceof NoConfigError) return {}
    throw e
  }
}

export function commitlintConfig(cwd: string = process.cwd()) {
  const { maxLineLength = 100, longTrailers = [], scopes } = commits(cwd)
  const exempt = new RegExp(`^(${longTrailers.map((t) => t.replace(/[^\w-]/g, '')).join('|') || '(?!)'}):`)
  const tooLong = (text: string | null | undefined) =>
    (text ?? '').split('\n').some((line) => line.length > maxLineLength && !exempt.test(line))
  const exemptNote =
    longTrailers.length > 0 ? `; ${longTrailers.map((t) => `${t}:`).join(', ')} trailers are exempt` : ''

  const rules: Record<string, Rule> = {
    'lunette/subject-case': ({ subject }) => {
      const first = (subject ?? '').split(/\s/)[0] ?? ''
      return [
        !/^[A-Z]/.test(first) || IDENTIFIER.some((re) => re.test(first)),
        `subject must start in lower case, or with an identifier or a file name (ADR-LANG, MAX_RETRIES, AGENTS.md); put a proper noun between backticks${SEE}`,
      ]
    },
    'lunette/line-length': ({ body, footer }) => [
      !tooLong(body) && !tooLong(footer),
      `body and footer lines must not be longer than ${maxLineLength} characters${exemptNote}${SEE}`,
    ],
    'lunette/subject-no-dash': ({ subject }) => [
      !/[—–]/.test(subject ?? ''),
      `subject must not contain an em or en dash: use a hyphen or rephrase${SEE}`,
    ],
    'lunette/no-attribution': ({ raw }) => [
      !/^(Co-authored-by:|Claude-Session:|🤖 Generated with)/im.test(raw ?? ''),
      `the message must not carry an attribution trailer (Co-Authored-By:, "Generated with"); commit messages stay clean${SEE}`,
    ],
  }
  if (scopes && scopes.length > 0) {
    rules['lunette/scope'] = ({ scope }) => [
      !scope || scope.split(/[,/]/).every((s) => scopes.includes(s.trim())),
      `scope must be one of: ${scopes.join(', ')}, or none${SEE}`,
    ]
  }

  return {
    extends: ['@commitlint/config-conventional'],
    plugins: [{ rules }],
    rules: {
      'subject-case': [0] as [0],
      'body-max-line-length': [0] as [0],
      'footer-max-line-length': [0] as [0],
      'header-max-length': [2, 'always', maxLineLength] as [2, 'always', number],
      ...Object.fromEntries(Object.keys(rules).map((name) => [name, [2, 'always'] as [2, 'always']])),
    },
  }
}
