/**
 * Ask question handler — validates input and returns grounded answers as JSON.
 * Server-only; never import from React client code.
 */

import { resolveActiveModel } from '../ai/aiProviderConfig.js'
import type { ApiErrorResponse, AskRequest, AskResponse } from '../../shared/types/api.js'
import { generateGroundedAnswer } from '../rag/groundedAnswerGenerator.js'
import { mapOpenAiErrorToHttpResponse } from '../openai/mapOpenAiHttpError.js'
import type { AnswerProvider } from '../openai/answerProvider.js'
import type { BilledUsage } from '../openai/errors.js'
import type { AnswerProviderName } from '../openai/createAnswerProvider.js'
import { validateAskRequestGuardrails } from './requestGuardrails.js'

export const EMPTY_QUESTION_ERROR = 'question is required and must be a non-empty string.'
export const INVALID_BODY_ERROR = 'Request body must be a JSON object with a question field.'
export const INVALID_JSON_ERROR = 'Invalid JSON body.'

export type AskValidationFailure = {
  ok: false
  statusCode: number
  body: ApiErrorResponse
}

export type AskValidationSuccess = {
  ok: true
  value: AskRequest
}

export type AskValidationResult = AskValidationSuccess | AskValidationFailure

export interface AskHandlerOptions {
  answerProvider?: AnswerProvider
  provider?: AnswerProviderName
  protectedAccess?: boolean
}

export interface AskHttpResponse {
  statusCode: number
  body: AskResponse | ApiErrorResponse
  /** A failed call's billed tokens, for the usage record only (see mapOpenAiHttpError). */
  billedUsage?: BilledUsage
}

export function validateAskRequestBody(body: unknown): AskValidationResult {
  if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      statusCode: 400,
      body: { error: INVALID_BODY_ERROR },
    }
  }

  const record = body as Record<string, unknown>
  const { question } = record

  if (typeof question !== 'string' || question.trim().length === 0) {
    return {
      ok: false,
      statusCode: 400,
      body: { error: EMPTY_QUESTION_ERROR },
    }
  }

  const value: AskRequest = {
    question: question.trim(),
  }

  if (typeof record.campgroundId === 'string') {
    value.campgroundId = record.campgroundId
  }

  if (typeof record.documentType === 'string') {
    value.documentType = record.documentType
  }

  if (typeof record.topDocumentCount === 'number' && Number.isFinite(record.topDocumentCount)) {
    value.topDocumentCount = record.topDocumentCount
  }

  const guardrails = validateAskRequestGuardrails(value)
  if (!guardrails.ok) {
    return guardrails as AskValidationFailure
  }

  return { ok: true, value }
}

export async function handleAskRequest(body: unknown, options: AskHandlerOptions = {}): Promise<AskHttpResponse> {
  const validation = validateAskRequestBody(body)
  if (validation.ok === false) {
    return {
      statusCode: validation.statusCode,
      body: validation.body,
    }
  }

  try {
    const result = await generateGroundedAnswer({
      question: validation.value.question,
      campgroundId: validation.value.campgroundId ?? '',
      documentType: validation.value.documentType ?? '',
      topDocumentCount: validation.value.topDocumentCount,
      answerProvider: options.answerProvider,
      provider: options.provider,
      protectedAccess: options.protectedAccess === true,
    })

    return {
      statusCode: 200,
      body: result as AskResponse,
    }
  } catch (error) {
    const configuredProvider = options.provider ?? process.env.OPENAI_ANSWER_PROVIDER ?? 'fake'
    return mapOpenAiErrorToHttpResponse(error, {
      scope: 'handleAskRequest.openAiResponseError',
      provider: configuredProvider === 'openai' ? 'openai' : 'fake',
      model: resolveActiveModel(),
      unavailableMessage: 'Answer generation is not available.',
      failedMessage: 'Answer generation failed. Please try again.',
    })
  }
}
