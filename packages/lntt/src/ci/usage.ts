// The usage of `lntt ci`, which the parser and the commands on Effect print with a usage error
// (exit 2). It imports nothing, so the parser loads no Effect for it.

export const USAGE = [
  'usage: lntt ci local [--event pull_request|push] [--base <branch>] [--job <key>]... [--list] [--strict] [--container] [--no-lock]',
  '       lntt ci candidate [--pr <n>] [--event <action>] [--head-ref <ref>] [--labels a,b] [--merged] [--dry-run]',
  '       lntt ci candidate --follow [--dry-run]',
  '       lntt ci candidate --guard [--pr <n>]',
  '       lntt ci proved --job <name>... [--step <name>] [--workflow <file>] [--sha <sha>] [--before <sha>] [--branch <name>]',
].join('\n')

export const usageText = (message?: string) => `${message ? `lntt ci: ${message}\n` : ''}${USAGE}\n`
