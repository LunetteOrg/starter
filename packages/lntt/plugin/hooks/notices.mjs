// What the plugin says when a mechanism of it cannot work: once per session, the thing
// missing and the command that fixes it, never an error and never a blocked turn. Pure:
// the hooks find the problem (register.js, issue-titles-hook.js) and show the notice.

const ESC = '\u001b'
const dim = (text) => `${ESC}[2m${text}${ESC}[22m`

// The first @lntt/lntt with `lntt refs`, which the issue titles call.
export const REFS_SINCE = '0.6.3'

// What lntt sync writes into .claude/settings.json (packages/lntt/src/claude-settings.ts):
// the marketplace, the plugin, and the install hook, told by its status message.
const MARKETPLACE_PATH = './node_modules/@lntt/lntt'
const PLUGIN = 'lunette@lunette'
const INSTALL_STATUS = 'lntt: checking the dependencies are installed'

const SYNC = 'Run: pnpm exec lntt sync'

// `problem.kind`: lntt-missing, no-refs (with the version `found`, null for an lntt on
// PATH), gh-missing, gh-auth, settings (with the `keys` off). Dimmed, for the message
// display; the band dims `noticeText` itself.
export function notice(problem) {
  const text = noticeText(problem)
  return text && dim(text)
}

export function noticeText(problem) {
  const titles = (text) => `lntt · issue titles off: ${text}`
  switch (problem.kind) {
    case 'lntt-missing':
      return titles('lntt is not installed in this project. Run: pnpm install')
    case 'no-refs':
      return titles(
        problem.found
          ? `lntt ${problem.found} has no \`lntt refs\`, which came with @lntt/lntt ${REFS_SINCE}. Run: pnpm up @lntt/lntt`
          : `the lntt on PATH has no \`lntt refs\`, which came with @lntt/lntt ${REFS_SINCE}. Run: pnpm install`,
      )
    case 'gh-missing':
      return titles('gh is not installed. Install it (https://cli.github.com), then run: gh auth login')
    case 'gh-auth':
      return titles('gh is not logged in. Run: gh auth login')
    case 'settings':
      return `lntt · .claude/settings.json: ${problem.keys.join(', ')} is not as lntt sync writes it. ${SYNC}`
    default:
      return ''
  }
}

// JSON with comments and trailing commas, as lntt reads .claude/settings.json (jsonc-parser,
// which the plugin cannot import): both are dropped outside strings, then JSON.parse.
function parseJsonc(text) {
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (c === '"') {
      const start = i
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === '\\') i += 1
      out += text.slice(start, i + 1)
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      out += ' '
    } else if (c === '}' || c === ']') {
      // A trailing comma before it, past the whitespace and the comments dropped.
      out = out.replace(/,(\s*)$/, '$1') + c
    } else out += c
  }
  return JSON.parse(out)
}

// The entries of the project's .claude/settings.json (its text, null when there is none)
// that are not as lntt sync writes them; the whole file when it is missing or not JSON.
export function settingsProblems(text) {
  let s
  try {
    s = parseJsonc(text)
  } catch {
    return ['.claude/settings.json']
  }
  if (typeof s !== 'object' || s === null || Array.isArray(s)) return ['.claude/settings.json']
  const source = s.extraKnownMarketplaces?.lunette?.source
  const hooks = (s.hooks?.SessionStart ?? []).flatMap((e) => e?.hooks ?? [])
  return [
    source?.source === 'directory' && source?.path === MARKETPLACE_PATH ? null : 'extraKnownMarketplaces.lunette',
    s.enabledPlugins?.[PLUGIN] === true ? null : `enabledPlugins.${PLUGIN}`,
    hooks.some((h) => h?.statusMessage === INSTALL_STATUS) ? null : 'hooks.SessionStart',
  ].filter(Boolean)
}
