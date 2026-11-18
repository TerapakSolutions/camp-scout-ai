/**
 * Maps server-side OpenAI errors to safe HTTP responses for API handlers.
 */

import type { ApiErrorResponse } from '../../shared/types/api.js'
import {
  type BilledUsage,
  MissingOpenAiApiKeyError,
  OpenAiResponseError,
  isOpenAiQuotaExceededError,
} from './errors.js'
import { logOpenAiDiagnostic } from './logOpenAiDiagnostic.js'

export const OPENAI_QUOTA_EXCEEDED_MESSAGE =
  'AI answer service is temporarily unavailable because API quota or credits are exhausted. Please try again later.'

export interface MapOpenAiErrorOptions {
  scope: string
  provider?: string
  model?: string
  unavailableMessage: string
  failedMessage: string
}

export interface HttpErrorResponse {
  statusCode: number
  body: ApiErrorResponse
  /** Tokens the failed call was billed for; for the usage record only, never in `body`. */
  billedUsage?: BilledUsage
}

export function mapOpenAiErrorToHttpResponse(error: unknown, options: MapOpenAiErrorOptions): HttpErrorResponse {
  if (error instanceof MissingOpenAiApiKeyError) {
    return {
      statusCode: 503,
      body: { error: options.unavailableMessage },
    }
  }

  if (error instanceof OpenAiResponseError) {
    logOpenAiDiagnostic(options.scope, {
      provider: options.provider ?? 'openai',
      model: options.model ?? '(unknown)',
      responseStatus: error.status,
      errorCode: error.errorCode,
      errorMessage: error.message,
    })

    const billed = error.billedUsage ? { billedUsage: error.billedUsage } : {}

    if (isOpenAiQuotaExceededError(error)) {
      return {
        statusCode: 503,
        body: { error: OPENAI_QUOTA_EXCEEDED_MESSAGE },
        ...billed,
      }
    }

    return {
      statusCode: 502,
      body: { error: options.failedMessage },
      ...billed,
    }
  }

  throw error
}
