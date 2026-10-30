/**
 * Auth routes (plain node:http): /auth/google, /auth/google/callback,
 * /auth/logout, /auth/me. Google OAuth code flow → upsert the user → sign a
 * stateless session JWT into an HttpOnly cookie. `requireUser` reads that cookie.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { eq } from 'drizzle-orm'

import { getDb } from '../db/index.js'
import { users } from '../db/schema.js'
import { isEmailAllowed } from './allowlist.js'
import { buildAuthUrl, exchangeCodeForUser } from './googleOAuth.js'
import { signSession, verifySession, SESSION_TTL_SECONDS, type SessionUser } from './jwt.js'
import {
  clearCookie,
  parseCookies,
  serializeCookie,
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
} from './cookies.js'

export { isEmailAllowed }

/** The authenticated user for this request, or null. Identity is in the JWT. */
export function requireUser(req: IncomingMessage): SessionUser | null {
  const cookies = parseCookies(req)
  const session = verifySession(cookies[SESSION_COOKIE])
  if (!session || !isEmailAllowed(session.email)) return null
  return session
}

function redirect(res: ServerResponse, location: string, setCookies: string[] = []): void {
  if (setCookies.length) res.setHeader('Set-Cookie', setCookies)
  res.writeHead(302, { Location: location })
  res.end()
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export async function handleAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'

  // Start login: set a CSRF state cookie and bounce to Google.
  if (path === '/auth/google' && method === 'GET') {
    const state = randomBytes(16).toString('hex')
    redirect(res, buildAuthUrl(state), [
      serializeCookie(OAUTH_STATE_COOKIE, state, { maxAgeSeconds: 600, sameSite: 'Lax' }),
    ])
    return true
  }

  // OAuth callback.
  if (path === '/auth/google/callback' && method === 'GET') {
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const cookieState = parseCookies(req)[OAUTH_STATE_COOKIE]
    if (!code || !state || !cookieState || state !== cookieState) {
      sendJson(res, 400, { error: 'Invalid OAuth state.' })
      return true
    }
    try {
      const g = await exchangeCodeForUser(code)
      if (!isEmailAllowed(g.email)) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          '<!doctype html><meta charset="utf-8"><title>Access restricted</title>' +
            '<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;text-align:center">' +
            '<h1>🏕 Camp Scout AI</h1><p>This instance is private — your Google account isn\'t on the access list.</p>' +
            '<p><a href="/">Back</a></p></body>',
        )
        return true
      }
      const db = getDb()
      db.insert(users)
        .values({ id: randomUUID(), googleSub: g.sub, email: g.email, name: g.name, picture: g.picture })
        .onConflictDoUpdate({
          target: users.googleSub,
          set: { email: g.email, name: g.name, picture: g.picture },
        })
        .run()
      const row = db.select().from(users).where(eq(users.googleSub, g.sub)).get()
      if (!row) throw new Error('user upsert failed')
      const jwt = signSession({ uid: row.id, email: row.email, name: row.name, picture: row.picture })
      redirect(res, '/', [
        serializeCookie(SESSION_COOKIE, jwt, { maxAgeSeconds: SESSION_TTL_SECONDS }),
        clearCookie(OAUTH_STATE_COOKIE),
      ])
    } catch {
      sendJson(res, 500, { error: 'Sign-in failed.' })
    }
    return true
  }

  if (path === '/auth/logout' && method === 'POST') {
    redirect(res, '/', [clearCookie(SESSION_COOKIE)])
    return true
  }

  if (path === '/auth/me' && method === 'GET') {
    const user = requireUser(req)
    sendJson(res, 200, { user: user ? { email: user.email, name: user.name, picture: user.picture } : null })
    return true
  }

  return false
}
