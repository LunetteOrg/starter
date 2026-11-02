## Every wait goes through the mailbox

Nobody watches your terminal: whatever you wait for, ask with `{{ask}} "<…>"`,
which waits for the answer and prints it, never only in your tab. Run it in the
background (or with `--timeout <s>`, then `lntt ask --wait <id>`), so that you re-read
your mailbox between polls.

- **An answer** the issue, the decision records and the code do not give.
- **An approval:** a 1Password prompt for a `git push` or a secret, a go-ahead. Say what
  it unlocks, and retry once it is answered.
- **The review limit:** at `lntt review: limit:` the round sends the open findings
  itself and prints the id of its message; wait for the answer with
  `lntt ask --wait <id>`. An answer that grants rounds is the go: run
  `lntt review allow <rounds>` yourself, then the next round.

While you wait, and before you resume after any pause, re-read your mailbox:
`lntt inbox --as child --issue {{issue}}`. A decision sent there holds over what you
assumed.
