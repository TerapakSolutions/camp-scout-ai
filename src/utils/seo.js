/**
 * Client-side per-page head tags (Google renders JS). Every call fully sets the
 * page's SEO state, so nothing leaks from the previous page:
 *   - indexable page: title, description, absolute canonical; robots meta removed
 *   - noindex page:   title, robots=noindex; canonical removed
 */
export const SITE_ORIGIN = 'https://campscout.terapak.com'
export const SITE_NAME = 'Camp Scout AI'
export const DEFAULT_DESCRIPTION =
  'Camp Scout AI — browse real Northern California campgrounds from official park sources.'

/** @param {string} path */
export function buildCanonicalUrl(path) {
  const clean = `/${String(path).replace(/^\/+/, '').replace(/\/+$/, '')}`
  return clean === '/' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${clean}`
}

/** @param {string} name @param {string} content */
function upsertMeta(name, content) {
  let el = document.head.querySelector(`meta[name="${name}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute('name', name)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

/** @param {string} href */
function upsertCanonical(href) {
  let el = document.head.querySelector('link[rel="canonical"]')
  if (!el) {
    el = document.createElement('link')
    el.setAttribute('rel', 'canonical')
    document.head.appendChild(el)
  }
  el.setAttribute('href', href)
}

/**
 * @param {{ title: string, description?: string, path?: string, noindex?: boolean }} seo
 *   `path` is the page's fixed route path (never location.search) and is required
 *   unless `noindex` is set.
 */
export function applyPageSeo({ title, description = DEFAULT_DESCRIPTION, path, noindex = false }) {
  document.title = title
  upsertMeta('description', description)

  if (noindex || !path) {
    upsertMeta('robots', 'noindex')
    document.head.querySelector('link[rel="canonical"]')?.remove()
    return
  }

  document.head.querySelector('meta[name="robots"]')?.remove()
  upsertCanonical(buildCanonicalUrl(path))
}
