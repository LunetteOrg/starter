// @ts-nocheck — fixture: a loader that over-serializes by spreading the entity.
// This is footgun #1 (ADR-0002 — loader/action serialization boundary): every
// column of `user` (passwordHash, tokens, internal flags) ships to the browser.

export async function loader({ context }) {
  const user = await context.app.useCases.users.getCurrent()
  // BAD: spreads the whole entity into the returned (serialized) payload.
  return { ...user, greeting: 'hi' }
}
