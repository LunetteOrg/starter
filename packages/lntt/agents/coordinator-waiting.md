**Every wait goes through the mailbox,** yours and your children's. A child's question,
  an approval it waits on (a 1Password prompt included) and its review limit
  (`lntt review: limit:` sends the open findings) reach you in
  `pnpm exec lntt inbox --as coordinator --theme {{theme}}`. What you cannot settle goes on to
  `pnpm exec lntt ask --to orchestrator`, batched, with a recommendation; your own waits, an
  approval included, go the same way. A child that waits re-reads its mailbox, so an
  answer for it goes there (`pnpm exec lntt answer <id>`, or `pnpm exec lntt ask --to child --issue <n>`),
  never typed into its tab. The open decisions your children ask before their first
  commit are collected and sent to the orchestrator in one batch, each with a
  recommendation, before the children code.
