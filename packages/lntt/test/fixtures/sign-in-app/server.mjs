// A sign-in in three requests, with no password anywhere: POST /sign-in writes a
// one-time code to the log, POST /verify trades it for a session cookie, GET /private
// needs that cookie. The seeded logins arrive in `USERS`, set in the app's `env` in the
// configuration beside `users`, and the cookie is named after the port: localhost
// cookies do not isolate ports.
import { randomBytes, randomInt } from 'node:crypto'
import { createServer } from 'node:http'

const origin = process.env.APP_ORIGIN
const port = Number(process.env.PORT)
const users = new Set(process.env.USERS?.split(',').filter(Boolean))
if (!origin || !port || users.size === 0) {
  console.error('server.mjs needs APP_ORIGIN, PORT and USERS')
  process.exit(1)
}
const cookieName = `session-${port}`
const codes = new Map()
const sessions = new Map()

const readJson = async (req) => {
  let text = ''
  for await (const chunk of req) text += chunk
  try {
    const body = text ? JSON.parse(text) : {}
    return body !== null && typeof body === 'object' ? body : {}
  } catch {
    return {}
  }
}

createServer(async (req, res) => {
  const send = (status, body = '', headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/html', ...headers })
    res.end(body)
  }
  if (req.method === 'GET' && req.url === '/') return send(200, '<h1>Sign in</h1>')
  if (req.method === 'GET' && req.url === '/private') {
    const token = req.headers.cookie?.match(new RegExp(`(?:^|; )${cookieName}=([^;]+)`))?.[1]
    const login = token && sessions.get(token)
    return login ? send(200, `<h1>Signed in as ${login}</h1>`) : send(401, '<h1>Not signed in</h1>')
  }
  if (req.method !== 'POST') return send(404)
  if (req.headers.origin !== origin) return send(403)
  const { login, code } = await readJson(req)
  if (req.url === '/sign-in') {
    if (!users.has(login)) return send(404)
    const fresh = String(randomInt(100000, 1000000))
    codes.set(login, fresh)
    console.log(`one-time code for ${login}: ${fresh}`)
    return send(202)
  }
  if (req.url === '/verify') {
    if (typeof code !== 'string' || !codes.has(login) || codes.get(login) !== code) return send(401)
    codes.delete(login)
    const token = randomBytes(16).toString('hex')
    sessions.set(token, login)
    return send(204, '', { 'set-cookie': `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax` })
  }
  return send(404)
}).listen(port, () => console.log(`listening on ${origin}`))
