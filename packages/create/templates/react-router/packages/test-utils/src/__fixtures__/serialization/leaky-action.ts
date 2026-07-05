// @ts-nocheck — fixture: an action leaking an entity via a nested-object spread,
// wrapped in `data(...)`. The action's return serializes exactly like a loader's.

import { data } from 'react-router'

export async function action({ context }) {
  const user = await context.app.useCases.users.update()
  // BAD: nested object spread still flattens the entity onto the wire.
  return data({ user: { ...user } })
}
