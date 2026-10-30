/** @jest-environment node */

import { EventEmitter } from 'events'
import { fakeAnswerProvider } from '../openai/fakeAnswerProvider.js'
import {
  API_ACCESS_NOT_CONFIGURED_MESSAGE,
  API_UNAUTHORIZED_MESSAGE,
  CAMP_SCOUT_API_TOKEN_ENV,
  resetRateLimitState,
} from './apiProtection.js'
import {
  ASK_ROUTE_PATH,
  DONATE_ROUTE_PATH,
  HEALTH_ROUTE_PATH,
  METRICS_ROUTE_PATH,
  AI_DASHBOARD_ROUTE_PATH,
  RUNTIME_CONFIG_PATH,
  SUMMARY_ROUTE_PATH,
  createAskRouteMiddleware,
  readJsonRequestBody,
  sendJsonResponse,
} from './askRoute.js'
import { AI_MAINTENANCE_MODE_ENV } from '../ai/aiConfig.js'
import { resetAiUsageStore } from '../ai/aiUsageStore.js'
import { resetAuditLog } from '../ai/aiAuditLog.js'
import { resetAiOperationsState } from '../ai/aiOperations.js'
import {
  INSUFFICIENT_CONTEXT_STATUS,
  SUCCESS_STATUS,
} from '../rag/groundedAnswerGenerator.js'
import { EMPTY_QUESTION_ERROR } from './askHandler.js'
import { DONATIONS_NOT_CONFIGURED_ERROR } from './donateHandler.js'
import { SESSION_COOKIE } from '../auth/cookies.js'
import { signSession } from '../auth/jwt.js'

function createMockResponse() {
  /** @type {{ statusCode?: number, headers: Record<string, string>, body?: string, ended: boolean }} */
  const state = {
    headers: {},
    ended: false,
  }

  const res = {
    set statusCode(value) {
      state.statusCode = value
    },
    get statusCode() {
      return state.statusCode ?? 200
    },
    setHeader(name, value) {
      state.headers[name.toLowerCase()] = value
    },
    end(body) {
      state.body = body
      state.ended = true
    },
  }

  return { res, state }
}

function createMockRequest({
  method = 'POST',
  url = ASK_ROUTE_PATH,
  body = null,
  headers = { authorization: 'Bearer test-api-token' },
}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers
  req.socket = { remoteAddress: '127.0.0.1' }

  queueMicrotask(() => {
    if (body === null) {
      req.emit('end')
      return
    }

    req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })

  return req
}

describe('readJsonRequestBody', () => {
  it('parses JSON request bodies', async () => {
    const req = createMockRequest({ body: { question: 'What are quiet hours?' } })
    await expect(readJsonRequestBody(req)).resolves.toEqual({ question: 'What are quiet hours?' })
  })

  it('returns null for empty bodies', async () => {
    const req = createMockRequest({ body: null })
    await expect(readJsonRequestBody(req)).resolves.toBeNull()
  })
})

describe('createAskRouteMiddleware', () => {
  beforeEach(() => {
    resetRateLimitState()
    resetAiUsageStore()
    resetAuditLog('/tmp/camp-scout-ai-test-audit.jsonl')
    resetAiOperationsState()
    delete process.env[AI_MAINTENANCE_MODE_ENV]
    process.env[CAMP_SCOUT_API_TOKEN_ENV] = 'test-api-token'
  })

  it('handles POST /api/ask on the happy path', async () => {
    const middleware = createAskRouteMiddleware({ answerProvider: fakeAnswerProvider })
    const req = createMockRequest({
      body: {
        question: 'What are the bear food storage rules?',
        campgroundId: 'yosemite-upper-pines',
      },
    })
    const { res, state } = createMockResponse()
    const next = jest.fn()

    await middleware(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(state.statusCode).toBe(200)
    expect(state.headers['content-type']).toBe('application/json; charset=utf-8')

    const payload = JSON.parse(state.body ?? '{}')
    expect(payload.status).toBe(SUCCESS_STATUS)
    expect(payload.answer).toContain('Fake provider answer for:')
    expect(payload.citations.length).toBeGreaterThan(0)
  })

  it('blocks unauthenticated access to /api/ask', async () => {
    const middleware = createAskRouteMiddleware({ answerProvider: fakeAnswerProvider })
    const req = createMockRequest({
      headers: {},
      body: { question: 'What are the bear food storage rules?' },
    })
    const { res, state } = createMockResponse()

    await middleware(req, res, jest.fn())

    expect(state.statusCode).toBe(401)
    const payload = JSON.parse(state.body ?? '{}')
    expect(payload.error).toBe(API_UNAUTHORIZED_MESSAGE)
    expect(payload.correlationId).toBeDefined()
  })

  it('blocks access when the API token is not configured', async () => {
    delete process.env[CAMP_SCOUT_API_TOKEN_ENV]

    const middleware = createAskRouteMiddleware({ answerProvider: fakeAnswerProvider })
    const req = createMockRequest({
      body: { question: 'What are the bear food storage rules?' },
    })
    const { res, state } = createMockResponse()

    await middleware(req, res, jest.fn())

    expect(state.statusCode).toBe(503)
    const payload = JSON.parse(state.body ?? '{}')
    expect(payload.error).toBe(API_ACCESS_NOT_CONFIGURED_MESSAGE)
    expect(payload.correlationId).toBeDefined()
  })

  it('returns a validation error for an empty question', async () => {
    const middleware = createAskRouteMiddleware({ answerProvider: fakeAnswerProvider })
    const req = createMockRequest({ body: { question: '   ' } })
    const { res, state } = createMockResponse()

    await middleware(req, res, jest.fn())

    expect(state.statusCode).toBe(400)
    const payload = JSON.parse(state.body ?? '{}')
    expect(payload.error).toBe(EMPTY_QUESTION_ERROR)
    expect(payload.correlationId).toBeDefined()
  })

  it('returns insufficient_context without crashing', async () => {
    const middleware = createAskRouteMiddleware({ answerProvider: fakeAnswerProvider })
    const req = createMockRequest({ body: { question: 'zzzznonexistenttopicqwerty' } })
    const { res, state } = createMockResponse()

    await middleware(req, res, jest.fn())

    expect(state.statusCode).toBe(200)

    const payload = JSON.parse(state.body ?? '{}')
    expect(payload.status).toBe(INSUFFICIENT_CONTEXT_STATUS)
    expect(payload.citations).toEqual([])
  })

  it('handles POST /api/donate without API token protection', async () => {
    delete process.env.STRIPE_SECRET_KEY
    delete process.env.STRIPE_PRICE_5

    const middleware = createAskRouteMiddleware({ answerProvider: fakeAnswerProvider })
    const req = createMockRequest({
      url: DONATE_ROUTE_PATH,
      headers: {},
      body: { amount: 5 },
    })
    const { res, state } = createMockResponse()

    await middleware(req, res, jest.fn())

    expect(state.statusCode).toBe(503)
    const payload = JSON.parse(state.body ?? '{}')
    expect(payload.error).toBe(DONATIONS_NOT_CONFIGURED_ERROR)
    expect(payload.correlationId).toBeDefined()
  })

  it('returns validation error for invalid donation amount', async () => {
    const middleware = createAskRouteMiddleware({ answerProvider: fakeAnswerProvider })
    const req = createMockRequest({
      url: DONATE_ROUTE_PATH,
      headers: {},
      body: { amount: 15 },
    })
    const { res, state } = createMockResponse()

    await middleware(req, res, jest.fn())

    expect(state.statusCode).toBe(400)
    const payload = JSON.parse(state.body ?? '{}')
    expect(payload.error).toContain('amount')
  })

  it('passes through unrelated routes', async () => {
    const middleware = createAskRouteMiddleware({ answerProvider: fakeAnswerProvider })
    const req = createMockRequest({ url: '/api/other', body: { question: 'ignored' } })
    const { res } = createMockResponse()
    const next = jest.fn()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
  })

  it('handles GET /health', async () => {
    const middleware = createAskRouteMiddleware({ answerProvider: fakeAnswerProvider })
    const req = createMockRequest({ method: 'GET', url: HEALTH_ROUTE_PATH, body: null })
    const { res, state } = createMockResponse()

    await middleware(req, res, jest.fn())

    expect(state.statusCode).toBe(200)
    const payload = JSON.parse(state.body ?? '{}')
    expect(payload.status).toBe('ok')
    expect(payload.correlationId).toBeDefined()
    expect(state.headers['x-correlation-id']).toBeDefined()
  })

  it('handles POST /api/summary on the happy path', async () => {
    const middleware = createAskRouteMiddleware({ answerProvider: fakeAnswerProvider })
    const req = createMockRequest({
      url: SUMMARY_ROUTE_PATH,
      body: { campgroundId: 'yosemite-upper-pines' },
    })
    const { res, state } = createMockResponse()

    await middleware(req, res, jest.fn())

    expect(state.statusCode).toBe(200)

    const payload = JSON.parse(state.body ?? '{}')
    expect(payload.status).toBe(SUCCESS_STATUS)
    expect(payload.sections.overview.length).toBeGreaterThan(0)
    expect(payload.citations.length).toBeGreaterThan(0)
  })

  it('returns maintenance response when AI_MAINTENANCE_MODE is enabled', async () => {
    process.env[AI_MAINTENANCE_MODE_ENV] = 'true'

    const middleware = createAskRouteMiddleware({ answerProvider: fakeAnswerProvider })
    const req = createMockRequest({
      body: { question: 'What are quiet hours?' },
    })
    const { res, state } = createMockResponse()

    await middleware(req, res, jest.fn())

    expect(state.statusCode).toBe(503)
    const payload = JSON.parse(state.body ?? '{}')
    expect(payload.error).toContain('maintenance')
  })

  it('serves Prometheus metrics at GET /metrics', async () => {
    const middleware = createAskRouteMiddleware({ answerProvider: fakeAnswerProvider })
    const req = createMockRequest({ method: 'GET', url: METRICS_ROUTE_PATH, body: null })
    const { res, state } = createMockResponse()

    await middleware(req, res, jest.fn())

    expect(state.statusCode).toBe(200)
    expect(state.headers['content-type']).toContain('text/plain')
    expect(state.body).toContain('ai_requests_total')
  })

  it('serves the AI dashboard at GET /api/ai/dashboard', async () => {
    const middleware = createAskRouteMiddleware({ answerProvider: fakeAnswerProvider })
    const req = createMockRequest({
      method: 'GET',
      url: AI_DASHBOARD_ROUTE_PATH,
      body: null,
    })
    const { res, state } = createMockResponse()

    await middleware(req, res, jest.fn())

    expect(state.statusCode).toBe(200)
    const payload = JSON.parse(state.body ?? '{}')
    expect(payload.spend).toBeDefined()
    expect(payload.monitoring).toBeDefined()
  })
})

describe('sendJsonResponse', () => {
  it('writes JSON responses with the expected content type', () => {
    const { res, state } = createMockResponse()

    sendJsonResponse(res, 201, { ok: true })

    expect(state.statusCode).toBe(201)
    expect(state.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(state.body).toBe('{"ok":true}')
    expect(state.ended).toBe(true)
  })
})

describe('runtime config script (/camp-scout-runtime.js)', () => {
  const TOKEN = 'test-api-token'
  const prevSecret = process.env.SESSION_SECRET
  const prevAllowed = process.env.ALLOWED_EMAILS
  const allowedUser = { uid: 'u1', email: 'steve@example.com', name: 'Steve', picture: null }

  beforeEach(() => {
    process.env[CAMP_SCOUT_API_TOKEN_ENV] = TOKEN
    process.env.SESSION_SECRET = 'test-session-secret-at-least-16'
    process.env.ALLOWED_EMAILS = 'steve@example.com'
  })

  afterAll(() => {
    if (prevSecret === undefined) delete process.env.SESSION_SECRET
    else process.env.SESSION_SECRET = prevSecret
    if (prevAllowed === undefined) delete process.env.ALLOWED_EMAILS
    else process.env.ALLOWED_EMAILS = prevAllowed
  })

  async function fetchRuntime(headers = {}) {
    const middleware = createAskRouteMiddleware({ answerProvider: fakeAnswerProvider })
    const req = createMockRequest({ method: 'GET', url: RUNTIME_CONFIG_PATH, body: null, headers })
    const { res, state } = createMockResponse()
    await middleware(req, res, jest.fn())
    return state
  }

  function parseRuntime(body) {
    const prefix = 'window.__CAMP_SCOUT_RUNTIME__='
    expect(body.startsWith(prefix)).toBe(true)
    return JSON.parse(body.slice(prefix.length, -1))
  }

  it('serves no API token to an anonymous visitor', async () => {
    const state = await fetchRuntime({})

    expect(state.statusCode).toBe(200)
    expect(state.headers['content-type']).toBe('application/javascript; charset=utf-8')
    expect(state.headers['cache-control']).toBe('no-store')
    expect(state.body).not.toContain(TOKEN)
    expect(parseRuntime(state.body)).toEqual({ apiToken: null, user: null })
  })

  it('serves the API token to a signed-in, allow-listed user', async () => {
    const state = await fetchRuntime({ cookie: `${SESSION_COOKIE}=${signSession(allowedUser)}` })

    expect(state.headers['cache-control']).toBe('no-store')
    expect(state.body).toContain(TOKEN)
    expect(parseRuntime(state.body)).toEqual({
      apiToken: TOKEN,
      user: { email: 'steve@example.com', name: 'Steve', picture: null },
    })
  })

  it('serves no API token for a forged/garbage session cookie', async () => {
    const state = await fetchRuntime({ cookie: `${SESSION_COOKIE}=not.a.jwt` })

    expect(state.body).not.toContain(TOKEN)
    expect(parseRuntime(state.body)).toEqual({ apiToken: null, user: null })
  })

  it('serves no API token for a session signed with a different secret', async () => {
    const forged = signSession(allowedUser)
    process.env.SESSION_SECRET = 'a-completely-different-secret-xx'
    const state = await fetchRuntime({ cookie: `${SESSION_COOKIE}=${forged}` })

    expect(state.body).not.toContain(TOKEN)
    expect(parseRuntime(state.body)).toEqual({ apiToken: null, user: null })
  })

  it('serves no API token for an expired session cookie', async () => {
    const expired = signSession(allowedUser, -60)
    const state = await fetchRuntime({ cookie: `${SESSION_COOKIE}=${expired}` })

    expect(state.body).not.toContain(TOKEN)
    expect(parseRuntime(state.body)).toEqual({ apiToken: null, user: null })
  })

  it('serves no API token (and no user) for a valid session whose email is not allow-listed', async () => {
    const outsider = signSession({ uid: 'u2', email: 'stranger@example.com', name: 'X' })
    const state = await fetchRuntime({ cookie: `${SESSION_COOKIE}=${outsider}` })

    expect(state.body).not.toContain(TOKEN)
    expect(parseRuntime(state.body)).toEqual({ apiToken: null, user: null })
  })
})
