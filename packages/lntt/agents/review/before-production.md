## Before production

This project has not reached production (`project.phase` is `development`): no release
has users, data or links to keep yet. Until it does, what only protects those is not a
finding: a reviewer does not report it, and a verifier refutes a finding that asks for it,
citing this section.

**Not a finding yet:**

- **Migrations against existing data:** dropping tables or columns, rewriting stored
  data, regenerating the migrations from scratch. There is no data to keep.
- **Redirects for changed routes:** a route, URL or endpoint renamed or removed without a
  redirect. Nobody has bookmarked it.
- **Backward compatibility:** a changed API, format or configuration with no shim, no
  deprecation and no support for the old shape. Nothing outside the project depends on it.
- **The size of a rewrite:** a wide change that gets the design right. There are no users
  to protect from churn.

**Findings anyway:**

- **Security:** a secret in the code, an unchecked input, a missing authorization check,
  a dependency with a known vulnerability.
- **Tests:** behaviour with no test that would catch it wrong, a test that cannot fail.
- **The decision records:** a change that contradicts an accepted record, or a decision
  that no record covers. A record of the project that asks for one of the items above
  (say, no unexplained `DROP` in a migration) still holds: a change against it is a
  finding.
- **Correctness:** code that does the wrong thing now, whatever the phase.
