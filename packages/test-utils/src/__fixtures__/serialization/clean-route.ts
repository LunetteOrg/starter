// @ts-nocheck — fixture: the correct shape. Explicit, flat read-view literals;
// spreads that are NOT in a returned object (array spread, header merge) must
// NOT be flagged.

import { data } from 'react-router'

export async function loader({ request, context }) {
  const user = await context.app.useCases.users.getCurrent()
  const tags = await context.app.useCases.users.tags()

  // OK: array spread outside object property position.
  const allTags = [...tags, 'default']

  // OK: header merge in a non-return object literal.
  const headers = { ...defaultHeaders, 'x-app': '1' }

  // OK: explicit, flat read-view — only the fields the UI needs.
  return data(
    { id: user.id, email: user.email, tags: allTags },
    { headers },
  )
}

export async function action({ context }) {
  const user = await context.app.useCases.users.update()
  // OK: explicit projection, no spread.
  return { id: user.id, email: user.email }
}
