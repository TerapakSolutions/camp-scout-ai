/**
 * Server-side Gemini answer provider over Vertex AI `generateContent` (the native API, plain fetch).
 * Same AnswerProvider contract and the same error types as the OpenAI client, so every handler,
 * budget check and error mapping treats both vendors alike.
 *
 * Pattern from trend-tagger (`utils/vertexEndpoint.ts`, `services/aiInferenceService.ts`) and
 * Lookout (`services/ai/llmProvider.ts`) — read, not imported.
 */

import { resolveGeminiModel } from '../ai/aiProviderConfig.js'
import type { AnswerProvider } from './answerProvider.js'
import { MissingGeminiConfigError, OpenAiResponseError, type BilledUsage } from './errors.js'
import { getServiceAccountAccessToken } from './googleServiceAccountAuth.js'
import { logOpenAiDiagnostic } from './logOpenAiDiagnostic.js'
import {
  estimateTokenCount,
  resolveMaxContextTokens,
  resolveMaxOutputTokens,
  truncateTextToTokenBudget,
} from './promptLimits.js'

export const GOOGLE_CLOUD_PROJECT_ENV = 'GOOGLE_CLOUD_PROJECT'
export const VERTEX_LOCATION_ENV = 'VERTEX_LOCATION'
export const GOOGLE_APPLICATION_CREDENTIALS_JSON_ENV = 'GOOGLE_APPLICATION_CREDENTIALS_JSON'
/** gemini-3.8-flash is served on `global` (and the `us`/`eu` multi-regions), not on us-central1. */
export const DEFAULT_VERTEX_LOCATION = 'global'

/**
 * gemini-3.8-flash thinks by default (MEDIUM) and bills thoughts as output. LOW is its cheapest level:
 * MINIMAL is rejected by this model. Vertex REST enum value, upper case (GenerationConfig.ThinkingConfig).
 * No thinkingBudget is sent: sending both fields is an error on Gemini 3+.
 */
export const GEMINI_THINKING_LEVEL = 'LOW'

/**
 * Added on top of the answer cap in maxOutputTokens. Google's docs do not say whether thinking
 * counts against maxOutputTokens; field reports say it does on Gemini 3 (an exhausted budget returns
 * finishReason MAX_TOKENS with no text). Headroom keeps LOW thinking from eating the answer. Worst
 * case per request at the 800-token default: (800 + 1024) × $3.75/1M ≈ $0.0068 output.
 */
export const GEMINI_THINKING_HEADROOM_TOKENS = 1024

const VERTEX_TIMEOUT_MS = 30_000

export interface GeminiAnswerProviderOptions {
  fetchImpl?: typeof fetch
  /** Test seam: replaces the service-account token exchange. */
  getAccessToken?: () => Promise<string>
  project?: string
  location?: string
  credentialsJson?: string
  defaultModel?: string
  defaultMaxOutputTokens?: number
}

interface GeminiPart {
  text?: string
  thought?: boolean
}

interface GeminiResponsePayload {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] }
    finishReason?: string
  }>
  promptFeedback?: { blockReason?: string }
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
    totalTokenCount?: number
  }
  modelVersion?: string
  responseId?: string
  error?: { code?: number, message?: string, status?: string }
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function normaliseLocation(location: string): string {
  return location.trim().toLowerCase()
}

/** `global` is served from aiplatform.googleapis.com; a region from `{region}-aiplatform.googleapis.com`. */
export function vertexGenerateContentUrl(project: string, location: string, model: string): string {
  const loc = normaliseLocation(location)
  const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`
  return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${loc}`
    + `/publishers/google/models/${encodeURIComponent(model)}:generateContent`
}

interface ResolvedGeminiConfig {
  project: string
  location: string
  credentialsJson: string
}

/** Validated when a request runs, never at boot: a missing setting must not stop the server. */
function resolveGeminiConfig(options: GeminiAnswerProviderOptions): ResolvedGeminiConfig {
  const project = nonEmpty(options.project) ?? nonEmpty(process.env[GOOGLE_CLOUD_PROJECT_ENV])
  const location = nonEmpty(options.location) ?? nonEmpty(process.env[VERTEX_LOCATION_ENV]) ?? DEFAULT_VERTEX_LOCATION
  const credentialsJson = nonEmpty(options.credentialsJson)
    ?? nonEmpty(process.env[GOOGLE_APPLICATION_CREDENTIALS_JSON_ENV])

  const missing: string[] = []
  if (!project) missing.push(GOOGLE_CLOUD_PROJECT_ENV)
  if (!credentialsJson) missing.push(GOOGLE_APPLICATION_CREDENTIALS_JSON_ENV)
  if (missing.length > 0 || !project || !credentialsJson) {
    throw new MissingGeminiConfigError(
      `AI_PROVIDER=gemini but Gemini is not configured: set ${missing.join(' and ')}.`,
    )
  }
  return { project, location, credentialsJson }
}

function extractGeminiText(payload: GeminiResponsePayload): string {
  const parts = payload?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((part) => part && part.thought !== true && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
    .trim()
}

/** Thinking tokens are billed at the output rate and are NOT in candidatesTokenCount. */
function billableOutputTokens(usage: GeminiResponsePayload['usageMetadata']): number | undefined {
  const candidates = usage?.candidatesTokenCount
  const thoughts = usage?.thoughtsTokenCount
  if (typeof candidates !== 'number' && typeof thoughts !== 'number') return undefined
  return (typeof candidates === 'number' ? candidates : 0) + (typeof thoughts === 'number' ? thoughts : 0)
}

export function createGeminiAnswerProvider(options: GeminiAnswerProviderOptions = {}): AnswerProvider {
  const fetchImpl = options.fetchImpl ?? fetch
  const defaultMaxOutputTokens = resolveMaxOutputTokens(options.defaultMaxOutputTokens)

  return {
    name: 'gemini',
    async generateAnswer(request) {
      const defaultModel = nonEmpty(options.defaultModel) ?? resolveGeminiModel()
      const rawInput = typeof request?.input === 'string' ? request.input.trim() : ''
      if (rawInput.length === 0) {
        throw new OpenAiResponseError('Answer generation requires non-empty input.')
      }

      const config = resolveGeminiConfig(options)
      const model = nonEmpty(request?.model) ?? defaultModel
      const maxOutputTokens = resolveMaxOutputTokens(request?.maxOutputTokens, defaultMaxOutputTokens)
      const cappedInput = truncateTextToTokenBudget(rawInput, resolveMaxContextTokens())
      const input = cappedInput.text

      logOpenAiDiagnostic('gemini.generateAnswer.request', {
        provider: 'gemini',
        model,
        apiKeyFingerprint: '(service account)',
        promptTokenEstimate: estimateTokenCount(input),
        maxOutputTokens,
        contextTruncated: cappedInput.truncated,
      })

      const body: Record<string, unknown> = {
        // `role` is required by Vertex (400 INVALID_ARGUMENT without it).
        contents: [{ role: 'user', parts: [{ text: input }] }],
        generationConfig: {
          maxOutputTokens: maxOutputTokens + GEMINI_THINKING_HEADROOM_TOKENS,
          thinkingConfig: { thinkingLevel: GEMINI_THINKING_LEVEL },
        },
      }
      const instructions = nonEmpty(request?.instructions)
      if (instructions) {
        body.systemInstruction = { parts: [{ text: instructions }] }
      }

      const accessToken = options.getAccessToken
        ? await options.getAccessToken()
        : await getServiceAccountAccessToken(config.credentialsJson, { fetchImpl })

      const fail = (
        scope: string,
        message: string,
        details: { status?: number, errorCode?: string, billedUsage?: BilledUsage } = {},
      ) => {
        logOpenAiDiagnostic(`gemini.generateAnswer.${scope}`, {
          provider: 'gemini',
          model,
          apiKeyFingerprint: '(service account)',
          responseStatus: details.status,
          errorCode: details.errorCode,
          errorMessage: message,
        })
        return new OpenAiResponseError(message, details)
      }

      // Promise .catch(), not try/catch: under the Babel transform jest uses, a later `throw` in this
      // async function was routed into an earlier `catch {}` block (measured 2026-11-17), so every
      // HTTP error surfaced as "non-JSON". `.catch()` behaves the same under Babel and Node.
      const response = await fetchImpl(vertexGenerateContentUrl(config.project, config.location, model), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(VERTEX_TIMEOUT_MS),
      }).catch(() => null)
      if (!response) {
        throw fail('networkError', 'Gemini request failed (network or timeout).', { errorCode: 'network_error' })
      }

      const payload = await response.json().catch(() => null) as GeminiResponsePayload | null
      if (!payload || typeof payload !== 'object') {
        throw fail('nonJsonResponse', 'Gemini returned a non-JSON response.', { status: response.status })
      }

      if (!response.ok || payload?.error) {
        // Google's error body: { error: { code: <number>, message, status: "RESOURCE_EXHAUSTED" } }.
        // `code` is numeric, so the string status is the error code we carry.
        const message = typeof payload?.error?.message === 'string'
          ? payload.error.message
          : `Gemini request failed with status ${response.status}.`
        const errorCode = typeof payload?.error?.status === 'string' ? payload.error.status : undefined
        throw fail('httpError', message, { status: response.status, errorCode })
      }

      const text = extractGeminiText(payload)
      if (text.length === 0) {
        const finishReason = payload?.candidates?.[0]?.finishReason
          ?? payload?.promptFeedback?.blockReason
          ?? 'unknown'
        const message = finishReason === 'MAX_TOKENS'
          ? 'Gemini used its whole output budget (thinking included) before answering.'
          : `Gemini returned an empty answer (finishReason=${finishReason}).`
        // Still billed: prompt + thinking. Carry the usage so the budget records the real cost.
        const usage = payload?.usageMetadata
        const billedUsage: BilledUsage | undefined = usage && typeof usage === 'object'
          ? {
            inputTokens: typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : undefined,
            outputTokens: billableOutputTokens(usage),
            model: nonEmpty(payload?.modelVersion) ?? model,
          }
          : undefined
        throw fail('emptyAnswer', message, { status: response.status, errorCode: finishReason, billedUsage })
      }

      const usage = payload?.usageMetadata
      const outputTokens = billableOutputTokens(usage)
      const servedModel = nonEmpty(payload?.modelVersion) ?? model

      logOpenAiDiagnostic('gemini.generateAnswer.success', {
        provider: 'gemini',
        model: servedModel,
        apiKeyFingerprint: '(service account)',
        responseStatus: response.status,
        promptTokenEstimate: typeof usage?.promptTokenCount === 'number'
          ? usage.promptTokenCount
          : estimateTokenCount(input),
        maxOutputTokens,
      })

      return {
        text,
        model: servedModel,
        inputTokens: typeof usage?.promptTokenCount === 'number' ? usage.promptTokenCount : undefined,
        outputTokens,
        responseId: typeof payload?.responseId === 'string' ? payload.responseId : undefined,
      }
    },
  }
}
