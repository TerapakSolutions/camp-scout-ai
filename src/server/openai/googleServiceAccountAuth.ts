/**
 * Google service-account JSON → OAuth access token for Vertex AI (RFC 7523 JWT bearer grant).
 *
 * Hand-rolled on node:crypto instead of google-auth-library: CampScout only ever holds a
 * service-account key (GOOGLE_APPLICATION_CREDENTIALS_JSON), which is the one ADC shape that needs
 * nothing but an RS256 signature and one POST. That keeps a dependency out of the prod image and
 * lets tests run the whole exchange against a mocked fetch with a throwaway key.
 *
 * Never logs or echoes the key, the assertion or the token.
 */

import { createHash, createSign } from 'node:crypto'
import { MissingGeminiConfigError, OpenAiResponseError } from './errors.js'

export const VERTEX_OAUTH_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
export const DEFAULT_GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const TOKEN_LIFETIME_SECONDS = 3600
/** Refresh this long before expiry, so a token never dies mid-request. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000
const TOKEN_TIMEOUT_MS = 15_000

export interface ServiceAccountCredentials {
  client_email: string
  private_key: string
  token_uri?: string
}

export interface AccessTokenOptions {
  fetchImpl?: typeof fetch
  now?: () => Date
}

interface CachedToken {
  accessToken: string
  expiresAtMs: number
}

const tokenCache = new Map<string, CachedToken>()

export function parseServiceAccountJson(raw: string): ServiceAccountCredentials {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new MissingGeminiConfigError('GOOGLE_APPLICATION_CREDENTIALS_JSON is set but is not valid JSON.')
  }

  const candidate = parsed as Partial<ServiceAccountCredentials> | null
  if (
    !candidate
    || typeof candidate.client_email !== 'string'
    || candidate.client_email.length === 0
    || typeof candidate.private_key !== 'string'
    || candidate.private_key.length === 0
  ) {
    throw new MissingGeminiConfigError(
      'GOOGLE_APPLICATION_CREDENTIALS_JSON must be a service-account key with client_email and private_key.',
    )
  }

  return {
    client_email: candidate.client_email,
    private_key: candidate.private_key,
    token_uri: typeof candidate.token_uri === 'string' && candidate.token_uri.length > 0
      ? candidate.token_uri
      : undefined,
  }
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function signAssertion(credentials: ServiceAccountCredentials, tokenUri: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(JSON.stringify({
    iss: credentials.client_email,
    scope: VERTEX_OAUTH_SCOPE,
    aud: tokenUri,
    iat,
    exp: iat + TOKEN_LIFETIME_SECONDS,
  }))
  const unsigned = `${header}.${claims}`
  let signature: Buffer
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(credentials.private_key)
  } catch {
    throw new MissingGeminiConfigError('GOOGLE_APPLICATION_CREDENTIALS_JSON private_key could not sign a token request.')
  }
  return `${unsigned}.${base64url(signature)}`
}

function cacheKey(credentials: ServiceAccountCredentials, tokenUri: string): string {
  // Hash, so the cache never holds the key itself as a map key.
  return createHash('sha256')
    .update(`${credentials.client_email}\n${tokenUri}\n${credentials.private_key}`)
    .digest('hex')
}

/**
 * Returns a cached access token, exchanging a freshly signed assertion when none is valid.
 * Config problems throw MissingGeminiConfigError (→ 503 "not available"); a rejected exchange throws
 * OpenAiResponseError carrying Google's OAuth error code (→ 502 "failed").
 */
export async function getServiceAccountAccessToken(
  credentialsJson: string,
  options: AccessTokenOptions = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => new Date())
  const credentials = parseServiceAccountJson(credentialsJson)
  const tokenUri = credentials.token_uri ?? DEFAULT_GOOGLE_TOKEN_URI
  const key = cacheKey(credentials, tokenUri)

  const cached = tokenCache.get(key)
  if (cached && now().getTime() < cached.expiresAtMs - REFRESH_MARGIN_MS) {
    return cached.accessToken
  }

  const issuedAt = now()
  const assertion = signAssertion(credentials, tokenUri, issuedAt)

  // Promise .catch(), not try/catch — see the note in geminiVertexClient.ts (Babel routed later
  // throws into an earlier catch block).
  const response = await fetchImpl(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  }).catch(() => null)
  if (!response) {
    throw new OpenAiResponseError('Google token request failed (network or timeout).', { errorCode: 'token_request_failed' })
  }

  const payload = await response.json().catch(() => ({})) as {
    access_token?: unknown
    expires_in?: unknown
    error?: unknown
  }

  if (!response.ok || typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    const errorCode = typeof payload.error === 'string' ? payload.error : 'token_exchange_failed'
    throw new OpenAiResponseError(`Google token exchange failed (${errorCode}).`, {
      status: response.status,
      errorCode,
    })
  }

  const expiresInSeconds = typeof payload.expires_in === 'number' && payload.expires_in > 0
    ? payload.expires_in
    : TOKEN_LIFETIME_SECONDS
  tokenCache.set(key, {
    accessToken: payload.access_token,
    expiresAtMs: issuedAt.getTime() + expiresInSeconds * 1000,
  })
  return payload.access_token
}

/** Test seam: the module-level cache would otherwise leak tokens across test cases. */
export function __resetGoogleTokenCacheForTests(): void {
  tokenCache.clear()
}
