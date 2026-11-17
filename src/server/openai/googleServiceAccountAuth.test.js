/** @jest-environment node */

/**
 * Service-account → OAuth access token (RFC 7523 JWT bearer), against a mocked token endpoint.
 * The key pair is generated per run: a throwaway, never a real credential.
 */

import { createVerify, generateKeyPairSync } from 'crypto'
import { MissingGeminiConfigError, OpenAiResponseError } from './errors.js'
import {
  VERTEX_OAUTH_SCOPE,
  __resetGoogleTokenCacheForTests,
  getServiceAccountAccessToken,
  parseServiceAccountJson,
} from './googleServiceAccountAuth.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const SA = {
  type: 'service_account',
  project_id: 'example-project',
  client_email: 'campscout-test@example-project.iam.gserviceaccount.com',
  private_key: privateKey,
  token_uri: 'https://oauth2.googleapis.com/token',
}
const SA_JSON = JSON.stringify(SA)

function tokenResponse(accessToken, expiresIn = 3599) {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue({ access_token: accessToken, expires_in: expiresIn, token_type: 'Bearer' }),
  }
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
}

beforeEach(() => {
  __resetGoogleTokenCacheForTests()
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('parseServiceAccountJson', () => {
  it('rejects invalid JSON as a config error without echoing the value', () => {
    const error = (() => { try { parseServiceAccountJson('{"private_key":"SECRET-VALUE"') } catch (caught) { return caught } })()
    expect(error).toBeInstanceOf(MissingGeminiConfigError)
    expect(error.message).not.toContain('SECRET-VALUE')
  })

  it('rejects JSON without client_email or private_key', () => {
    expect(() => parseServiceAccountJson(JSON.stringify({ type: 'service_account' }))).toThrow(MissingGeminiConfigError)
  })
})

describe('getServiceAccountAccessToken', () => {
  it('posts an RS256-signed JWT assertion with the Vertex scope and returns the access token', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(tokenResponse('ya29.first'))
    const now = new Date('2026-11-17T12:00:00Z')

    const token = await getServiceAccountAccessToken(SA_JSON, { fetchImpl, now: () => now })
    expect(token).toBe('ya29.first')

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(init.body)
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')

    const [header, claims, signature] = form.get('assertion').split('.')
    expect(decodeSegment(header)).toEqual({ alg: 'RS256', typ: 'JWT' })
    const iat = Math.floor(now.getTime() / 1000)
    expect(decodeSegment(claims)).toEqual({
      iss: SA.client_email,
      scope: VERTEX_OAUTH_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 3600,
    })

    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${header}.${claims}`)
    expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true)
  })

  it('caches the token until five minutes before expiry, then refreshes', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(tokenResponse('ya29.first', 3600))
      .mockResolvedValueOnce(tokenResponse('ya29.second', 3600))
    let clock = new Date('2026-11-17T12:00:00Z').getTime()
    const now = () => new Date(clock)

    expect(await getServiceAccountAccessToken(SA_JSON, { fetchImpl, now })).toBe('ya29.first')
    clock += 54 * 60 * 1000
    expect(await getServiceAccountAccessToken(SA_JSON, { fetchImpl, now })).toBe('ya29.first')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    clock += 2 * 60 * 1000
    expect(await getServiceAccountAccessToken(SA_JSON, { fetchImpl, now })).toBe('ya29.second')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('surfaces a rejected exchange as a failed request carrying the OAuth error code, never the key', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: jest.fn().mockResolvedValue({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }),
    })
    const error = await getServiceAccountAccessToken(SA_JSON, { fetchImpl }).catch((caught) => caught)
    expect(error).toBeInstanceOf(OpenAiResponseError)
    expect(error.errorCode).toBe('invalid_grant')
    expect(error.message).not.toContain('PRIVATE KEY')

    // A failure is not cached: the next call tries again.
    fetchImpl.mockResolvedValueOnce(tokenResponse('ya29.recovered'))
    expect(await getServiceAccountAccessToken(SA_JSON, { fetchImpl })).toBe('ya29.recovered')
  })

  it('logs nothing that contains the private key or the token', async () => {
    const written = []
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => { written.push(String(chunk)); return true })
    for (const method of ['log', 'info', 'warn', 'error']) {
      jest.spyOn(console, method).mockImplementation((...args) => { written.push(args.join(' ')) })
    }
    const fetchImpl = jest.fn().mockResolvedValue(tokenResponse('ya29.secret-token'))
    await getServiceAccountAccessToken(SA_JSON, { fetchImpl })
    const all = written.join('\n')
    expect(all).not.toContain('ya29.secret-token')
    expect(all).not.toContain('PRIVATE KEY')
  })
})
