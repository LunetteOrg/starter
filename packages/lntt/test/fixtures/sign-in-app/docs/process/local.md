# Running the app locally

## app

Sign in: `signIn.test` asks for a one-time code for a seeded user (`SIGN_IN_AS`) and
reads it from the server's log (`LOG_FILE`, the file the start command's output goes
to): the line is `one-time code for <login>: <six digits>`. A code works once, and a
new request replaces the last one, so read the last line. The state is saved at
`STATE_FILE`.

The session cookie is named `session-<port>` because cookies of `localhost` are shared
by every port: two instances running at once keep two cookies side by side.
