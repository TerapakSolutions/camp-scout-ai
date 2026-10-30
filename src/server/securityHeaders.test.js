import { CONTENT_SECURITY_POLICY } from './securityHeaders'

/**
 * @param {string} name
 * @returns {string[]}
 */
function directive(name) {
  const found = CONTENT_SECURITY_POLICY.split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([key]) => key === name)
  if (!found) throw new Error(`CSP has no ${name} directive`)
  return found.slice(1)
}

describe('CONTENT_SECURITY_POLICY', () => {
  // GA4 is loaded by injecting https://www.googletagmanager.com/gtag/js. Under
  // script-src 'self' the browser refuses that script, so the dataLayer fills
  // and nothing is ever sent to Google (GA4 shows "no data received").
  it('lets the Google tag (gtag.js) load from googletagmanager.com', () => {
    expect(directive('script-src')).toEqual(
      expect.arrayContaining(["'self'", 'https://*.googletagmanager.com']),
    )
  })

  it('does not open script-src to arbitrary origins', () => {
    const sources = directive('script-src')
    expect(sources).not.toContain('https:')
    expect(sources).not.toContain('*')
    expect(sources).not.toContain("'unsafe-inline'")
    expect(sources).not.toContain("'unsafe-eval'")
  })

  it('lets GA4 send hits (connect-src and img-src cover google-analytics.com)', () => {
    // `https:` scheme source covers *.google-analytics.com,
    // *.analytics.google.com and region1.google-analytics.com.
    expect(directive('connect-src')).toContain('https:')
    expect(directive('img-src')).toContain('https:')
  })

  it('keeps clickjacking protection', () => {
    expect(directive('frame-ancestors')).toEqual(["'none'"])
  })
})
