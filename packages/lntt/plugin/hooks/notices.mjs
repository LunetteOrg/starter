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

// The entries of the project's .claude/settings.json (its text, null when there is none)
// that are not as lntt sync writes them; the whole file when it is missing or not JSON.
export function settingsProblems(text) {
  let s
  try {
    s = JSON.parse(text)
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
