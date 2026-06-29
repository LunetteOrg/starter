---
name: party
description: Run a multi-agent expert panel on a decision — fan out one independent agent per concern (architect, backend, design-system, QA, release), then synthesize their positions, disagreements, and candidate ADRs. Workflow-backed and one-shot (NOT an interactive chat). Use when the user asks for a panel, a multi-agent review, or genuinely independent perspectives on a problem, feature, or trade-off.
---

# Party — multi-agent panel

A **Workflow-backed** expert panel. Unlike a single model wearing many hats, this
fans out **real independent subagents** (separate contexts), so disagreement is
genuine, not theatre. It is **one-shot and non-interactive**: the user poses a
topic, the panel deliberates in the background, and you relay a synthesis. To go
deeper, the user refines the topic and re-runs — there is no live back-and-forth.

Invoking this skill **is** the user's explicit opt-in to multi-agent
orchestration (the Workflow tool's gate). Each run spawns ~6 agents — real cost;
don't run it for trivial questions where a single answer suffices.

## How to run it

1. Take the topic from the invocation args. If none was given, ask the user what
   decision the panel should weigh in on (one question), then proceed.
2. Call the **Workflow** tool with the script below, passing the topic via `args`.
3. When it completes, relay the synthesis to the user as the panel's verdict —
   lead with the decision and the *genuine disagreements*, not a bland summary.

## The roster (one independent agent per lens)

Concerns, not ADR numbers — each agent reads the repo (docs/adr/, code) to ground
its take at runtime:

- **architect** — layering, import boundaries, composition root, dependency direction.
- **backend** — domain purity, use-cases, typed errors, time/date, persistence & migrations, jobs.
- **design-system** — packages/ui, Storybook, design tokens, a11y, CSS Modules.
- **qa** — testing strategy, arch tests, e2e, fixtures, no-mock-the-DB.
- **release** — build pipeline, CI, git hooks, secrets, deploy, runtime lifecycle.

Include the lenses relevant to the topic; you may drop one that's clearly
irrelevant, but keep at least three for a real spread.

## Workflow script (pass topic via args)

```js
export const meta = {
  name: 'party-panel',
  description: 'Independent multi-agent expert panel on a decision',
  phases: [{ title: 'Panel' }, { title: 'Synthesis' }],
}

const TOPIC = typeof args === 'string' ? args : args?.topic
if (!TOPIC) throw new Error('party-panel: no topic provided in args')

const PERSONAS = [
  { key: 'architect', lens: 'layering, import boundaries, composition root, dependency direction, ADR stewardship' },
  { key: 'backend', lens: 'domain purity, use-cases, typed errors, time/date handling, persistence & schema migrations, jobs/cron' },
  { key: 'design-system', lens: 'packages/ui, Storybook, design tokens, a11y, CSS Modules' },
  { key: 'qa', lens: 'testing strategy, arch tests, e2e, fixtures, the no-mock-the-DB rule' },
  { key: 'release', lens: 'build pipeline, CI, git hooks, secrets, deploy, runtime lifecycle' },
]

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'position', 'risks', 'recommendation', 'candidateAdrs', 'confidence'],
  properties: {
    lens: { type: 'string' },
    position: { type: 'string', description: 'this lens’s independent take on the topic' },
    risks: { type: 'array', items: { type: 'string' } },
    recommendation: { type: 'string' },
    candidateAdrs: { type: 'array', items: { type: 'string' }, description: 'decisions that should become ADRs' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
}

const SYNTH = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'consensus', 'disagreements', 'actionItems', 'candidateAdrs'],
  properties: {
    decision: { type: 'string', description: 'recommended decision, or the key open choice if unresolved' },
    consensus: { type: 'array', items: { type: 'string' } },
    disagreements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['point', 'sides'],
        properties: { point: { type: 'string' }, sides: { type: 'string', description: 'who argues what' } },
      },
    },
    actionItems: { type: 'array', items: { type: 'string' } },
    candidateAdrs: { type: 'array', items: { type: 'string' } },
  },
}

phase('Panel')
const takes = (await parallel(PERSONAS.map((p) => () =>
  agent(
    `You sit on an expert panel reviewing this decision:\n\n"${TOPIC}"\n\n` +
    `Your lens: ${p.lens}. Ground every claim in THIS repo — read docs/adr/ and the relevant code before asserting; cite files/ADRs you actually find. ` +
    `Give your INDEPENDENT position. Do not hedge to agree with other lenses — you work in isolation and disagreement is valuable. ` +
    `Surface the real risks and a concrete recommendation.`,
    { label: `panel:${p.key}`, phase: 'Panel', schema: VERDICT },
  ).then((v) => (v ? { ...v, lens: p.key } : null)),
))).filter(Boolean)

phase('Synthesis')
const synthesis = await agent(
  `Synthesize this independent expert panel on:\n\n"${TOPIC}"\n\n` +
  `Panel inputs (JSON): ${JSON.stringify(takes)}\n\n` +
  `Produce: the recommended decision (or the key open choice if genuinely unresolved), points of real consensus, ` +
  `the genuine disagreements (name which lens argues what — do NOT manufacture agreement), action items, and candidate ADRs. ` +
  `Faithfully preserve dissent; a split panel is a valid outcome.`,
  { schema: SYNTH, phase: 'Synthesis' },
)

return { topic: TOPIC, panel: takes, synthesis }
```

## Relaying the result

Present the synthesis clearly: **Decision** first, then **Disagreements** (the
most valuable part — independent agents that diverge), then **Action items** and
**Candidate ADRs** (hand off to `adr-check` or write via `docs/adr/template.md`).
Don't bury the dissent under consensus. Never write files from here — the panel
produces recommendations; acting on them is a separate step.
