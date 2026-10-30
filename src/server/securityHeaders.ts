import type { ServerResponse } from 'node:http'

/**
 * Baseline security headers for the production server (server/production.mjs).
 * Kept in its own side-effect-free module so the policy can be unit tested.
 */

// script-src is the real protection: same-origin Vite bundles, plus the one
// external script we load on purpose, Google's GA4 tag (gtag.js from
// www.googletagmanager.com; *.googletagmanager.com per Google's GA4 CSP guide).
// Without it the browser refuses gtag.js and GA4 receives nothing.
// img/connect stay permissive (`https:`) so external campground images,
// Supabase calls and GA4 hits (*.google-analytics.com, *.analytics.google.com)
// keep working. frame-ancestors blocks clickjacking.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://*.googletagmanager.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self' https:",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

/** Applies baseline security headers to every response. */
export function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains')
}
