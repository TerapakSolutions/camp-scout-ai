/**
 * Which AI vendor serves live answers, and which model that means.
 * Server-only; never import from React client code.
 *
 * TWO SETTINGS, TWO JOBS:
 *   OPENAI_ANSWER_PROVIDER — the LIVE/FAKE gate, unchanged. Only `openai` means "make paid calls";
 *     unset or anything else is the free fake provider. Despite its name it now means "live".
 *   AI_PROVIDER — which vendor a LIVE call goes to: `gemini`, otherwise OpenAI (the default when
 *     unset, so merging this changes nothing). It can never turn the fake provider into a paid one.
 *
 * Every budget, pricing and threshold check keys on the provider name `openai` meaning "live, paid".
 * Gemini rides that same name on purpose, so no guard needed editing and none can be missed; the
 * vendor shows in the `model` field (and the provider instance's own name, `gemini`).
 *
 * REMOVE WHEN: gpt-4o-mini shuts down (2027-01-14) and OpenAI is no longer a rollback target.
 * OWNER: Steve. REVIEW BY: 2027-01-14.
 */

import { DEFAULT_OPENAI_MODEL } from '../openai/answerProvider.js'

export const AI_PROVIDER_ENV = 'AI_PROVIDER'
export const GEMINI_MODEL_ENV = 'GEMINI_MODEL'
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'

export type AiVendor = 'openai' | 'gemini'

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** `gemini` selects Gemini; unset, `openai` or any other value stays on OpenAI (the rollback vendor). */
export function resolveAiVendor(): AiVendor {
  return nonEmpty(process.env[AI_PROVIDER_ENV])?.toLowerCase() === 'gemini' ? 'gemini' : 'openai'
}

export function resolveGeminiModel(): string {
  return nonEmpty(process.env[GEMINI_MODEL_ENV]) ?? DEFAULT_GEMINI_MODEL
}

/** The model a live call would use right now — for diagnostics, error logs and pricing fallbacks. */
export function resolveActiveModel(): string {
  if (resolveAiVendor() === 'gemini') {
    return resolveGeminiModel()
  }
  return nonEmpty(process.env.OPENAI_MODEL) ?? DEFAULT_OPENAI_MODEL
}
