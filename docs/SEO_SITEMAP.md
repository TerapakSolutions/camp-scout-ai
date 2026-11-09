# Sitemap and Search Console Setup

This project generates sitemaps automatically during the build step.

## CampScout (`campscout.terapak.com`)

Build output includes:

- `https://campscout.terapak.com/sitemap.xml`
- `https://campscout.terapak.com/robots.txt`

Generation runs after every `npm run build` and `npm run build:fly` via `scripts/generate-sitemap.mjs`.

### Included public pages

- `/` (home)
- `/campgrounds`
- `/support`
- `/campgrounds/{id}` for each campground in `src/data/campgrounds.js`

These are the pages a signed-out visitor (and Googlebot) can browse. The allow-list lives in
`src/AppRoutes.jsx` (`isPublicPath`); every other route shows the sign-in screen when signed out.
Each public page sets its own `<title>`, meta description and absolute `<link rel="canonical">`
client-side (`src/utils/seo.js`). Gated routes and unknown campground ids set
`<meta name="robots" content="noindex">` and no canonical.

### Excluded routes

- `/retrieval` (sign-in required)
- `/watches` (sign-in required)
- `/settings`
- `/donation-success`
- `/donation-cancel`
- `/api/*`

### Verify locally

```bash
npm run build:fly
curl -I http://127.0.0.1:8080/sitemap.xml
curl -I http://127.0.0.1:8080/robots.txt
npm start
```

Both endpoints should return HTTP 200 with `application/xml` and `text/plain` content types.

## Terapak.com

Terapak.com is hosted separately from this repository. Generate deployable static files with:

```bash
npm run generate:terapak-sitemap
```

This writes:

- `terapak-static/sitemap.xml`
- `terapak-static/robots.txt`

Deploy those files to the Terapak.com static host so they are served at:

- `https://terapak.com/sitemap.xml`
- `https://terapak.com/robots.txt`

Included pages: `/`, `/projects`, `/about`.

## Google Search Console

After deployment:

1. Open [Google Search Console](https://search.google.com/search-console).
2. Select the property (`campscout.terapak.com` or `terapak.com`).
3. Go to **Sitemaps**.
4. Submit:
   - `https://campscout.terapak.com/sitemap.xml`
   - `https://terapak.com/sitemap.xml`
5. Confirm status shows **Success** with no fetch or parsing errors.

CampScout already has a Search Console verification file at `docs/googlec5d06d6ca943a592.html`.
