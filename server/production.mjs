/**
 * Production HTTP server for Camp Scout AI.
 * Serves the built SPA, API routes, and a health check for load balancers.
 */

import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAskRouteMiddleware } from '../src/server/api/askRoute.js'
import { handleAuthRoutes } from '../src/server/auth/authRoutes.js'
import { handleCampgroundMediaRoutes } from '../src/server/campgrounds/campgroundMediaRoute.js'
import { handleSmsStatusRoute } from '../src/server/notifications/smsStatusRoute.js'
import { handleWatchRoutes } from '../src/server/api/watchRoute.js'
import { startWatchScheduler } from '../src/server/availability/scheduler.js'
import { getDb } from '../src/server/db/index.js'
import { setSecurityHeaders } from '../src/server/securityHeaders.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const STATIC_ROOT = join(__dirname, '../dist')
const PORT = Number(process.env.PORT) || 8080

/** @type {Record<string, string>} */
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const apiMiddleware = createAskRouteMiddleware()

/**
 * Resolves a request path to a file under STATIC_ROOT, blocking traversal.
 * @param {string} requestPath
 * @returns {string | null}
 */
function resolveStaticPath(requestPath) {
  const pathname = decodeURIComponent(requestPath.split('?')[0] || '/')
  const relativePath = pathname === '/' ? '/index.html' : pathname
  const resolvedPath = join(STATIC_ROOT, relativePath)
  const normalizedRoot = join(STATIC_ROOT, '/')

  if (!resolvedPath.startsWith(normalizedRoot)) {
    return null
  }

  return resolvedPath
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} filePath
 */
function sendStaticFile(res, filePath) {
  const extension = extname(filePath).toLowerCase()
  const contentType = MIME_TYPES[extension] ?? 'application/octet-stream'

  res.statusCode = 200
  res.setHeader('Content-Type', contentType)
  createReadStream(filePath).pipe(res)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function serveStaticOrSpa(req, res) {
  let filePath
  try {
    filePath = resolveStaticPath(req.url ?? '/')
  } catch {
    // Malformed percent-encoding in the URL (e.g. "/foo%") throws URIError —
    // respond 400 instead of crashing the request handler.
    res.statusCode = 400
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: 'Malformed request URL.' }))
    return
  }

  if (filePath && existsSync(filePath) && statSync(filePath).isFile()) {
    sendStaticFile(res, filePath)
    return
  }

  const indexPath = join(STATIC_ROOT, 'index.html')

  if (existsSync(indexPath)) {
    sendStaticFile(res, indexPath)
    return
  }

  res.statusCode = 503
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ error: 'Application is not built yet.' }))
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
function runApiMiddleware(req, res) {
  return new Promise((resolve) => {
    apiMiddleware(req, res, resolve)
  })
}

const server = createServer(async (req, res) => {
  setSecurityHeaders(res)

  // Auth routes: /auth/google, /auth/google/callback, /auth/logout, /auth/me.
  if (await handleAuthRoutes(req, res)) {
    return
  }

  // Official campground photos (RIDB), session-gated, no DB.
  if (await handleCampgroundMediaRoutes(req, res)) {
    return
  }

  // SMS delivery-status diagnostic.
  if (await handleSmsStatusRoute(req, res)) {
    return
  }

  // Availability-watch API (per-user session auth + lazy DB inside).
  if (await handleWatchRoutes(req, res)) {
    return
  }

  await runApiMiddleware(req, res)

  if (res.writableEnded) {
    return
  }

  serveStaticOrSpa(req, res)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Camp Scout AI listening on http://0.0.0.0:${PORT}`)

  // Availability watcher: only in prod (WATCHER_ENABLED), started AFTER the
  // HTTP server binds so the health check is never starved. In-process because
  // SQLite is single-writer / single-machine.
  if (process.env.WATCHER_ENABLED === 'true') {
    try {
      startWatchScheduler(getDb(), {
        defaultPollIntervalSeconds: Number(process.env.WATCH_POLL_INTERVAL_SECONDS) || 300,
        logger: (msg, extra) =>
          console.log(JSON.stringify({ scope: 'watcher', msg, ...(extra ?? {}) })),
      })
    } catch (err) {
      console.error('watch scheduler failed to start:', err)
    }
  }
})
