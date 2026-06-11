# ADR-0012: Graceful shutdown for long-lived Node processes

- Status: accepted
- Date: 2026-03-17

## Context

Rolling deploys keep the old container alive until the new one is healthy, then send SIGTERM. Without a handler, in-flight requests are cut off; with keep-alive connections, `server.close()` alone never resolves.

## Decision

Every long-lived Node process implements: **SIGTERM → stop accepting new work → drain in-flight work → cleanup resources → `process.exit(0)`**.

For the HTTP server:

```js
const server = app.listen(3000)
const connections = new Set()
server.on('connection', (conn) => {
  connections.add(conn)
  conn.on('close', () => connections.delete(conn))
})

process.on('SIGTERM', () => {
  server.close(async () => {
    await db.end() // DB pool, queues, …
    process.exit(0)
  })
  setTimeout(() => connections.forEach((c) => c.destroy()), 5000) // drain keep-alive
  setTimeout(() => process.exit(1), 30000) // force exit, matches stop_grace_period
})
```

Compose config: `stop_grace_period: 30s` + an HTTP healthcheck, so the platform only removes the old container from rotation after the new one is healthy.

| Process type | Stop accepting | Drain | Cleanup |
|---|---|---|---|
| HTTP server (RR7, Hono) | `server.close()` | destroy keep-alive after 5s | `db.end()`, pool teardown |
| Job worker (pg-boss) | `worker.close()` | finish current job | release DB/queue connections |

## Consequences

- \+ Zero dropped requests on deploy; the 5s/30s timing chain is explicit and matches the container config.
- − Boilerplate per process type; the worker variant must be written when ADR-0011 is un-deferred.
