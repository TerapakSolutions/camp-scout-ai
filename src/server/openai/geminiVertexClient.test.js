/** @jest-environment node */

/**
 * Gemini over Vertex `generateContent`, with a mocked fetch: no network, no real credentials.
 *
 * FIXTURE PROVENANCE (`__fixtures__/vertex-generateContent-gemini.json`): copied from Lookout's real
 * captured Vertex 200 (search-intelligence-service `vertex-generateContent-2026-09-05.json`,
 * gemini-2.5-flash, us-central1). REAL: the envelope (`candidates[].content.parts[]`, `finishReason`,
 * `avgLogprobs`), the `usageMetadata` key layout, `promptTokenCount` 14, `candidatesTokenCount` 5,
 * `trafficType`, `createTime`, `responseId`. CHANGED BY HAND: the answer text (a campground answer),
 * `modelVersion` (gemini-2.5-flash → gemini-3.8-flash), and `thoughtsTokenCount: 18` with
 * `totalTokenCount` 19 → 37. The 18 thinking tokens mirror trend-tagger's live Vertex measurement
 * (2026-08-17: 7 prompt + 1 candidate, total 26, the missing 18 were `thoughtsTokenCount`).
 */

import fs from 'fs'
import path from 'path'
import { MissingGeminiConfigError, MissingOpenAiApiKeyError, OpenAiResponseError } from './errors.js'
import {
  GEMINI_THINKING_HEADROOM_TOKENS,
  GEMINI_THINKING_LEVEL,
  createGeminiAnswerProvider,
  vertexGenerateContentUrl,
} from './geminiVertexClient.js'
import { mapOpenAiErrorToHttpResponse, OPENAI_QUOTA_EXCEEDED_MESSAGE } from './mapOpenAiHttpError.js'

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '__fixtures__', 'vertex-generateContent-gemini.json'), 'utf8'),
)

const FAKE_TOKEN = 'ya29.fake-access-token-for-tests'
const FAKE_SA_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'campscout-test@example-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
})

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  }
}

function buildProvider(overrides = {}) {
  const fetchImpl = overrides.fetchImpl ?? jest.fn().mockResolvedValue(jsonResponse(200, FIXTURE))
  const getAccessToken = overrides.getAccessToken ?? jest.fn().mockResolvedValue(FAKE_TOKEN)
  const provider = createGeminiAnswerProvider({
    project: 'example-project',
    location: 'global',
    credentialsJson: FAKE_SA_JSON,
    fetchImpl,
    getAccessToken,
    ...overrides,
  })
  return { provider, fetchImpl, getAccessToken }
}

describe('vertexGenerateContentUrl', () => {
  it('serves global from aiplatform.googleapis.com, with no region prefix on the host', () => {
    expect(vertexGenerateContentUrl('p1', 'global', 'gemini-3.8-flash')).toBe(
      'https://aiplatform.googleapis.com/v1/projects/p1/locations/global/publishers/google/models/gemini-3.8-flash:generateContent',
    )
  })

  it('prefixes the host with a regional location', () => {
    expect(vertexGenerateContentUrl('p1', 'US-Central1', 'gemini-3.8-flash')).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/p1/locations/us-central1/publishers/google/models/gemini-3.8-flash:generateContent',
    )
  })
})

describe('createGeminiAnswerProvider', () => {
  const ENV_KEYS = ['GEMINI_MODEL', 'GOOGLE_CLOUD_PROJECT', 'VERTEX_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS_JSON']
  const snapshot = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) snapshot[key] = process.env[key]
    for (const key of ENV_KEYS) delete process.env[key]
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (snapshot[key] === undefined) delete process.env[key]
      else process.env[key] = snapshot[key]
    }
    jest.restoreAllMocks()
  })

  it('is named gemini', () => {
    expect(buildProvider().provider.name).toBe('gemini')
  })

  it('sends the native generateContent body: systemInstruction, maxOutputTokens with thinking headroom, thinkingLevel LOW', async () => {
    const { provider, fetchImpl } = buildProvider()

    await provider.generateAnswer({
      instructions: '  Answer only from the sources.  ',
      input: '  Where do I store food?  ',
      maxOutputTokens: 800,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(
      'https://aiplatform.googleapis.com/v1/projects/example-project/locations/global/publishers/google/models/gemini-3.8-flash:generateContent',
    )
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`)
    expect(init.headers['Content-Type']).toBe('application/json')

    expect(GEMINI_THINKING_LEVEL).toBe('LOW')
    expect(JSON.parse(init.body)).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'Where do I store food?' }] }],
      systemInstruction: { parts: [{ text: 'Answer only from the sources.' }] },
      generationConfig: {
        maxOutputTokens: 800 + GEMINI_THINKING_HEADROOM_TOKENS,
        thinkingConfig: { thinkingLevel: 'LOW' },
      },
    })
  })

  it('omits systemInstruction when there are no instructions, and sends no temperature or thinkingBudget', async () => {
    const { provider, fetchImpl } = buildProvider()
    await provider.generateAnswer({ input: 'Hello' })
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.systemInstruction).toBeUndefined()
    expect(body.generationConfig.temperature).toBeUndefined()
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBeUndefined()
  })

  it('uses GEMINI_MODEL from the environment', async () => {
    process.env.GEMINI_MODEL = 'gemini-3.8-flash-001'
    const { provider, fetchImpl } = buildProvider()
    await provider.generateAnswer({ input: 'Hello' })
    expect(fetchImpl.mock.calls[0][0]).toContain('/models/gemini-3.8-flash-001:generateContent')
  })

  it('returns the answer, the model, and counts THINKING tokens as output', async () => {
    const { provider } = buildProvider()
    const result = await provider.generateAnswer({ input: 'Where do I store food?' })

    expect(result).toEqual({
      text: 'Store all food in the bear box at your site [1].',
      model: 'gemini-3.8-flash',
      inputTokens: 14,
      // candidatesTokenCount 5 + thoughtsTokenCount 18: Google bills thoughts at the output rate.
      outputTokens: 23,
      responseId: 'XJGcapngIfyEm9IPhdLfyQg',
    })
  })

  it('joins every non-thought text part, not just parts[0]', async () => {
    const payload = {
      ...FIXTURE,
      candidates: [{
        ...FIXTURE.candidates[0],
        content: {
          role: 'model',
          parts: [
            { text: 'internal reasoning', thought: true },
            { text: 'Store food ' },
            { text: 'in the bear box.' },
          ],
        },
      }],
    }
    const { provider } = buildProvider({ fetchImpl: jest.fn().mockResolvedValue(jsonResponse(200, payload)) })
    const result = await provider.generateAnswer({ input: 'Hello' })
    expect(result.text).toBe('Store food in the bear box.')
  })

  it('counts output from thoughts alone when candidatesTokenCount is absent', async () => {
    const payload = { ...FIXTURE, usageMetadata: { promptTokenCount: 3, thoughtsTokenCount: 9 } }
    const { provider } = buildProvider({ fetchImpl: jest.fn().mockResolvedValue(jsonResponse(200, payload)) })
    const result = await provider.generateAnswer({ input: 'Hello' })
    expect(result.outputTokens).toBe(9)
  })

  it('maps a Vertex 429 RESOURCE_EXHAUSTED to the same 503 quota response an OpenAI quota 429 gives', async () => {
    const vertex429 = {
      error: {
        code: 429,
        message: 'Resource exhausted. Please try again later.',
        status: 'RESOURCE_EXHAUSTED',
      },
    }
    const { provider } = buildProvider({ fetchImpl: jest.fn().mockResolvedValue(jsonResponse(429, vertex429)) })

    const error = await provider.generateAnswer({ input: 'Hello' }).catch((caught) => caught)
    expect(error).toBeInstanceOf(OpenAiResponseError)
    expect(error.status).toBe(429)
    expect(error.errorCode).toBe('RESOURCE_EXHAUSTED')

    const mapped = mapOpenAiErrorToHttpResponse(error, {
      scope: 'test.vertex429',
      unavailableMessage: 'Not available.',
      failedMessage: 'Failed.',
    })
    expect(mapped).toEqual({ statusCode: 503, body: { error: OPENAI_QUOTA_EXCEEDED_MESSAGE } })
  })

  it('maps other Vertex HTTP errors to 502 failed', async () => {
    const vertex400 = { error: { code: 400, message: 'Bad thinking level', status: 'INVALID_ARGUMENT' } }
    const { provider } = buildProvider({ fetchImpl: jest.fn().mockResolvedValue(jsonResponse(400, vertex400)) })
    const error = await provider.generateAnswer({ input: 'Hello' }).catch((caught) => caught)
    expect(error).toBeInstanceOf(OpenAiResponseError)
    expect(error.errorCode).toBe('INVALID_ARGUMENT')
    const mapped = mapOpenAiErrorToHttpResponse(error, {
      scope: 'test.vertex400', unavailableMessage: 'Not available.', failedMessage: 'Failed.',
    })
    expect(mapped.statusCode).toBe(502)
  })

  it('reports an empty answer that ran out of output budget (MAX_TOKENS) as a failed request', async () => {
    const payload = {
      ...FIXTURE,
      candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MAX_TOKENS' }],
    }
    const { provider } = buildProvider({ fetchImpl: jest.fn().mockResolvedValue(jsonResponse(200, payload)) })
    const error = await provider.generateAnswer({ input: 'Hello' }).catch((caught) => caught)
    expect(error).toBeInstanceOf(OpenAiResponseError)
    expect(error.errorCode).toBe('MAX_TOKENS')
  })

  it('turns a network failure or timeout into a failed request, not an unhandled error', async () => {
    const { provider } = buildProvider({ fetchImpl: jest.fn().mockRejectedValue(new Error('socket hang up')) })
    const error = await provider.generateAnswer({ input: 'Hello' }).catch((caught) => caught)
    expect(error).toBeInstanceOf(OpenAiResponseError)
  })

  it('rejects empty input without calling Vertex', async () => {
    const { provider, fetchImpl } = buildProvider()
    await expect(provider.generateAnswer({ input: '   ' })).rejects.toBeInstanceOf(OpenAiResponseError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('missing config → the same safe 503 a missing OpenAI key gives, naming the settings and calling nothing', async () => {
    const fetchImpl = jest.fn()
    const getAccessToken = jest.fn()
    const provider = createGeminiAnswerProvider({ fetchImpl, getAccessToken })

    const error = await provider.generateAnswer({ input: 'Hello' }).catch((caught) => caught)
    expect(error).toBeInstanceOf(MissingGeminiConfigError)
    expect(error).toBeInstanceOf(MissingOpenAiApiKeyError)
    expect(error.message).toContain('GOOGLE_CLOUD_PROJECT')
    expect(error.message).toContain('GOOGLE_APPLICATION_CREDENTIALS_JSON')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(getAccessToken).not.toHaveBeenCalled()

    const mapped = mapOpenAiErrorToHttpResponse(error, {
      scope: 'test.missingGemini', unavailableMessage: 'Not available.', failedMessage: 'Failed.',
    })
    expect(mapped).toEqual({ statusCode: 503, body: { error: 'Not available.' } })
  })

  it('reads project, location and credentials from the environment, defaulting the location to global', async () => {
    process.env.GOOGLE_CLOUD_PROJECT = 'env-project'
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = FAKE_SA_JSON
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, FIXTURE))
    const provider = createGeminiAnswerProvider({ fetchImpl, getAccessToken: async () => FAKE_TOKEN })
    await provider.generateAnswer({ input: 'Hello' })
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://aiplatform.googleapis.com/v1/projects/env-project/locations/global/publishers/google/models/gemini-3.8-flash:generateContent',
    )

    process.env.VERTEX_LOCATION = 'us-central1'
    await provider.generateAnswer({ input: 'Hello' })
    expect(fetchImpl.mock.calls[1][0]).toContain('https://us-central1-aiplatform.googleapis.com/')
  })

  it('never writes the access token or credential JSON to stderr or the console', async () => {
    const written = []
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => { written.push(String(chunk)); return true })
    for (const method of ['log', 'info', 'warn', 'error']) {
      jest.spyOn(console, method).mockImplementation((...args) => { written.push(args.join(' ')) })
    }

    const { provider } = buildProvider()
    await provider.generateAnswer({ input: 'Hello' })
    const failing = buildProvider({
      fetchImpl: jest.fn().mockResolvedValue(jsonResponse(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'x' } })),
    }).provider
    await failing.generateAnswer({ input: 'Hello' }).catch(() => {})

    const all = written.join('\n')
    expect(all.length).toBeGreaterThan(0)
    expect(all).not.toContain(FAKE_TOKEN)
    expect(all).not.toContain('not-a-real-key')
    expect(all).not.toContain('PRIVATE KEY')
  })
})
