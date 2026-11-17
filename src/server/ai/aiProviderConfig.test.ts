/** @jest-environment node */

import {
  AI_PROVIDER_ENV,
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODEL_ENV,
  resolveActiveModel,
  resolveAiVendor,
} from './aiProviderConfig.js'

const ENV_KEYS = [AI_PROVIDER_ENV, GEMINI_MODEL_ENV, 'OPENAI_MODEL'] as const
const snapshot: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) snapshot[key] = process.env[key]
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key]
    else process.env[key] = snapshot[key]
  }
})

describe('resolveAiVendor', () => {
  it('defaults to openai when AI_PROVIDER is unset, so merging changes nothing in prod', () => {
    expect(resolveAiVendor()).toBe('openai')
  })

  it('selects gemini when AI_PROVIDER=gemini (case and whitespace tolerant)', () => {
    process.env[AI_PROVIDER_ENV] = 'gemini'
    expect(resolveAiVendor()).toBe('gemini')
    process.env[AI_PROVIDER_ENV] = ' Gemini '
    expect(resolveAiVendor()).toBe('gemini')
  })

  it('treats openai and any unknown value as openai (the rollback vendor)', () => {
    process.env[AI_PROVIDER_ENV] = 'openai'
    expect(resolveAiVendor()).toBe('openai')
    process.env[AI_PROVIDER_ENV] = 'gemnii'
    expect(resolveAiVendor()).toBe('openai')
  })
})

describe('resolveActiveModel', () => {
  it('is OPENAI_MODEL or gpt-4o-mini on the openai vendor', () => {
    expect(resolveActiveModel()).toBe('gpt-4o-mini')
    process.env.OPENAI_MODEL = 'gpt-4o-mini-2024-07-18'
    expect(resolveActiveModel()).toBe('gpt-4o-mini-2024-07-18')
  })

  it('is GEMINI_MODEL or gemini-3.8-flash on the gemini vendor, ignoring OPENAI_MODEL', () => {
    process.env[AI_PROVIDER_ENV] = 'gemini'
    process.env.OPENAI_MODEL = 'gpt-4o-mini'
    expect(resolveActiveModel()).toBe(DEFAULT_GEMINI_MODEL)
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3.8-flash')
    process.env[GEMINI_MODEL_ENV] = 'gemini-3.8-flash-001'
    expect(resolveActiveModel()).toBe('gemini-3.8-flash-001')
  })
})
