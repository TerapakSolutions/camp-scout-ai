/**
 * Temporary diagnostic logging for OpenAI answer provider failures.
 * Never logs secrets such as API keys.
 */

import { resolveActiveModel } from '../ai/aiProviderConfig.js'

export interface OpenAiDiagnosticDetails {
  provider?: string
  explicitProvider?: string | null
  envProvider?: string
  resolvedProvider?: string
  model?: string
  responseStatus?: number
  errorCode?: string
  errorMessage?: string
  apiKeyFingerprint?: string
  promptTokenEstimate?: number
  maxOutputTokens?: number
  contextTruncated?: boolean
}

function writeDiagnostic(label: string, payload: Record<string, unknown>): void {
  process.stderr.write(`${label} ${JSON.stringify(payload)}\n`)
}

export function describeOpenAiApiKey(apiKey: string | undefined): string {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    return '(missing)'
  }

  const trimmed = apiKey.trim()
  if (trimmed.length <= 8) {
    return '(configured)'
  }

  return `${trimmed.slice(0, 7)}...${trimmed.slice(-4)}`
}

export function logOpenAiDiagnostic(scope: string, details: OpenAiDiagnosticDetails = {}): void {
  const payload: Record<string, unknown> = {
    scope,
    provider: details.provider ?? details.resolvedProvider ?? 'openai',
    model: details.model ?? '(unknown)',
    responseStatus: details.responseStatus ?? null,
    errorCode: details.errorCode ?? null,
    errorMessage: details.errorMessage ?? null,
    apiKeyFingerprint: details.apiKeyFingerprint ?? describeOpenAiApiKey(process.env.OPENAI_API_KEY),
    promptTokenEstimate: details.promptTokenEstimate ?? null,
    maxOutputTokens: details.maxOutputTokens ?? null,
    contextTruncated: details.contextTruncated ?? null,
  }

  if (details.explicitProvider !== undefined) {
    payload.explicitProvider = details.explicitProvider
  }

  if (details.envProvider !== undefined) {
    payload.envProvider = details.envProvider
  }

  if (details.resolvedProvider !== undefined) {
    payload.resolvedProvider = details.resolvedProvider
  }

  writeDiagnostic('[OpenAI diagnostic]', payload)
}

export function logOpenAiEnvDiagnostic(scope: string): void {
  const provider = process.env.OPENAI_ANSWER_PROVIDER ?? '(unset)'
  const model = process.env.OPENAI_MODEL ?? '(unset, default gpt-4o-mini)'
  const baseUrl = process.env.OPENAI_BASE_URL ?? '(unset, default https://api.openai.com/v1)'
  const apiKey = process.env.OPENAI_API_KEY

  writeDiagnostic('[OpenAI env diagnostic]', {
    scope,
    OPENAI_ANSWER_PROVIDER: provider,
    OPENAI_MODEL: model,
    OPENAI_BASE_URL: baseUrl,
    OPENAI_API_KEY: describeOpenAiApiKey(apiKey),
    // Gemini (AI_PROVIDER=gemini): names and presence only, never credential values.
    AI_PROVIDER: process.env.AI_PROVIDER ?? '(unset, default openai)',
    activeModel: resolveActiveModel(),
    GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT ? '(configured)' : '(missing)',
    VERTEX_LOCATION: process.env.VERTEX_LOCATION ?? '(unset, default global)',
    GOOGLE_APPLICATION_CREDENTIALS_JSON: process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ? '(configured)' : '(missing)',
  })
}
