/** @jest-environment node */

/**
 * End to end through the real route with AI_PROVIDER=gemini: the provider is built from the
 * environment (no injected provider), auth and Vertex both go through a mocked global fetch.
 * These prove the money guards still bite on the Gemini path: the request is priced at Gemini
 * rates (thinking tokens included), the daily budget blocks it, and quota 429s read as quota.
 */

import { EventEmitter } from 'events'
import { generateKeyPairSync } from 'crypto'
import fs from 'fs'
import path from 'path'
import { resetRateLimitState, CAMP_SCOUT_API_TOKEN_ENV } from './apiProtection.js'
import { ASK_ROUTE_PATH, SUMMARY_ROUTE_PATH, createAskRouteMiddleware } from './askRoute.js'
import { estimateRequestCost } from '../ai/aiCostCalculator.js'
import { getAllRecords, recordAiRequest, buildRequestRecord, resetAiUsageStore } from '../ai/aiUsageStore.js'
import { resetAuditLog } from '../ai/aiAuditLog.js'
import { resetAiOperationsState } from '../ai/aiOperations.js'
import { resetBudgetLogState } from '../ai/aiBudget.js'
import { __resetGoogleTokenCacheForTests } from '../openai/googleServiceAccountAuth.js'
import { OPENAI_QUOTA_EXCEEDED_MESSAGE } from '../openai/mapOpenAiHttpError.js'
import { clearSummaryCache } from '../rag/campgroundSummaryCache.js'
import { __resetSummariesForTests } from '../db/summaryRepository.js'

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'openai', '__fixtures__', 'vertex-generateContent-gemini.json'), 'utf8'),
)

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const ENV = {
  AI_ENABLED: 'true',
  OPENAI_ANSWER_PROVIDER: 'openai',
  AI_PROVIDER: 'gemini',
  GOOGLE_CLOUD_PROJECT: 'example-project',
  VERTEX_LOCATION: 'global',
  GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({
    type: 'service_account',
    client_email: 'campscout-test@example-project.iam.gserviceaccount.com',
    private_key: privateKey,
  }),
}
const EXTRA_KEYS = ['AI_DAILY_BUDGET_USD', 'GEMINI_MODEL', 'OPENAI_MODEL']
const snapshot = {}
const originalFetch = global.fetch

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function mockGoogle(vertexResponse) {
  const fetchMock = jest.fn(async (url) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return jsonResponse(200, { access_token: 'ya29.route-test', expires_in: 3599, token_type: 'Bearer' })
    }
    if (String(url).startsWith('https://aiplatform.googleapis.com/')) {
      return vertexResponse
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  global.fetch = fetchMock
  return fetchMock
}

function vertexCalls(fetchMock) {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('aiplatform.googleapis.com'))
}

function createMockRequest(body, url = ASK_ROUTE_PATH) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = url
  req.headers = { authorization: 'Bearer test-api-token' }
  req.socket = { remoteAddress: '127.0.0.1' }
  queueMicrotask(() => {
    req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
  return req
}

function createMockResponse() {
  const state = { headers: {}, statusCode: 200 }
  const res = {
    set statusCode(value) { state.statusCode = value },
    get statusCode() { return state.statusCode },
    setHeader(name, value) { state.headers[name.toLowerCase()] = value },
    end(body) { state.body = body },
  }
  return { res, state }
}

async function ask() {
  const middleware = createAskRouteMiddleware({ persistAudit: false })
  const { res, state } = createMockResponse()
  await middleware(
    createMockRequest({ question: 'What are the bear food storage rules?', campgroundId: 'yosemite-upper-pines' }),
    res,
    jest.fn(),
  )
  return { statusCode: state.statusCode, payload: JSON.parse(state.body ?? '{}') }
}

beforeEach(() => {
  for (const key of [...Object.keys(ENV), ...EXTRA_KEYS]) snapshot[key] = process.env[key]
  Object.assign(process.env, ENV)
  for (const key of EXTRA_KEYS) delete process.env[key]
  process.env[CAMP_SCOUT_API_TOKEN_ENV] = 'test-api-token'
  resetRateLimitState()
  resetAiUsageStore()
  resetAuditLog('/tmp/camp-scout-ai-test-audit.jsonl')
  resetAiOperationsState()
  resetBudgetLogState()
  __resetGoogleTokenCacheForTests()
  // Summaries are cached in memory AND in SQLite; a cached success would skip the provider call.
  clearSummaryCache()
  __resetSummariesForTests()
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  for (const key of Object.keys(snapshot)) {
    if (snapshot[key] === undefined) delete process.env[key]
    else process.env[key] = snapshot[key]
  }
  global.fetch = originalFetch
  jest.restoreAllMocks()
})

describe('/api/ask with AI_PROVIDER=gemini', () => {
  it('answers through Vertex and records the request priced at Gemini rates, thinking included', async () => {
    const fetchMock = mockGoogle(jsonResponse(200, FIXTURE))

    const { statusCode, payload } = await ask()

    expect(statusCode).toBe(200)
    expect(payload.answer).toContain('bear box')
    expect(vertexCalls(fetchMock)).toHaveLength(1)

    const records = getAllRecords()
    expect(records).toHaveLength(1)
    const [record] = records
    expect(record.model).toBe('gemini-3.8-flash')
    expect(record.promptTokenEstimate).toBe(14)
    expect(record.completionTokens).toBe(5 + 18)
    // Gemini rate, not $0 (fake) and not the gpt-4o-mini rate.
    const expected = estimateRequestCost(14, 23, 'gemini-3.8-flash')
    expect(record.estimatedCostUsd).toBeCloseTo(expected, 12)
    expect(record.estimatedCostUsd).toBeGreaterThan(estimateRequestCost(14, 23, 'gpt-4o-mini'))
  })

  it('is blocked by the daily budget before any Vertex call once the budget is spent', async () => {
    process.env.AI_DAILY_BUDGET_USD = '0.01'
    recordAiRequest(buildRequestRecord({
      endpoint: '/api/ask',
      requestId: 'earlier',
      correlationId: 'earlier',
      model: 'gemini-3.8-flash',
      provider: 'openai',
      promptTokenEstimate: 10_000,
      completionTokens: 10_000,
      latencyMs: 10,
      clientIp: '127.0.0.1',
      responseStatus: 200,
    }))
    const fetchMock = mockGoogle(jsonResponse(200, FIXTURE))

    const { statusCode, payload } = await ask()

    expect(statusCode).toBe(503)
    expect(payload.error).toContain('budget')
    expect(vertexCalls(fetchMock)).toHaveLength(0)
  })

  it('answers a Vertex 429 RESOURCE_EXHAUSTED with the same 503 quota message as OpenAI', async () => {
    mockGoogle(jsonResponse(429, {
      error: { code: 429, message: 'Resource exhausted. Please try again later.', status: 'RESOURCE_EXHAUSTED' },
    }))

    const { statusCode, payload } = await ask()

    expect(statusCode).toBe(503)
    expect(payload.error).toBe(OPENAI_QUOTA_EXCEEDED_MESSAGE)
  })

  it('answers 503 "not available" without calling Google when the Gemini config is missing', async () => {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
    const fetchMock = mockGoogle(jsonResponse(200, FIXTURE))

    const { statusCode, payload } = await ask()

    expect(statusCode).toBe(503)
    expect(payload.error).toBe('Answer generation is not available.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('makes no Google call at all when OPENAI_ANSWER_PROVIDER=fake', async () => {
    process.env.OPENAI_ANSWER_PROVIDER = 'fake'
    const fetchMock = mockGoogle(jsonResponse(200, FIXTURE))

    const { statusCode, payload } = await ask()

    expect(statusCode).toBe(200)
    expect(payload.answer).toContain('Fake provider answer for:')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('/api/summary with AI_PROVIDER=gemini', () => {
  it('builds the summary sections from a Gemini answer and prices it at Gemini rates', async () => {
    // Same captured envelope; the text is the `## Section` format the summary prompt asks for.
    const summaryText = [
      '## Overview', 'A pine-shaded valley campground [1].',
      '## Amenities', 'Flush toilets and potable water [1].',
      '## Restrictions', 'Food must go in bear boxes [1].',
      '## Reservations', 'Reserve on Recreation.gov [1].',
      '## Highlights', 'Walking distance to the valley floor [1].',
    ].join('\n')
    const payload = {
      ...FIXTURE,
      candidates: [{ ...FIXTURE.candidates[0], content: { role: 'model', parts: [{ text: summaryText }] } }],
    }
    const fetchMock = mockGoogle(jsonResponse(200, payload))

    const middleware = createAskRouteMiddleware({ persistAudit: false })
    const { res, state } = createMockResponse()
    await middleware(createMockRequest({ campgroundId: 'yosemite-upper-pines' }, SUMMARY_ROUTE_PATH), res, jest.fn())
    const body = JSON.parse(state.body ?? '{}')

    expect(state.statusCode).toBe(200)
    expect(vertexCalls(fetchMock)).toHaveLength(1)
    expect(body.sections.overview).toContain('pine-shaded')
    expect(body.sections.restrictions).toContain('bear boxes')

    const [record] = getAllRecords()
    expect(record.model).toBe('gemini-3.8-flash')
    expect(record.completionTokens).toBe(23)
    expect(record.estimatedCostUsd).toBeCloseTo(estimateRequestCost(14, 23, 'gemini-3.8-flash'), 12)
  })
})

describe('a billed Gemini call that returns no answer text', () => {
  // Thinking used the whole output budget: Vertex answers 200, bills prompt + thoughts, returns no
  // text. Usage shape = the captured envelope's keys; the counts are Tier 2's measured case.
  const maxTokensNoText = {
    candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MAX_TOKENS' }],
    usageMetadata: { promptTokenCount: 2400, thoughtsTokenCount: 1824, totalTokenCount: 4224, trafficType: 'ON_DEMAND' },
    modelVersion: 'gemini-3.8-flash',
    createTime: '2026-09-05T22:02:04.552985Z',
    responseId: 'XJGcapngIfyEm9IPhdLfyQg',
  }

  it('is recorded at its real cost (prompt + thinking) even though the user gets an error', async () => {
    mockGoogle(jsonResponse(200, maxTokensNoText))

    const { statusCode, payload } = await ask()

    expect(statusCode).toBe(502)
    // The usage rides outside the client-facing body.
    for (const key of ['billedUsage', 'inputTokens', 'outputTokens', 'model']) {
      expect(payload).not.toHaveProperty(key)
    }

    const [record] = getAllRecords()
    expect(record.model).toBe('gemini-3.8-flash')
    expect(record.promptTokenEstimate).toBe(2400)
    expect(record.completionTokens).toBe(1824)
    expect(record.estimatedCostUsd).toBeCloseTo(estimateRequestCost(2400, 1824, 'gemini-3.8-flash'), 12)
    expect(record.estimatedCostUsd).toBeGreaterThan(0)
  })

  it('counts against the daily budget, so the next request is blocked before reaching Vertex', async () => {
    // One such call costs ~$0.0086; the budget is below that.
    process.env.AI_DAILY_BUDGET_USD = '0.005'
    const fetchMock = mockGoogle(jsonResponse(200, maxTokensNoText))

    const first = await ask()
    expect(first.statusCode).toBe(502)
    expect(vertexCalls(fetchMock)).toHaveLength(1)

    const second = await ask()
    expect(second.statusCode).toBe(503)
    expect(second.payload.error).toContain('budget')
    expect(vertexCalls(fetchMock)).toHaveLength(1)
  })

  it('is recorded at its real cost on /api/summary too', async () => {
    mockGoogle(jsonResponse(200, maxTokensNoText))

    const middleware = createAskRouteMiddleware({ persistAudit: false })
    const { res, state } = createMockResponse()
    await middleware(createMockRequest({ campgroundId: 'yosemite-upper-pines' }, SUMMARY_ROUTE_PATH), res, jest.fn())

    expect(state.statusCode).toBe(502)
    const [record] = getAllRecords()
    expect(record.estimatedCostUsd).toBeCloseTo(estimateRequestCost(2400, 1824, 'gemini-3.8-flash'), 12)
  })
})
