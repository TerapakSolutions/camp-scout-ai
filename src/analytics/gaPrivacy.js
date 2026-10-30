/**
 * What campscout sends to Google Analytics, and when. Side-effect free (no
 * import.meta) so it is unit tested; gtag.js is the only caller.
 *
 * - No cookies: every Consent Mode v2 storage signal defaults to denied and
 *   nothing grants it (Steve 2026-10-29: "No cookies then if possible").
 *   GA then receives cookieless pings only, so reports can be thin.
 * - page_location / page_path keep ONLY the campground filters below. The
 *   Stripe donation return URL carries ?session_id=cs_…, and search params can
 *   carry free text or coordinates — none of that may reach Google.
 * - Production host only: campscout.fly.dev serves the same build.
 */

export const CONSENT_DEFAULT = Object.freeze({
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
});

const PRODUCTION_HOST = 'campscout.terapak.com';
const ALLOWED_QUERY_KEYS = new Set(['region', 'amenity', 'tag']);

/** @param {string} hostname */
export function isProductionHost(hostname) {
  return hostname === PRODUCTION_HOST;
}

/** @param {URLSearchParams} params */
function keepAllowed(params) {
  const kept = new URLSearchParams();
  params.forEach((value, key) => {
    if (ALLOWED_QUERY_KEYS.has(key)) kept.append(key, value);
  });
  const qs = kept.toString();
  return qs ? `?${qs}` : '';
}

/** Full URL with only the allowed query keys and no hash; '' if unparsable. */
export function sanitizePageLocation(href) {
  try {
    const url = new URL(href);
    return `${url.origin}${url.pathname}${keepAllowed(url.searchParams)}`;
  } catch {
    return '';
  }
}

/** Path (+ allowed query keys) from a router path like "/x?a=1". */
export function sanitizePagePath(pathWithQuery) {
  const url = new URL(pathWithQuery, 'https://placeholder.invalid');
  return `${url.pathname}${keepAllowed(url.searchParams)}`;
}
