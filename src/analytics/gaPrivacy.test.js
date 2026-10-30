import fs from 'node:fs';
import path from 'node:path';
import {
  CONSENT_DEFAULT,
  CONSENT_REGION_DENIED,
  isProductionHost,
  sanitizePageLocation,
  sanitizePagePath,
} from './gaPrivacy';

// Why: GA4 on campscout was blocked by CSP (script-src 'self'); fixing the CSP
// makes collection real, so what is sent must be safe first. Cookieless shipped
// first (PR #67) and GA4 Realtime then showed 0 users — unconsented pings are
// not reported — so Steve 2026-10-29 chose analytics cookies ON outside the
// EEA/UK/CH, with every ad signal still denied everywhere. The Stripe donation return URL carries ?session_id=cs_…, which
// would otherwise reach Google in page_location.
describe('GA4 privacy for campscout', () => {
  it('global default grants analytics cookies and denies every ad signal', () => {
    expect(CONSENT_DEFAULT).toEqual({
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'granted',
    });
  });

  it('region default denies all four signals across the EEA, UK and CH', () => {
    const { region, ...signals } = CONSENT_REGION_DENIED;
    expect(signals).toEqual({
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
    });
    expect(region).toEqual(expect.arrayContaining(['DE', 'FR', 'GB', 'CH', 'NO']));
    // EU-27 + EEA (IS, LI, NO) + UK + CH = 32 ISO 3166-1 alpha-2 codes, no dupes.
    expect(new Set(region).size).toBe(32);
    expect(region).toHaveLength(32);
    region.forEach((code) => expect(code).toMatch(/^[A-Z]{2}$/));
    expect(region).not.toContain('US');
  });

  it('drops the Stripe checkout session id from the donation return URL', () => {
    expect(
      sanitizePageLocation('https://campscout.terapak.com/donation-success?session_id=cs_live_a1B2c3'),
    ).toBe('https://campscout.terapak.com/donation-success');
  });

  it('keeps only region, amenity and tag filters, and drops the hash', () => {
    expect(
      sanitizePageLocation(
        'https://campscout.terapak.com/campgrounds?region=sierra&amenity=water&tag=lake&q=my+secret+spot&lat=38.7&lng=-120.6&email=a%40b.com#x',
      ),
    ).toBe('https://campscout.terapak.com/campgrounds?region=sierra&amenity=water&tag=lake');
  });

  it('page_path keeps the same allow-list', () => {
    expect(sanitizePagePath('/campgrounds?tag=lake&code=oauth123')).toBe('/campgrounds?tag=lake');
    expect(sanitizePagePath('/donation-success?session_id=cs_1')).toBe('/donation-success');
  });

  it('an unparsable location sends nothing identifying', () => {
    expect(sanitizePageLocation('not a url')).toBe('');
  });

  it('loads only on the production host — not fly.dev, not localhost', () => {
    expect(isProductionHost('campscout.terapak.com')).toBe(true);
    expect(isProductionHost('campscout.fly.dev')).toBe(false);
    expect(isProductionHost('localhost')).toBe(false);
    expect(isProductionHost('evil-campscout.terapak.com.example')).toBe(false);
  });
});

describe('wiring in gtag.js', () => {
  const src = fs.readFileSync(path.join(__dirname, 'gtag.js'), 'utf8');

  it('sets the region default, then the global default, both BEFORE js and config', () => {
    const region = src.indexOf("gtag('consent', 'default', CONSENT_REGION_DENIED)");
    const global = src.indexOf("gtag('consent', 'default', CONSENT_DEFAULT)");
    const js = src.indexOf("gtag('js'");
    const config = src.indexOf("gtag('config'");
    expect(region).toBeGreaterThan(-1);
    expect(global).toBeGreaterThan(region);
    expect(js).toBeGreaterThan(global);
    expect(config).toBeGreaterThan(global);
  });

  it('keeps Google Signals and ad personalisation off', () => {
    expect(src).toMatch(/allow_google_signals:\s*false/);
    expect(src).toMatch(/allow_ad_personalization_signals:\s*false/);
  });

  it('never sends the raw location — config and page_view use the sanitizers', () => {
    expect(src).not.toMatch(/page_location:\s*w\.location\.href/);
    expect(src).toMatch(/sanitizePageLocation\(/);
    expect(src).toMatch(/sanitizePagePath\(/);
  });

  it('gates on the production host', () => {
    expect(src).toMatch(/isProductionHost\(/);
  });
});
