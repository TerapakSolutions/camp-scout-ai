/**
 * Summary handler — validates input and returns AI campground summaries as JSON.
 * Server-only; never import from React client code.
 */

import { resolveActiveModel } from '../ai/aiProviderConfig.js'
import type { ApiErrorResponse, SummaryRequest, SummaryResponse } from '../../shared/types/api.js'
import { getCampgroundSummary } from '../rag/campgroundSummaryService.js'
import { mapOpenAiErrorToHttpResponse } from '../openai/mapOpenAiHttpError.js'
import type { AnswerProvider } from '../openai/answerProvider.js'
import type { AnswerProviderName } from '../openai/createAnswerProvider.js'
import { validateSummaryRequestGuardrails } from './requestGuardrails.js'

export const INVALID_BODY_ERROR = 'Request body must be a JSON object with a campgroundId field.'
export const EMPTY_CAMPGROUND_ID_ERROR = 'campgroundId is required and must be a non-empty string.'

export type SummaryValidationFailure = {
  ok: false
  statusCode: number
  body: ApiErrorResponse
}

export type SummaryValidationSuccess = {
  ok: true
  value: SummaryRequest
}

export type SummaryValidationResult = SummaryValidationSuccess | SummaryValidationFailure

export interface SummaryHandlerOptions {
  answerProvider?: AnswerProvider
  provider?: AnswerProviderName
  protectedAccess?: boolean
}

export interface SummaryHttpResponse {
  statusCode: number
  body: SummaryResponse | ApiErrorResponse
}

export function validateSummaryRequestBody(body: unknown): SummaryValidationResult {
  if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      statusCode: 400,
      body: { error: INVALID_BODY_ERROR },
    }
  }

  const record = body as Record<string, unknown>
  const { campgroundId } = record

  if (typeof campgroundId !== 'string' || campgroundId.trim().length === 0) {
    return {
      ok: false,
      statusCode: 400,
      body: { error: EMPTY_CAMPGROUND_ID_ERROR },
    }
  }

  const value: SummaryRequest = { campgroundId: campgroundId.trim() }

  if (typeof record.forceRegenerate === 'boolean') {
    value.forceRegenerate = record.forceRegenerate
  }

  const guardrails = validateSummaryRequestGuardrails(value)
  if (!guardrails.ok) {
    return guardrails as SummaryValidationFailure
  }

  return { ok: true, value }
}

export async function handleSummaryRequest(
  body: unknown,
  options: SummaryHandlerOptions = {},
): Promise<SummaryHttpResponse> {
  const validation = validateSummaryRequestBody(body)
  if (validation.ok === false) {
    return {
      statusCode: validation.statusCode,
      body: validation.body,
    }
  }

  try {
    const result = await getCampgroundSummary({
      campgroundId: validation.value.campgroundId,
      forceRegenerate: validation.value.forceRegenerate ?? false,
      answerProvider: options.answerProvider,
      provider: options.provider,
      protectedAccess: options.protectedAccess === true,
    })

    return {
      statusCode: 200,
      body: result,
    }
  } catch (error) {
    const configuredProvider = options.provider ?? process.env.OPENAI_ANSWER_PROVIDER ?? 'fake'
    return mapOpenAiErrorToHttpResponse(error, {
      scope: 'handleSummaryRequest.openAiResponseError',
      provider: configuredProvider === 'openai' ? 'openai' : 'fake',
      model: resolveActiveModel(),
      unavailableMessage: 'Summary generation is not available.',
      failedMessage: 'Summary generation failed. Please try again.',
    })
  }
}
