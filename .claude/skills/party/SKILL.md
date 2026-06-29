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
`select:Agent,SendMessage,TaskStop`. Use `Agent` (with `run_in_background: true`
and `subagent_type` set to the persona, below) to spawn each panelist;
`SendMessage` (to the agent's id/name) to continue it with its context intact;
`TaskStop` to tear agents down on exit.

## The roster (each is a defined subagent in `.claude/agents/`)

The personas live as first-class subagents — spawn them by `subagent_type`; their
character and lens are in their definition, not duplicated here. Each reads the
repo at runtime to ground itself.

- `architect` — **Ada**: layering, boundaries, composition root, ADR stewardship.
- `backend` — **Bruno**: domain purity, use-cases, typed errors, persistence & migrations.
- `design-system` — **Dana**: packages/ui, Storybook, tokens, a11y, DX.
- `qa` — **Quinn**: adversarial testability, test strategy, no-mock-the-DB.
- `release` — **Remo**: CI, build pipeline, secrets, deploy, prod operability.

Pick the lenses relevant to the topic (min 3 for a real spread); skip clearly
irrelevant ones to save cost.

## Model per agent

Each lens can run on its own model — pass `model` to the `Agent` spawn
(`opus` | `sonnet` | `haiku` | `fable`). Omit it to **inherit the session
model** (the safe default). The user may set a profile at invocation
("architect and synthesis on opus, the rest on haiku"); honor it, otherwise
inherit. Guidance: a cheaper model (e.g. `haiku`) is fine for breadth lenses to
keep cost/latency down, while reserving a stronger model for the hardest lens
and the synthesis pass; mixing models also genuinely diversifies the panel.
The model is fixed at spawn — `SendMessage` continues an agent on the model it
was created with.

## How it runs

1. **Open.** Take the topic from the args (if none, ask once what to decide).
   Spawn each chosen lens as a background `Agent` with its `subagent_type`
   (`architect`, `backend`, …), passing the topic as the panel question (and a
   per-lens `model` if the user asked for one). Keep a map `lens → agentId`.
   Collect each agent's opening position and present the round, facilitated: as
   Pia, frame the topic in a line and **lead with the tensions**, not a tidy
   summary.

2. **Facilitate each turn.** On every user message:
   - If they address a lens (`@architect …` / "architect, …"), `SendMessage` to
     that agent. If they ask the room, message the relevant agents.
   - To create real debate, relay one agent's claim to another and ask for a
     rebuttal (`SendMessage` with the other's point quoted).
   - Present responses in character (`🏛 architect: …`), keep turns tight, and
     **surface disagreement — never manufacture consensus**.
   - Reuse the SAME agentIds every turn so context persists; do not re-spawn.

3. **Stay in the panel** across turns until the user exits.

When you spawn or message an agent, give it just the panel context it needs: the
topic, the other panelists' relevant points, and the user's question. The agent's
character, lens, and grounding rules already live in its `.claude/agents/`
definition — don't re-specify them.

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
