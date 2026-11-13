// The values the lunette plugin keeps in `$.state`: the issues and pull requests the
// session cited, for the pane `/issues` opens (hooks/issues-pane.mjs).

export type CitedRow = {
  /** `owner/repo#N`, lower case. */
  ref: string
  title: string
  url: string
  /** When the block that cited it was read; the most recent is listed first. */
  at: number
  /** Its place in that block's text. */
  i: number
}

declare module 'claude-code' {
  interface PluginState {
    lunette: { cited: { home: string | null; rows: CitedRow[] } }
  }
}
