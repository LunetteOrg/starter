// The plain parts of the worktree adapters the library exports (src/worktree/hosts.ts): the host a
// session runs in, an agent's arguments and its launch line. `lntt worktree start` runs the
// adapters on Effect (src/worktree/start.ts, over src/worktree/steps.ts).

export {
  type Agent,
  agentArgs,
  type BriefValues,
  type Start,
  type Started,
  shellLaunch,
  toolFailure,
  type WorktreeHost,
  worktreeHost,
} from './worktree/hosts.ts'
