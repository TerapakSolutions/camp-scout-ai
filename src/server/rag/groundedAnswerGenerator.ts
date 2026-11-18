/**
 * Grounded answer generator — connects keyword retrieval to the answer provider.
 * Answers are generated only from retrieved campground knowledge context.
 * Server-only; never import from React client code.
 */

import { resolveActiveModel } from '../ai/aiProviderConfig.js'
import type {
  AskInsufficientResponse,
  AskSuccessResponse,
  Citation,
  ContradictionWarning,
  Evidence,
  GroundingMetrics,
  QueryIntent,
  AnswerConfidenceLevel,
  UniqueSourceReference,
} from '../../shared/types/api.js'
import type { RetrievalContextSource } from '../../data/knowledge/retrievalContext.js'
import { buildRetrievalContext } from '../../data/knowledge/retrievalContext.js'
import {
  buildVerifiedPricingPromptSection,
  extractCampgroundPricingFromResults,
  hasSufficientPricingForCheapestComparison,
  INSUFFICIENT_PRICING_COMPARISON_MESSAGE,
  rankCampgroundsByCampingFee,
  sortResultsForPriceQuestion,
} from '../../data/knowledge/campgroundPricing.js'
import { getQueryIntent } from '../../data/knowledge/queryTokens.js'
import { createAnswerProvider } from '../openai/createAnswerProvider.js'
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../openai/answerProvider.js'
import { logOpenAiDiagnostic } from '../openai/logOpenAiDiagnostic.js'
import {
  resolveMaxContextTokens,
  resolveMaxOutputTokens,
} from '../openai/promptLimits.js'
import {
  buildSupportingEvidence,
  calculateAnswerConfidence,
  deduplicateSourcesByUrl,
  stripGenericSourcesBlock,
  transformSourceReferences,
} from './answerTrust.js'
import { buildGroundingMetrics } from './citationValidation.js'
import { detectContradictions } from './contradictionDetection.js'
import {
  logIntentClassification,
  retrieveDocumentsWithIntent,
} from './intentRetrieval.js'
import {
  buildCapabilityGuardrailRules,
  classifyQuery,
} from './queryClassifier.js'
import type { PriceGuardrailOptions } from './queryClassifier.js'

export const DEFAULT_TOP_DOCUMENT_COUNT = 3
export const GROUNDED_ANSWER_MAX_OUTPUT_TOKENS = DEFAULT_MAX_OUTPUT_TOKENS
export const GROUNDED_ANSWER_MAX_CONTEXT_TOKENS = resolveMaxContextTokens()

export const INSUFFICIENT_CONTEXT_STATUS = 'insufficient_context'
export const SUCCESS_STATUS = 'success'

const DEFAULT_INSUFFICIENT_MESSAGE =
  "I don't have information about that in my campground knowledge base. Try browsing the campground list or checking the official park website."

export type GroundedAnswerCitation = Citation
export type GroundedAnswerSuccess = AskSuccessResponse
export type GroundedAnswerInsufficient = AskInsufficientResponse
export type GroundedAnswerResult = AskSuccessResponse | AskInsufficientResponse

export type { Evidence as SupportingEvidenceItem, QueryIntent as QueryCategory }
export type { AnswerConfidenceLevel, ContradictionWarning, GroundingMetrics, UniqueSourceReference }

export interface GenerateGroundedAnswerOptions {
  question?: string
  campgroundId?: string
  documentType?: string
  topDocumentCount?: number
  maxOutputTokens?: number
  maxContextTokens?: number
  answerProvider?: import('../openai/answerProvider.js').AnswerProvider
  provider?: import('../openai/createAnswerProvider.js').AnswerProviderName
  protectedAccess?: boolean
}

/**
 * Builds system instructions requiring context-only answers with organization-based citations.
 * @param {number} sourceCount
 * @param {QueryCategory} [queryCategory]
 * @param {string[]} [campgroundNames]
 * @param {RetrievalContextSource[]} [sources]
 * @returns {string}
 */
export function buildGroundedAnswerInstructions(
  sourceCount: number,
  queryCategory?: import('./queryClassifier.js').QueryCategory,
  campgroundNames: string[] = [],
  sources: RetrievalContextSource[] = [],
  priceOptions: PriceGuardrailOptions = {},
) {
  const organizationExamples = sources
    .slice(0, 3)
    .map((source) => formatOrganizationReference(source.sourceName))
    .join(', ')

  const baseRules = [
    'You are Camp Scout AI, a helpful assistant for Northern California campground visitors.',
    'Answer using ONLY the retrieved source excerpts provided in the user input.',
    '',
    'Rules:',
    '1. Answer only from the provided context. Do not use outside knowledge.',
    '2. Reference organizations by name instead of generic labels like "Source 1".',
    organizationExamples
      ? `   Example phrasing: "According to ${organizationExamples}…"`
      : '   Example phrasing: "According to the National Park Service…"',
    '3. Cite every factual claim inline using the organization name from the source metadata.',
    '4. Synthesize information from all ' + sourceCount + ' retrieved documents into one coherent answer.',
    '5. Remove duplicate facts — state each fact once even if multiple sources repeat it.',
    '6. If sources conflict, present both versions with attribution instead of merging them silently.',
    '7. If the context does not contain enough information, say so clearly.',
    '8. Never invent campground names, policies, fees, availability, or reservation details.',
    '9. Use plain, friendly language appropriate for campers planning a trip.',
    '10. Do not include a generic "Sources:" list at the end — source links are shown separately in the UI.',
  ]

  const guardrailRules = buildCapabilityGuardrailRules(queryCategory ?? 'factual', campgroundNames, {
    isPriceQuestion: priceOptions.isPriceQuestion === true,
    isCheapestQuestion: priceOptions.isCheapestQuestion === true,
  })

  if (guardrailRules.length === 0) {
    return baseRules.join('\n')
  }

  return [
    ...baseRules,
    '',
    'Capability guardrails:',
    ...guardrailRules.map((rule, index) => `${index + 1}. ${rule}`),
  ].join('\n')
}

/**
 * Maps retrieval context sources to citation metadata.
 * @param {RetrievalContextSource} source
 * @returns {GroundedAnswerCitation}
 */
export function toGroundedAnswerCitation(source) {
  return {
    id: source.id,
    title: source.title,
    sourceName: source.sourceName,
    sourceUrl: source.sourceUrl,
    campgroundName: source.campgroundName,
    documentType: source.documentType,
  }
}

/**
 * Keeps retrieval results that are relevant to the question.
 * @param {import('../../data/knowledge/knowledgeRetrieval.js').RetrievalResult[]} results
 * @returns {import('../../data/knowledge/knowledgeRetrieval.js').RetrievalResult[]}
 */
export function filterRelevantResults(results) {
  return results.filter((result) => result.relevanceScore > 0)
}

/**
 * @param {string} message
 * @returns {GroundedAnswerInsufficient}
 */
export function buildInsufficientContextResponse(message = DEFAULT_INSUFFICIENT_MESSAGE) {
  return {
    status: INSUFFICIENT_CONTEXT_STATUS,
    message,
    citations: [],
  }
}

/**
 * Returns a grounded success response for capability guardrail short-circuits.
 * @param {string} answer
 * @returns {GroundedAnswerSuccess}
 */
export function buildGuardrailAnswerResponse(answer) {
  return {
    status: SUCCESS_STATUS,
    answer,
    citations: [],
    sources: [],
    evidence: [],
    confidence: 'high',
    intent: 'factual',
    model: 'capability-guardrail',
  }
}

/**
 * Formats an organization name for prompt examples.
 * @param {string} sourceName
 * @returns {string}
 */
function formatOrganizationReference(sourceName) {
  const trimmed = (sourceName ?? '').trim()
  if (trimmed.length === 0) {
    return 'the official source'
  }

  if (/^(the|a|an)\s/i.test(trimmed)) {
    return trimmed
  }

  return `the ${trimmed}`
}

export async function generateGroundedAnswer({
  question,
  campgroundId = '',
  documentType = '',
  topDocumentCount = DEFAULT_TOP_DOCUMENT_COUNT,
  maxOutputTokens = GROUNDED_ANSWER_MAX_OUTPUT_TOKENS,
  maxContextTokens = GROUNDED_ANSWER_MAX_CONTEXT_TOKENS,
  answerProvider,
  provider,
  protectedAccess = false,
}: GenerateGroundedAnswerOptions = {}) {
  const trimmedQuestion = (question ?? '').trim()

  if (trimmedQuestion.length === 0) {
    return buildInsufficientContextResponse('A question is required to generate an answer.')
  }

  const queryClassification = classifyQuery(trimmedQuestion)
  const queryIntent = getQueryIntent(trimmedQuestion)

  if (queryClassification.shouldShortCircuit && queryClassification.shortCircuitMessage) {
    return buildGuardrailAnswerResponse(queryClassification.shortCircuitMessage)
  }

  const results = retrieveDocumentsWithIntent({
    query: trimmedQuestion,
    campgroundId,
    documentType,
    limit: topDocumentCount,
    queryCategory: queryClassification.category as import('./queryClassifier.js').QueryCategory,
  })

  logIntentClassification({
    question: trimmedQuestion,
    queryCategory: queryClassification.category as import('./queryClassifier.js').QueryCategory,
    campgroundNames: queryClassification.campgroundNames,
    resultCount: results.length,
  })

  let relevantResults = filterRelevantResults(results)

  if (queryIntent.isPriceQuestion) {
    relevantResults = sortResultsForPriceQuestion(relevantResults)
  }

  if (relevantResults.length === 0) {
    return buildInsufficientContextResponse()
  }

  const pricingRecords = queryIntent.isPriceQuestion
    ? extractCampgroundPricingFromResults(relevantResults)
    : []
  const rankedCampgrounds = queryIntent.isCheapestQuestion
    ? rankCampgroundsByCampingFee(pricingRecords)
    : []

  if (
    queryIntent.isCheapestQuestion
    && !hasSufficientPricingForCheapestComparison(rankedCampgrounds)
  ) {
    return buildInsufficientContextResponse(INSUFFICIENT_PRICING_COMPARISON_MESSAGE)
  }

  const pricingSection = queryIntent.isPriceQuestion
    ? buildVerifiedPricingPromptSection(pricingRecords, rankedCampgrounds)
    : ''

  const context = buildRetrievalContext({
    question: trimmedQuestion,
    results: relevantResults,
    maxContextTokens,
    pricingSection,
  })

  const providerInstance = answerProvider ?? createAnswerProvider({
    provider,
    protectedAccess,
  })
  const resolvedMaxOutputTokens = resolveMaxOutputTokens(maxOutputTokens)
  const model = resolveActiveModel()

  logOpenAiDiagnostic('generateGroundedAnswer.request', {
    provider: providerInstance.name,
    model,
    promptTokenEstimate: context.estimatedPromptTokens,
    maxOutputTokens: resolvedMaxOutputTokens,
    contextTruncated: context.contextTruncated ?? false,
  })

  const generationResult = await providerInstance.generateAnswer({
    instructions: buildGroundedAnswerInstructions(
      context.sourceCount,
      queryClassification.category as import('./queryClassifier.js').QueryCategory,
      queryClassification.campgroundNames,
      context.sources,
      {
        isPriceQuestion: queryIntent.isPriceQuestion,
        isCheapestQuestion: queryIntent.isCheapestQuestion,
      },
    ),
    input: context.promptContext,
    maxOutputTokens: resolvedMaxOutputTokens,
  })

  const citations = context.sources.map(toGroundedAnswerCitation)
  const uniqueSources = deduplicateSourcesByUrl(context.sources)
  const evidence = buildSupportingEvidence(relevantResults)
  const confidence = calculateAnswerConfidence(
    relevantResults.map((result) => result.relevanceScore),
  )
  const contradictionWarning = detectContradictions(relevantResults)

  let answer = transformSourceReferences(generationResult.text, context.sources)
  answer = stripGenericSourcesBlock(answer)

  if (contradictionWarning) {
    answer = `${answer}\n\nNote: ${contradictionWarning.message}`
  }

  const groundingMetrics = buildGroundingMetrics({
    answer,
    citationCount: citations.length,
    confidence,
  })

  return {
    status: SUCCESS_STATUS,
    answer,
    citations,
    sources: uniqueSources,
    evidence,
    confidence,
    intent: queryClassification.category,
    contradictionWarning,
    groundingMetrics: {
      coverageRatio: groundingMetrics.coverageRatio,
      warnings: groundingMetrics.warnings,
    },
    model: generationResult.model,
    inputTokens: generationResult.inputTokens,
    outputTokens: generationResult.outputTokens,
  }
}
