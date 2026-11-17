/**
 * Estimates AI API costs from token usage, priced by the model that served the request.
 *
 * Output tokens include reasoning/thinking tokens: providers bill them at the output rate, and the
 * Gemini client already folds `thoughtsTokenCount` into `outputTokens`.
 */

import { resolveActiveModel } from './aiProviderConfig.js'

export const AI_INPUT_COST_PER_MILLION_ENV = 'AI_INPUT_COST_PER_MILLION'
export const AI_OUTPUT_COST_PER_MILLION_ENV = 'AI_OUTPUT_COST_PER_MILLION'

export interface ModelPricing {
  inputCostPerMillion: number
  outputCostPerMillion: number
}

interface PriceTier extends ModelPricing {
  /** First instant (inclusive) this tier applies; tiers are listed oldest first. */
  from: Date
}

interface PricedModel {
  /** Matches the model name exactly, or as a prefix followed by `-` (dated / versioned snapshots). */
  model: string
  vendor: 'openai' | 'gemini'
  tiers: PriceTier[]
}

const BEGINNING = new Date(0)

/**
 * USD per 1M tokens.
 * gpt-4o-mini: OpenAI list price.
 * gemini-3.8-flash: Google Vertex pricing page, Standard tier, output includes thinking. The
 *   introductory price ends 2026-12-31; the switch is at 2027-01-01T00:00Z (UTC), which is 8 hours
 *   before Pacific midnight — the conservative side: it overprices for those 8 hours, never under.
 */
const PRICED_MODELS: PricedModel[] = [
  {
    model: 'gpt-4o-mini',
    vendor: 'openai',
    tiers: [{ from: BEGINNING, inputCostPerMillion: 0.15, outputCostPerMillion: 0.6 }],
  },
  {
    model: 'gemini-3.8-flash',
    vendor: 'gemini',
    tiers: [
      { from: BEGINNING, inputCostPerMillion: 0.75, outputCostPerMillion: 3.75 },
      { from: new Date('2027-01-01T00:00:00.000Z'), inputCostPerMillion: 1.5, outputCostPerMillion: 7.5 },
    ],
  },
]

function tierAt(entry: PricedModel, at: Date): ModelPricing {
  let current = entry.tiers[0]
  for (const tier of entry.tiers) {
    if (at.getTime() >= tier.from.getTime()) current = tier
  }
  return { inputCostPerMillion: current.inputCostPerMillion, outputCostPerMillion: current.outputCostPerMillion }
}

function findPricedModel(model: string): PricedModel | undefined {
  const name = model.trim().toLowerCase()
  let best: PricedModel | undefined
  for (const entry of PRICED_MODELS) {
    if (name === entry.model || name.startsWith(`${entry.model}-`)) {
      if (!best || entry.model.length > best.model.length) best = entry
    }
  }
  return best
}

/**
 * An unknown model is priced at the HIGHEST known rate, never at zero and never refused: the cost is
 * computed after the call was already paid for, so refusing could not un-spend it, and pricing high
 * makes the daily budget trip early rather than late.
 */
function highestKnownPricing(at: Date): ModelPricing {
  let input = 0
  let output = 0
  for (const entry of PRICED_MODELS) {
    const tier = tierAt(entry, at)
    input = Math.max(input, tier.inputCostPerMillion)
    output = Math.max(output, tier.outputCostPerMillion)
  }
  return { inputCostPerMillion: input, outputCostPerMillion: output }
}

/**
 * AI_INPUT_COST_PER_MILLION / AI_OUTPUT_COST_PER_MILLION predate per-model pricing and were
 * documented as gpt-4o-mini prices, so they apply to OpenAI models only. Letting a leftover
 * gpt-4o-mini override price Gemini would undercount Gemini spend about 5x.
 */
function applyOpenAiOverrides(pricing: ModelPricing): ModelPricing {
  const inputOverride = Number.parseFloat(process.env[AI_INPUT_COST_PER_MILLION_ENV] ?? '')
  const outputOverride = Number.parseFloat(process.env[AI_OUTPUT_COST_PER_MILLION_ENV] ?? '')
  return {
    inputCostPerMillion: Number.isFinite(inputOverride) && inputOverride >= 0
      ? inputOverride
      : pricing.inputCostPerMillion,
    outputCostPerMillion: Number.isFinite(outputOverride) && outputOverride >= 0
      ? outputOverride
      : pricing.outputCostPerMillion,
  }
}

/**
 * @param model the model that served the request; when absent, the configured active model.
 * @param at when the request ran (decides the price tier).
 */
export function resolveModelPricing(model?: string, at: Date = new Date()): ModelPricing {
  const name = typeof model === 'string' && model.trim().length > 0 ? model : resolveActiveModel()
  const entry = findPricedModel(name)
  if (!entry) {
    return highestKnownPricing(at)
  }
  const pricing = tierAt(entry, at)
  return entry.vendor === 'openai' ? applyOpenAiOverrides(pricing) : pricing
}

/**
 * Estimates USD cost for a request.
 * @param model the model that served it — see resolveModelPricing for the fallbacks.
 */
export function estimateRequestCost(
  inputTokens: number,
  outputTokens: number,
  model?: string,
  at: Date = new Date(),
): number {
  const { inputCostPerMillion, outputCostPerMillion } = resolveModelPricing(model, at)
  const inputCost = (Math.max(0, inputTokens) / 1_000_000) * inputCostPerMillion
  const outputCost = (Math.max(0, outputTokens) / 1_000_000) * outputCostPerMillion
  return inputCost + outputCost
}
