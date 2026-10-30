/**
 * HTTP routes for Camp Scout AI API endpoints.
 * Server-only; wired into Vite dev/preview servers via askApiPlugin.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { sql } from 'drizzle-orm'

import { buildAiDashboard } from '../ai/aiDashboard.js'
import { queryRecentAuditLog } from '../ai/aiAuditLog.js'
import { renderPrometheusMetrics } from '../ai/aiMetrics.js'
import {
  generateReconciliationReport,
  reconciliationReportToCsv,
} from '../ai/aiReconciliation.js'
import {
  checkAiEndpointAccess,
  extractTokenMetricsFromResponse,
  finalizeAiRequest,
  resolveAuthenticatedUser,
  resolveCorrelationId,
  resolveEffectiveProvider,
  setCorrelationIdHeader,
} from '../ai/aiOperations.js'
import type { AnswerProvider } from '../openai/answerProvider.js'
import type { AnswerProviderName } from '../openai/createAnswerProvider.js'
import {
  checkRouteRateLimit,
  resolveClientIp,
  resolveConfiguredApiToken,
  resolveProtectedAnswerProvider,
  validateApiAccess,
  type ApiAccessFailure,
} from './apiProtection.js'
import { handleAskRequest, INVALID_JSON_ERROR } from './askHandler.js'
import { handleDonateRequest } from './donateHandler.js'
import { handleSummaryRequest } from './summaryHandler.js'
import { parseCookies, SESSION_COOKIE } from '../auth/cookies.js'
import { isEmailAllowed } from '../auth/allowlist.js'
import { verifySession } from '../auth/jwt.js'
import { getDb } from '../db/index.js'
import { getWatcherStatus } from '../availability/scheduler.js'
import { evaluateReadiness, type ReadinessResult } from '../health/readiness.js'
import {
  JsonBodyTooLargeError,
  resolveMaxJsonBodyBytes,
} from './requestGuardrails.js'

export const ASK_ROUTE_PATH = '/api/ask'
export const SUMMARY_ROUTE_PATH = '/api/summary'
export const DONATE_ROUTE_PATH = '/api/donate'
export const HEALTH_ROUTE_PATH = '/health'
/** Readiness (DB + watcher); `/health` stays plain liveness. Fly checks both (fly.toml). */
export const HEALTH_READY_ROUTE_PATH = '/health/ready'
export const RUNTIME_CONFIG_PATH = '/camp-scout-runtime.js'
export const METRICS_ROUTE_PATH = '/metrics'
export const AI_DASHBOARD_ROUTE_PATH = '/api/ai/dashboard'
export const AI_AUDIT_ROUTE_PATH = '/api/ai/audit'
export const AI_RECONCILIATION_ROUTE_PATH = '/api/ai/reconciliation'

const PROTECTED_ROUTE_PATHS = new Set([ASK_ROUTE_PATH, SUMMARY_ROUTE_PATH])
const AI_OPS_ROUTE_PATHS = new Set([
  AI_DASHBOARD_ROUTE_PATH,
  AI_AUDIT_ROUTE_PATH,
  AI_RECONCILIATION_ROUTE_PATH,
])

export interface AskRouteMiddlewareOptions {
  answerProvider?: AnswerProvider
  provider?: AnswerProviderName
  reloadOpenAiEnv?: () => void
  skipApiProtection?: boolean
  protectedAccess?: boolean
  persistAudit?: boolean
  /** Override the readiness verdict (tests). Default: real DB + watcher state. */
  readiness?: () => ReadinessResult
}

/** Real readiness: open the DB and run a trivial query; read the in-process watcher state. */
export function evaluateServerReadiness(): ReadinessResult {
  return evaluateReadiness({
    checkDb: () => {
      getDb().get(sql`select 1`)
    },
    watcherEnabled: process.env.WATCHER_ENABLED === 'true',
    watcherStatus: getWatcherStatus,
  })
}

interface SendJsonResponseOptions {
  correlationId?: string
}

export function readJsonRequestBody(req: IncomingMessage, options: { maxBytes?: number } = {}): Promise<unknown> {
  const maxBytes = options.maxBytes ?? resolveMaxJsonBodyBytes()

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0

    req.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      totalBytes += buffer.length

      if (totalBytes > maxBytes) {
        reject(new JsonBodyTooLargeError())
        req.destroy()
        return
      }

      chunks.push(buffer)
    })

    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8').trim()

      if (rawBody.length === 0) {
        resolve(null)
        return
      }

      try {
        resolve(JSON.parse(rawBody))
      } catch (error) {
        reject(error)
      }
    })

    req.on('error', reject)
  })
}

export function sendJsonResponse(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  options: SendJsonResponseOptions = {},
): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')

  if (options.correlationId) {
    setCorrelationIdHeader(res, options.correlationId)
  }

  const payload = options.correlationId && body && typeof body === 'object' && !Array.isArray(body)
    ? { ...body as Record<string, unknown>, correlationId: options.correlationId }
    : body

  res.end(JSON.stringify(payload))
}

export function sendRuntimeConfigScript(req: IncomingMessage, res: ServerResponse): void {
  // The API token is the server's shared secret for the AI + ops routes. Only a
  // signed-in, allow-listed user gets it — the same check as requireUser() /
  // /auth/me. Anonymous visitors only ever see the SignInGate, which needs
  // the runtime object to exist (hasRuntimeConfig) but not the token.
  const verified = verifySession(parseCookies(req)[SESSION_COOKIE])
  const session = verified && isEmailAllowed(verified.email) ? verified : null
  const user = session
    ? { email: session.email, name: session.name, picture: session.picture }
    : null
  const apiToken = session ? (resolveConfiguredApiToken() ?? null) : null

  res.statusCode = 200
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(`window.__CAMP_SCOUT_RUNTIME__=${JSON.stringify({ apiToken, user })};`)
}

function parseOptionalQueryInt(value: string | null): number | undefined {
  if (value === null || value === '') {
    return undefined
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseOptionalQueryFloat(value: string | null): number | undefined {
  if (value === null || value === '') {
    return undefined
  }
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function handleOpsRoutes(req: IncomingMessage, res: ServerResponse, correlationId: string): boolean {
  const pathname = req.url?.split('?')[0] ?? ''

  if (pathname === METRICS_ROUTE_PATH) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendJsonResponse(res, 405, { error: 'Method not allowed. Use GET.' }, { correlationId })
      return true
    }

    // Metrics expose request/token/cost internals — require the API token,
    // like the other AI-ops routes.
    const access = validateApiAccess(req)
    if (!access.ok) {
      const failure = access as ApiAccessFailure
      sendJsonResponse(res, failure.statusCode, failure.body, { correlationId })
      return true
    }

    res.statusCode = 200
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    setCorrelationIdHeader(res, correlationId)
    res.end(renderPrometheusMetrics())
    return true
  }

  if (!AI_OPS_ROUTE_PATHS.has(pathname)) {
    return false
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    sendJsonResponse(res, 405, { error: 'Method not allowed. Use GET.' }, { correlationId })
    return true
  }

  const access = validateApiAccess(req)
  if (!access.ok) {
    const failure = access as ApiAccessFailure
    sendJsonResponse(res, failure.statusCode, failure.body, { correlationId })
    finalizeAiRequest({
      endpoint: pathname,
      correlationId,
      provider: 'none',
      latencyMs: 0,
      clientIp: resolveClientIp(req),
      authenticatedUser: resolveAuthenticatedUser(req),
      responseStatus: failure.statusCode,
      persistAudit: false,
    })
    return true
  }

  if (pathname === AI_DASHBOARD_ROUTE_PATH) {
    sendJsonResponse(res, 200, buildAiDashboard(), { correlationId })
    return true
  }

  if (pathname === AI_AUDIT_ROUTE_PATH) {
    const url = new URL(req.url ?? '', 'http://localhost')
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10)
    sendJsonResponse(res, 200, {
      entries: queryRecentAuditLog(Number.isFinite(limit) ? limit : 50),
    }, { correlationId })
    return true
  }

  if (pathname === AI_RECONCILIATION_ROUTE_PATH) {
    const url = new URL(req.url ?? '', 'http://localhost')
    const format = url.searchParams.get('format')
    const report = generateReconciliationReport({
      openAiReportedRequests: parseOptionalQueryInt(url.searchParams.get('openaiRequests')),
      openAiReportedInputTokens: parseOptionalQueryInt(url.searchParams.get('openaiInputTokens')),
      openAiReportedOutputTokens: parseOptionalQueryInt(url.searchParams.get('openaiOutputTokens')),
      openAiReportedCostUsd: parseOptionalQueryFloat(url.searchParams.get('openaiCostUsd')),
    })

    if (format === 'csv') {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      setCorrelationIdHeader(res, correlationId)
      res.end(reconciliationReportToCsv(report))
      return true
    }

    sendJsonResponse(res, 200, report, { correlationId })
    return true
  }

  return false
}

export function createAskRouteMiddleware(options: AskRouteMiddlewareOptions = {}) {
  return async function apiRouteMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
    const pathname = req.url?.split('?')[0] ?? ''
    const correlationId = resolveCorrelationId(req)
    const startedAt = Date.now()
    const clientIp = resolveClientIp(req)

    if (handleOpsRoutes(req, res, correlationId)) {
      return
    }

    if (pathname === HEALTH_ROUTE_PATH) {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET')
        sendJsonResponse(res, 405, { error: 'Method not allowed. Use GET.' }, { correlationId })
        return
      }

      sendJsonResponse(res, 200, { status: 'ok' }, { correlationId })
      return
    }

    if (pathname === HEALTH_READY_ROUTE_PATH) {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET')
        sendJsonResponse(res, 405, { error: 'Method not allowed. Use GET.' }, { correlationId })
        return
      }

      const verdict = (options.readiness ?? evaluateServerReadiness)()
      res.setHeader('Cache-Control', 'no-store')
      sendJsonResponse(res, verdict.statusCode, verdict.body, { correlationId })
      return
    }

    if (pathname === RUNTIME_CONFIG_PATH) {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET')
        sendJsonResponse(res, 405, { error: 'Method not allowed. Use GET.' }, { correlationId })
        return
      }

      sendRuntimeConfigScript(req, res)
      return
    }

    if (pathname === DONATE_ROUTE_PATH) {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        sendJsonResponse(res, 405, { error: 'Method not allowed. Use POST.' }, { correlationId })
        return
      }

      const donateAccess = checkRouteRateLimit(DONATE_ROUTE_PATH, resolveClientIp(req))
      if (!donateAccess.ok) {
        const failure = donateAccess as ApiAccessFailure
        sendJsonResponse(res, failure.statusCode, failure.body, { correlationId })
        return
      }

      try {
        const body = await readJsonRequestBody(req)
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
        const response = await handleDonateRequest(body, { requestOrigin: origin })
        sendJsonResponse(res, response.statusCode, response.body, { correlationId })
      } catch (error) {
        if (error instanceof JsonBodyTooLargeError) {
          sendJsonResponse(res, 413, { error: error.message }, { correlationId })
          return
        }

        if (error instanceof SyntaxError) {
          sendJsonResponse(res, 400, { error: INVALID_JSON_ERROR }, { correlationId })
          return
        }

        sendJsonResponse(res, 500, { error: 'An unexpected error occurred.' }, { correlationId })
      }
      return
    }

    if (!PROTECTED_ROUTE_PATHS.has(pathname)) {
      next()
      return
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendJsonResponse(res, 405, { error: 'Method not allowed. Use POST.' }, { correlationId })
      return
    }

    if (!options.skipApiProtection) {
      const access = validateApiAccess(req)
      if (!access.ok) {
        const failure = access as ApiAccessFailure
        sendJsonResponse(res, failure.statusCode, failure.body, { correlationId })
        finalizeAiRequest({
          endpoint: pathname,
          correlationId,
          provider: 'none',
          latencyMs: Date.now() - startedAt,
          clientIp,
          authenticatedUser: resolveAuthenticatedUser(req),
          responseStatus: failure.statusCode,
        })
        return
      }

      const rateLimit = checkRouteRateLimit(pathname, clientIp)
      if (!rateLimit.ok) {
        const rateLimitFailure = rateLimit as ApiAccessFailure
        sendJsonResponse(res, rateLimitFailure.statusCode, rateLimitFailure.body, { correlationId })
        finalizeAiRequest({
          endpoint: pathname,
          correlationId,
          provider: 'none',
          latencyMs: Date.now() - startedAt,
          clientIp,
          authenticatedUser: resolveAuthenticatedUser(req),
          responseStatus: rateLimitFailure.statusCode,
        })
        return
      }
    }

    const configuredProvider = options.skipApiProtection
      ? (options.provider ?? 'fake')
      : resolveProtectedAnswerProvider()
    const effectiveProvider = resolveEffectiveProvider(configuredProvider, {
      skipKillSwitch: options.skipApiProtection === true,
    })

    const accessCheck = checkAiEndpointAccess({
      endpoint: pathname,
      correlationId,
      wouldUseOpenAi: effectiveProvider === 'openai',
      skipMaintenanceCheck: options.skipApiProtection === true,
      skipBudgetCheck: options.skipApiProtection === true,
    })

    if (accessCheck.blocked) {
      sendJsonResponse(res, accessCheck.statusCode, accessCheck.body, { correlationId })
      finalizeAiRequest({
        endpoint: pathname,
        correlationId,
        provider: 'fake',
        latencyMs: Date.now() - startedAt,
        clientIp,
        authenticatedUser: resolveAuthenticatedUser(req),
        responseStatus: accessCheck.statusCode,
      })
      return
    }

    try {
      options.reloadOpenAiEnv?.()
      const body = await readJsonRequestBody(req)
      const handlerOptions = {
        ...options,
        provider: effectiveProvider as AnswerProviderName,
        protectedAccess: options.skipApiProtection ? options.protectedAccess === true : true,
      }
      const response =
        pathname === SUMMARY_ROUTE_PATH
          ? await handleSummaryRequest(body, handlerOptions)
          : await handleAskRequest(body, handlerOptions)

      const tokenMetrics = extractTokenMetricsFromResponse(response.body)
      sendJsonResponse(res, response.statusCode, response.body, { correlationId })

      finalizeAiRequest({
        endpoint: pathname,
        correlationId,
        model: tokenMetrics.model,
        provider: effectiveProvider,
        promptTokenEstimate: tokenMetrics.inputTokens,
        completionTokens: tokenMetrics.outputTokens,
        latencyMs: Date.now() - startedAt,
        clientIp,
        authenticatedUser: resolveAuthenticatedUser(req),
        responseStatus: response.statusCode,
        cacheHit: tokenMetrics.cacheHit,
        persistAudit: options.persistAudit !== false,
      })
    } catch (error) {
      if (error instanceof JsonBodyTooLargeError) {
        sendJsonResponse(res, 413, { error: error.message }, { correlationId })
        finalizeAiRequest({
          endpoint: pathname,
          correlationId,
          provider: effectiveProvider,
          latencyMs: Date.now() - startedAt,
          clientIp,
          authenticatedUser: resolveAuthenticatedUser(req),
          responseStatus: 413,
        })
        return
      }

      if (error instanceof SyntaxError) {
        sendJsonResponse(res, 400, { error: INVALID_JSON_ERROR }, { correlationId })
        finalizeAiRequest({
          endpoint: pathname,
          correlationId,
          provider: effectiveProvider,
          latencyMs: Date.now() - startedAt,
          clientIp,
          authenticatedUser: resolveAuthenticatedUser(req),
          responseStatus: 400,
        })
        return
      }

      sendJsonResponse(res, 500, { error: 'An unexpected error occurred.' }, { correlationId })
      finalizeAiRequest({
        endpoint: pathname,
        correlationId,
        provider: effectiveProvider,
        latencyMs: Date.now() - startedAt,
        clientIp,
        authenticatedUser: resolveAuthenticatedUser(req),
        responseStatus: 500,
      })
    }
  }
}
