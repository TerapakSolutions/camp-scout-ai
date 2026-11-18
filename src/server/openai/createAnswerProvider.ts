/**
 * Factory for server-side answer providers.
 * Defaults to the fake provider so tests and local runs stay free of paid API calls.
 *
 * OPENAI_ANSWER_PROVIDER decides live vs fake (only `openai` is live); when live, AI_PROVIDER picks
 * the vendor (`gemini`, else OpenAI). See src/server/ai/aiProviderConfig.ts.
 */

import { isAiEnabled } from '../ai/aiConfig.js'
import { resolveAiVendor } from '../ai/aiProviderConfig.js'
import { logAiDisabled } from '../ai/aiRequestLogger.js'
import type { AnswerProvider } from './answerProvider.js'
import { createFakeAnswerProvider } from './fakeAnswerProvider.js'
import { createGeminiAnswerProvider, type GeminiAnswerProviderOptions } from './geminiVertexClient.js'
import { logOpenAiDiagnostic } from './logOpenAiDiagnostic.js'
import { createOpenAiAnswerProvider, type OpenAiAnswerProviderOptions } from './openAiResponsesClient.js'

export const ANSWER_PROVIDER_ENV = 'OPENAI_ANSWER_PROVIDER'

/** `openai` means LIVE (a paid call); which vendor serves it is AI_PROVIDER's job. */
export type AnswerProviderName = 'fake' | 'openai'

export interface CreateAnswerProviderOptions extends OpenAiAnswerProviderOptions {
  provider?: AnswerProviderName
  protectedAccess?: boolean
  gemini?: GeminiAnswerProviderOptions
}

export function resolveAnswerProviderName(
  explicitProvider: string | undefined,
  options: { protectedAccess?: boolean } = {},
): AnswerProviderName {
  if (!options.protectedAccess) {
    return 'fake'
  }

  if (!isAiEnabled()) {
    logAiDisabled('resolveAnswerProviderName')
    return 'fake'
  }

  const configured = explicitProvider ?? process.env[ANSWER_PROVIDER_ENV] ?? 'fake'
  return configured === 'openai' ? 'openai' : 'fake'
}

export function createAnswerProvider(options: CreateAnswerProviderOptions = {}): AnswerProvider {
  const providerName = resolveAnswerProviderName(options.provider, {
    protectedAccess: options.protectedAccess === true,
  })

  logOpenAiDiagnostic('createAnswerProvider', {
    explicitProvider: options.provider ?? null,
    envProvider: process.env[ANSWER_PROVIDER_ENV] ?? '(unset)',
    resolvedProvider: providerName,
  })

  if (providerName === 'openai') {
    if (resolveAiVendor() === 'gemini') {
      return createGeminiAnswerProvider({
        fetchImpl: options.fetchImpl,
        defaultMaxOutputTokens: options.defaultMaxOutputTokens,
        ...options.gemini,
      })
    }
    return createOpenAiAnswerProvider(options)
  }

  return createFakeAnswerProvider()
}
