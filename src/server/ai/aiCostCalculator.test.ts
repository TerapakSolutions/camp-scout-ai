/** @jest-environment node */

import {
  AI_INPUT_COST_PER_MILLION_ENV,
  AI_OUTPUT_COST_PER_MILLION_ENV,
  estimateRequestCost,
  resolveModelPricing,
} from './aiCostCalculator.js'
import { buildRequestRecord } from './aiUsageStore.js'

const ENV_KEYS = [
  'AI_PROVIDER',
  'OPENAI_MODEL',
  'GEMINI_MODEL',
  AI_INPUT_COST_PER_MILLION_ENV,
  AI_OUTPUT_COST_PER_MILLION_ENV,
] as const
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

const M = 1_000_000
const LAST_INTRO_INSTANT = new Date('2026-12-31T23:59:59.999Z')
const FIRST_FULL_PRICE_INSTANT = new Date('2027-01-01T00:00:00.000Z')

describe('per-model pricing', () => {
  it('prices gpt-4o-mini at $0.15 in / $0.60 out per 1M (unchanged)', () => {
    expect(estimateRequestCost(M, M, 'gpt-4o-mini')).toBeCloseTo(0.75, 10)
  })

  it('prices a dated OpenAI snapshot name as its base model, not as unknown', () => {
    // OpenAI echoes dated snapshot names in `model`; an exact-key lookup would send every live
    // OpenAI call to the unknown-model rate the moment this merges.
    expect(estimateRequestCost(M, M, 'gpt-4o-mini-2024-07-18')).toBeCloseTo(0.75, 10)
  })

  it('prices gemini-3.8-flash at $0.75 / $3.75 per 1M through 2026-12-31 (UTC)', () => {
    expect(estimateRequestCost(M, 0, 'gemini-3.8-flash', LAST_INTRO_INSTANT)).toBeCloseTo(0.75, 10)
    expect(estimateRequestCost(0, M, 'gemini-3.8-flash', LAST_INTRO_INSTANT)).toBeCloseTo(3.75, 10)
  })

  it('prices gemini-3.8-flash at $1.50 / $7.50 per 1M from 2027-01-01T00:00Z', () => {
    expect(estimateRequestCost(M, 0, 'gemini-3.8-flash', FIRST_FULL_PRICE_INSTANT)).toBeCloseTo(1.5, 10)
    expect(estimateRequestCost(0, M, 'gemini-3.8-flash', FIRST_FULL_PRICE_INSTANT)).toBeCloseTo(7.5, 10)
  })

  it('prices a suffixed Gemini model version as gemini-3.8-flash', () => {
    expect(estimateRequestCost(M, M, 'gemini-3.8-flash-001', LAST_INTRO_INSTANT)).toBeCloseTo(4.5, 10)
  })

  it('never prices an unknown model at zero: it uses the highest known rate on that date', () => {
    expect(estimateRequestCost(M, M, 'some-new-model', LAST_INTRO_INSTANT)).toBeCloseTo(4.5, 10)
    expect(estimateRequestCost(M, M, 'some-new-model', FIRST_FULL_PRICE_INSTANT)).toBeCloseTo(9, 10)
    // A "gpt-4o-mini" prefix must not swallow a different model that merely shares letters.
    expect(estimateRequestCost(M, M, 'gpt-4o-minimal', LAST_INTRO_INSTANT)).toBeCloseTo(4.5, 10)
  })

  it('prices a record with no model at the configured active model', () => {
    expect(estimateRequestCost(M, M)).toBeCloseTo(0.75, 10)
    process.env.AI_PROVIDER = 'gemini'
    expect(estimateRequestCost(M, M, undefined, LAST_INTRO_INSTANT)).toBeCloseTo(4.5, 10)
    expect(estimateRequestCost(M, M, 'unknown', LAST_INTRO_INSTANT)).toBeCloseTo(4.5, 10)
  })

  it('applies AI_*_COST_PER_MILLION overrides to OpenAI models only, never to Gemini', () => {
    process.env[AI_INPUT_COST_PER_MILLION_ENV] = '0.15'
    process.env[AI_OUTPUT_COST_PER_MILLION_ENV] = '0.60'
    expect(resolveModelPricing('gemini-3.8-flash', LAST_INTRO_INSTANT)).toEqual({
      inputCostPerMillion: 0.75,
      outputCostPerMillion: 3.75,
    })

    process.env[AI_INPUT_COST_PER_MILLION_ENV] = '1'
    process.env[AI_OUTPUT_COST_PER_MILLION_ENV] = '2'
    expect(resolveModelPricing('gpt-4o-mini')).toEqual({
      inputCostPerMillion: 1,
      outputCostPerMillion: 2,
    })
  })
})

describe('usage records are priced by the model that served them', () => {
  const base = {
    endpoint: '/api/ask',
    requestId: 'r1',
    correlationId: 'c1',
    provider: 'openai',
    promptTokenEstimate: M,
    completionTokens: M,
    latencyMs: 1,
    clientIp: '127.0.0.1',
    responseStatus: 200,
  }

  it('prices a Gemini-served record at Gemini rates even while AI_PROVIDER points at OpenAI', () => {
    // e.g. the minutes around a rollback: the record's own model decides, not the current setting.
    const record = buildRequestRecord({ ...base, model: 'gemini-3.8-flash' })
    expect(record.estimatedCostUsd).toBeCloseTo(estimateRequestCost(M, M, 'gemini-3.8-flash'), 10)
    expect(record.estimatedCostUsd).toBeGreaterThan(0.75)
  })

  it('still prices the fake provider at zero', () => {
    const record = buildRequestRecord({ ...base, provider: 'fake', model: 'gemini-3.8-flash' })
    expect(record.estimatedCostUsd).toBe(0)
  })
})
