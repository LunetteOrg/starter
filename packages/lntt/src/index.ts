// The library API of @lntt/lntt, on Promise or synchronous, so a script that imports it needs no
// Effect (docs/adr/effect-in-lntt.md#the-bridge-while-modules-move). The configuration is read,
// validated and edited by src/config/: `.agents/config.jsonc` or `.agents/config.yml`.

export { checkAgentsBlock, managedBlock, syncAgentsBlock } from './agents.ts'
export {
  type BranchRules,
  branchName,
  branchRules,
  type Check,
  checkBranch,
  fromToolName,
  slugify,
  typeFor,
} from './branch.ts'
export {
  BROWSER_OPERATIONS,
  type BrowserOperation,
  type BrowserPlan,
  browserApp,
  browserPlan,
  chooseDriver,
  type Driver,
  type DriverChoice,
  formatPlan,
} from './browser.ts'
export {
  checkClaudeSettings,
  INSTALL_HOOK,
  MARKETPLACE,
  PLUGIN,
  SETTINGS,
  type SettingsEntry,
  syncClaudeSettings,
} from './claude-settings.ts'
export { commitlintConfig } from './commitlint.ts'
export type { Operator } from './config/operator.ts'
export { getConfigValue, getValue, type Loaded, projectPhase } from './config/project.ts'
export { findConfig, loadConfig, loadOperator, setValue } from './config/sync.ts'
export { ConfigError, type Format, type Located, NoConfigError } from './files.ts'
export {
  type Answer,
  type AskOptions,
  askAll,
  type HeadlessAgent,
  headlessInvocation,
  type Invocation,
  parseReply,
  providerOf,
  type Question,
  type Reply,
  type Spawn,
  timerMs,
} from './headless.ts'
export { type LocalApp, localApp } from './local.ts'
export {
  entry,
  type Mention,
  mentions,
  type Refs,
  type RefsRun,
  type Resolved,
  resolveRefs,
  type Why,
} from './refs.ts'
export {
  type Ask,
  agentLabel,
  type Checked,
  type Closed,
  closedEntry,
  closeRound,
  type Finding,
  type Found,
  isNoFindings,
  type Ledger,
  type Lens,
  lensApplies,
  mergeFindings,
  type Phase,
  parseFindings,
  parseOutcome,
  parseWithdrawal,
  type Range,
  type ReviewConfig,
  type ReviewCost,
  type ReviewState,
  type RoundCost,
  type RoundResult,
  renderReplyPrompt,
  renderReviewPrompt,
  renderVerifyPrompt,
  repeats,
  reviewConfig,
  reviewCost,
  reviewedAfter,
  reviewWarnings,
  roundClean,
  roundCosts,
  roundLimit,
  roundRange,
  runRound,
  type Severity,
  TEST_PATHS,
  touchedLines,
  unreadableFindings,
  verdict,
  verifiersFor,
} from './review.ts'
export {
  checkSkills,
  guide,
  type InstalledSkill,
  SKILL_DIRS,
  sharedSkills,
  skillFolder,
  stub,
  stubFolders,
  syncSkills,
} from './skills.ts'
export { type Choice, chooseViewer, commandExists, detectHost, type Host, openWith, type Viewer } from './viewer.ts'
export {
  type Agent,
  agentArgs,
  type BriefValues,
  type Runner,
  renderBrief,
  type SetupFor,
  type Start,
  type Started,
  setupScript,
  shellLaunch,
  startGit,
  startHerdr,
  startOrca,
  toolFailure,
  type WorktreeHost,
  worktreeHost,
} from './worktree.ts'
