import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The app's `signIn.test`: asks for a code, reads it in the server log (docs/process/local.md),
// trades it for a session and saves the state for the checks that follow.
test('sign in and save the state', async ({ request }) => {
  const { APP_ORIGIN: origin, SIGN_IN_AS: login, LOG_FILE: logFile, STATE_FILE: stateFile } = process.env
  if (!origin || !login || !logFile || !stateFile) {
    throw new Error('sign-in needs APP_ORIGIN, SIGN_IN_AS, LOG_FILE and STATE_FILE')
  }
  const headers = { origin }
  expect((await request.post(`${origin}/sign-in`, { headers, data: { login } })).status()).toBe(202)
  const codes = [
    ...readFileSync(logFile, 'utf8').matchAll(new RegExp(`one-time code for ${escapeRegExp(login)}: (\\d{6})`, 'g')),
  ]
  const code = codes.at(-1)?.[1]
  expect(code, 'no code in the log').toBeTruthy()
  expect((await request.post(`${origin}/verify`, { headers, data: { login, code } })).status()).toBe(204)
  await request.storageState({ path: stateFile })
})
