import fs from 'node:fs';
import path from 'node:path';
import {
  CONSENT_DEFAULT,
  isProductionHost,
  sanitizePageLocation,
  sanitizePagePath,
} from './gaPrivacy';

// Why: GA4 on campscout was blocked by CSP (script-src 'self'); fixing the CSP
// makes collection real, so what is sent must be safe first (Steve 2026-10-29:
// no cookies). The Stripe donation return URL carries ?session_id=cs_…, which
// would otherwise reach Google in page_location.
describe('GA4 privacy for campscout', () => {
  it('denies every storage signal by default — no GA cookies', () => {
    expect(CONSENT_DEFAULT).toEqual({
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
    });
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

  it('sets consent default BEFORE config', () => {
    const consent = src.indexOf("gtag('consent', 'default', CONSENT_DEFAULT)");
    const config = src.indexOf("gtag('config'");
    expect(consent).toBeGreaterThan(-1);
    expect(config).toBeGreaterThan(consent);
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
