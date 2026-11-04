## Every wait goes through the mailbox

Nobody watches your terminal: whatever you wait for, ask with `{{ask}} "<…>"`,
which waits for the answer and prints it, never only in your tab. Run it in the
background (or with `--timeout <s>`, then `pnpm exec lntt ask --wait <id>`), so that you re-read
your mailbox between polls.

- **An answer** the issue, the decision records and the code do not give.
- **An approval:** a 1Password prompt for a `git push` or a secret, a go-ahead. Say what
  it unlocks, and retry once it is answered.
- **The review limit:** at `lntt review: limit:` the round sends the open findings
  itself and prints the id of its message; wait for the answer with
  `pnpm exec lntt ask --wait <id>`. An answer that grants rounds is the go: run
  `pnpm exec lntt review allow <rounds>` yourself, then the next round. Past the last
  allowed round a fix is made only inside a granted round: what is open stays listed as
  open, and a commit waits until `lntt review allow` has granted the round that reviews it.

## Open decisions come before the first commit

Before your first commit, list the open decisions of your issue (what its body leaves
to choose) and ask them in one `{{ask}} "<…>"`, each with a recommendation and the
criteria that decide it. Start coding once it is answered.

A decision that arrives after your review converged, and would change the change, is
asked the same way: apply it in this pull request, or in a follow-up. Applied here, the
new rounds need the person's go: a round does not restart on its own, and past
`delivery.review.maxRounds` the go is `pnpm exec lntt review allow <rounds>` (above).

While you wait, and before you resume after any pause, re-read your mailbox:
`pnpm exec lntt inbox --as child --issue {{issue}}`. A decision sent there holds over what you
assumed.
