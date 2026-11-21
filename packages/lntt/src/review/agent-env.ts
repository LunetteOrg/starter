// The environment of a review's agent (src/review/agents.ts). Apart from agents.ts, so that a
// caller that only builds an environment does not load Effect.

// The host's hook variables stay with the session that owns them: an agent of the round
// would otherwise report to Orca (or Herdr) as that session.
const HOST_HOOKS = /^(ORCA_AGENT_HOOK_|ORCA_PANE_KEY$|ORCA_TAB_ID$|ORCA_AGENT_LAUNCH_TOKEN$|HERDR_)/

export function agentEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) if (value !== undefined && !HOST_HOOKS.test(name)) out[name] = value
  return { ...out, ...extra }
}
