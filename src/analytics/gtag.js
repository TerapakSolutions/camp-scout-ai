/**
 * Google Analytics 4 (gtag.js) loader for the campscout SPA.
 *
 * Why a module and not a hardcoded <script> in index.html:
 *  - The Measurement ID comes from VITE_GA_MEASUREMENT_ID at build time, so the
 *    same source works with no analytics locally (id unset -> everything no-ops)
 *    and with analytics in production.
 *  - The app sits behind a sign-in gate that lives OUTSIDE the router. Loading
 *    gtag here, from the app entry before render, means the initial page_view
 *    fires for EVERY landing — including visitors who bounce at the gate. That is
 *    exactly the traffic we care about (e.g. a LinkedIn click that never signs
 *    in), which router-level tracking alone would miss.
 *
 * A GA4 Measurement ID (G-XXXXXXX) is public by design — it ships in the page of
 * every site using GA — so it is a build arg, not a secret.
 */

import {
  CONSENT_DEFAULT,
  CONSENT_REGION_DENIED,
  isProductionHost,
  sanitizePageLocation,
  sanitizePagePath,
} from './gaPrivacy.js';

const MEASUREMENT_ID = import.meta.env.VITE_GA_MEASUREMENT_ID;

let initialised = false;

/** True once a real Measurement ID is configured and gtag has been injected. */
export function analyticsEnabled() {
  return initialised;
}

/**
 * Inject gtag.js and send the first page_view. Safe to call once at app start.
 * No-ops when VITE_GA_MEASUREMENT_ID is unset (local dev, or before setup).
 */
export function initAnalytics() {
  if (initialised || !MEASUREMENT_ID) {
    return;
  }
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return; // server render / prerender — nothing to do
  }
  // campscout.fly.dev and localhost serve the same build: count production only.
  if (!isProductionHost(window.location.hostname)) {
    return;
  }

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(script);

  // `window.gtag`/`window.dataLayer` are injected globals not in the DOM types;
  // cast to any here rather than augmenting Window project-wide.
  const w = /** @type {any} */ (window);
  w.dataLayer = w.dataLayer || [];
  // gtag must push `arguments` (not a rest array) — GA reads the arguments object.
  function gtag() {
    w.dataLayer.push(arguments);
  }
  w.gtag = gtag;

  // Consent defaults before anything else is sent (see gaPrivacy.js): EEA/UK/CH
  // first with everything denied, then the global default (analytics cookies
  // granted, every ad signal denied).
  gtag('consent', 'default', CONSENT_REGION_DENIED);
  gtag('consent', 'default', CONSENT_DEFAULT);
  gtag('js', new Date());
  // Default send_page_view:true fires the landing page_view here, which is what
  // records the referral source (LinkedIn, Google, direct) for the session.
  // page_location is sanitized so e.g. the Stripe ?session_id= never reaches Google.
  gtag('config', MEASUREMENT_ID, {
    page_location: sanitizePageLocation(w.location.href),
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });

  initialised = true;
}

/**
 * Record a page_view for an in-app (client-side) navigation. GA4 does not fire
 * these automatically in an SPA. No-op until initAnalytics has run.
 */
export function trackPageView(path) {
  const w = /** @type {any} */ (typeof window === 'undefined' ? null : window);
  if (!initialised || !w || !w.gtag) {
    return;
  }
  w.gtag('event', 'page_view', {
    page_path: sanitizePagePath(path),
    page_location: sanitizePageLocation(w.location.href),
  });
}
