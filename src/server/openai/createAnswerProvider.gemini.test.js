/** @jest-environment node */

/**
 * How the two settings combine:
 *   OPENAI_ANSWER_PROVIDER (unchanged) is the LIVE/FAKE gate — only `openai` means live.
 *   AI_PROVIDER picks the live VENDOR — `gemini`, else OpenAI (the default when unset).
 * The fake gate always wins: AI_PROVIDER alone can never make a paid call.
 */

import { createAnswerProvider, resolveAnswerProviderName } from './createAnswerProvider.js'

const ENV_KEYS = ['AI_ENABLED', 'OPENAI_ANSWER_PROVIDER', 'AI_PROVIDER']
const snapshot = {}

beforeEach(() => {
  for (const key of ENV_KEYS) snapshot[key] = process.env[key]
  process.env.AI_ENABLED = 'true'
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key]
    else process.env[key] = snapshot[key]
  }
})

describe('createAnswerProvider with AI_PROVIDER', () => {
  it('stays on OpenAI when AI_PROVIDER is unset (default)', () => {
    process.env.OPENAI_ANSWER_PROVIDER = 'openai'
    delete process.env.AI_PROVIDER
    expect(createAnswerProvider({ protectedAccess: true }).name).toBe('openai')
  })

  it('builds the Gemini provider when live and AI_PROVIDER=gemini', () => {
    process.env.OPENAI_ANSWER_PROVIDER = 'openai'
    process.env.AI_PROVIDER = 'gemini'
    expect(createAnswerProvider({ protectedAccess: true }).name).toBe('gemini')
  })

  it('keeps the "live" provider name as openai, so every budget and pricing gate still applies', () => {
    process.env.OPENAI_ANSWER_PROVIDER = 'openai'
    process.env.AI_PROVIDER = 'gemini'
    expect(resolveAnswerProviderName(undefined, { protectedAccess: true })).toBe('openai')
  })

  it('OPENAI_ANSWER_PROVIDER=fake forces the fake provider even with AI_PROVIDER=gemini', async () => {
    process.env.OPENAI_ANSWER_PROVIDER = 'fake'
    process.env.AI_PROVIDER = 'gemini'
    const fetchImpl = jest.fn()
    const provider = createAnswerProvider({ protectedAccess: true, fetchImpl })
    expect(provider.name).toBe('fake')
    await provider.generateAnswer({ input: 'Hello' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('unset OPENAI_ANSWER_PROVIDER is still fake, whatever AI_PROVIDER says', () => {
    delete process.env.OPENAI_ANSWER_PROVIDER
    process.env.AI_PROVIDER = 'gemini'
    expect(createAnswerProvider({ protectedAccess: true }).name).toBe('fake')
  })

  it('AI_ENABLED=false forces fake even with AI_PROVIDER=gemini', () => {
    process.env.AI_ENABLED = 'false'
    process.env.OPENAI_ANSWER_PROVIDER = 'openai'
    process.env.AI_PROVIDER = 'gemini'
    expect(createAnswerProvider({ protectedAccess: true }).name).toBe('fake')
  })

  it('an explicit fake provider wins over AI_PROVIDER=gemini', () => {
    process.env.OPENAI_ANSWER_PROVIDER = 'openai'
    process.env.AI_PROVIDER = 'gemini'
    expect(createAnswerProvider({ provider: 'fake', protectedAccess: true }).name).toBe('fake')
  })
})
