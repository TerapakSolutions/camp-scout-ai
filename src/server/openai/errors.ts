/**
 * Server-side OpenAI boundary errors.
 * These errors are safe to surface to callers without exposing secrets.
 */

export class MissingOpenAiApiKeyError extends Error {
  constructor(message = 'OPENAI_API_KEY is not configured. Set it in your server environment to use the OpenAI answer provider.') {
    super(message)
    this.name = 'MissingOpenAiApiKeyError'
  }
}

/**
 * AI_PROVIDER=gemini without its project or credentials. A subclass of the missing-key error on
 * purpose: every handler already answers that with a safe 503 "not available", so a missing Gemini
 * setting behaves exactly like a missing OpenAI key. Messages name settings, never their values.
 */
export class MissingGeminiConfigError extends MissingOpenAiApiKeyError {
  constructor(message = 'Gemini is not configured.') {
    super(message)
    this.name = 'MissingGeminiConfigError'
  }
}

export interface OpenAiResponseErrorDetails {
  status?: number
  errorCode?: string
}

export class OpenAiResponseError extends Error {
  status?: number
  errorCode?: string

  constructor(message: string, details: OpenAiResponseErrorDetails = {}) {
    super(message)
    this.name = 'OpenAiResponseError'
    this.status = details.status
    this.errorCode = details.errorCode
  }
}

export function isOpenAiQuotaExceededError(error: unknown): boolean {
  if (!(error instanceof OpenAiResponseError)) {
    return false
  }

  if (error.errorCode === 'insufficient_quota') {
    return true
  }

  // Vertex AI (Gemini): a 429 whose `error.status` is RESOURCE_EXHAUSTED is quota / capacity.
  if (error.errorCode === 'RESOURCE_EXHAUSTED') {
    return true
  }

  return error.status === 429 && error.errorCode === 'insufficient_quota'
}
