/**
 * What campscout sends to Google Analytics, and when. Side-effect free (no
 * import.meta) so it is unit tested; gtag.js is the only caller.
 *
 * - Analytics cookies ON outside the EEA/UK/CH (Steve 2026-10-29, option A).
 *   Cookieless shipped first (PR #67) and GA4 Realtime showed 0 users, because
 *   unconsented pings are not reported. So the global Consent Mode v2 default
 *   grants analytics_storage, while every ad signal stays denied everywhere.
 * - EEA + UK + CH get a region-scoped default with all four signals denied:
 *   there is no consent banner, so nothing ever grants it there and those
 *   visitors send cookieless pings only. gtag.js sets this region default
 *   BEFORE the global one; GA applies the most specific matching region.
 * - page_location / page_path keep ONLY the campground filters below. The
 *   Stripe donation return URL carries ?session_id=cs_…, and search params can
 *   carry free text or coordinates — none of that may reach Google.
 * - Production host only: campscout.fly.dev serves the same build.
 */

/** EU-27 + the other EEA states (IS, LI, NO) + UK + Switzerland. */
const EEA_UK_CH = Object.freeze([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
  'GB', 'CH',
]);

export const CONSENT_REGION_DENIED = Object.freeze({
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
  region: EEA_UK_CH,
});

export const CONSENT_DEFAULT = Object.freeze({
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'granted',
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
