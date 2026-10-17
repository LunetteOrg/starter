## Work in phases, with a workflow

Use a workflow (ultracode) for this issue, in three phases:

1. **Understand:** parallel readers over the issue, the decisions it cites, the existing
   code and any prototype it names.
2. **Implement:** **one** writing agent, in this worktree.
3. **Verify:** the review checks and an adversarial pass, in parallel, then the local CI.

At most 6 agents in a workflow: several children run on this machine at once, each with
its own database and test runs. Never `isolation: 'worktree'`: it would nest git worktrees
inside one that the host does not track, and the renamed branch could end up elsewhere.
