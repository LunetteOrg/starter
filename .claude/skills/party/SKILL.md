---
name: party
description: Run an INTERACTIVE multi-agent expert panel — spawn one persistent independent agent per concern (architect, backend, design-system, QA, release) and facilitate a live round-table the user drives across turns, with a synthesis on exit. Use when the user wants a panel, a round-table, or genuinely independent perspectives they can interrogate back-and-forth on a problem, feature, or trade-off.
---

# Party — interactive multi-agent panel

A live round-table backed by **real independent subagents** (separate contexts,
genuine disagreement) that the user can interrogate across turns. The
interaction mechanism: spawn one **persistent background agent per lens** once,
then **continue each via SendMessage** on every user turn — the main loop is the
facilitator (Pia), never a separate agent. This is the difference from a
one-shot Workflow (which can't be paused for input) and from single-model
role-play (which only *simulates* independence).

Invoking this skill **is** the explicit opt-in to multi-agent orchestration.
Each turn messages several live agents — real cost and latency; use it for
decisions that earn it, not trivia.

## Tools

Load these first (deferred): `ToolSearch` →
`select:Agent,SendMessage,TaskStop`. Use `Agent` (with `run_in_background: true`)
to spawn each persona; `SendMessage` (to the agent's id/name) to continue it with
its context intact; `TaskStop` to tear agents down on exit.

## The roster (one persistent agent per lens)

Concerns, not ADR numbers — each agent reads the repo at runtime to ground itself:

- **architect** — layering, import boundaries, composition root, dependency direction.
- **backend** — domain purity, use-cases, typed errors, time/date, persistence & migrations, jobs.
- **design-system** — packages/ui, Storybook, design tokens, a11y, CSS Modules.
- **qa** — testing strategy, arch tests, e2e, fixtures, no-mock-the-DB.
- **release** — build pipeline, CI, git hooks, secrets, deploy, runtime lifecycle.

Pick the lenses relevant to the topic (min 3 for a real spread); skip clearly
irrelevant ones to save cost.

## How it runs

1. **Open.** Take the topic from the args (if none, ask once what to decide).
   Spawn each chosen lens as a background `Agent` using the persona prompt below.
   Keep a map `lens → agentId`. Collect each agent's opening position and present
   the round, facilitated: as Pia, frame the topic in a line and **lead with the
   tensions**, not a tidy summary.

2. **Facilitate each turn.** On every user message:
   - If they address a lens (`@architect …` / "architect, …"), `SendMessage` to
     that agent. If they ask the room, message the relevant agents.
   - To create real debate, relay one agent's claim to another and ask for a
     rebuttal (`SendMessage` with the other's point quoted).
   - Present responses in character (`🏛 architect: …`), keep turns tight, and
     **surface disagreement — never manufacture consensus**.
   - Reuse the SAME agentIds every turn so context persists; do not re-spawn.

3. **Stay in the panel** across turns until the user exits.

## Persona prompt (per spawned agent)

> You sit on an expert panel deliberating: "{TOPIC}". Your lens: {lens concerns}.
> Ground every claim in THIS repo — read `docs/adr/` and the relevant code before
> asserting; cite what you actually find. Reason INDEPENDENTLY: do not bend to
> agree with other panelists, and say so plainly when you disagree. You'll receive
> follow-ups and other panelists' points over several turns — stay in character,
> keep replies tight (1–4 sentences), and defend or revise your position on the
> merits. Open with your position on the topic and the top risk you see.

## Converging & exit

When the user says "exit party" / "esci dalla party" or the decision resolves,
**synthesize** (you, as Pia — or one final agent if you want a neutral pass):

```
## Party wrap-up — {topic}
**Decision:** … (or the key open choice if genuinely unresolved)
**Consensus:** …
**Disagreements:** which lens argues what (preserve the dissent)
**Action items:** owner → task
**Candidate ADRs:** title — why (hand off to `adr-check` / docs/adr/template.md)
```

Then **`TaskStop` the spawned agents** and return to normal mode. Never write
files from party — it produces recommendations; acting on them is a separate step.
