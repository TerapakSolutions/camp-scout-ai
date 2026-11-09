#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { campgrounds } from '../src/data/campgrounds.js'
import {
  buildAbsoluteUrl,
  buildRobotsTxt,
  buildSitemapXml,
  normalizeBasePath,
  resolveSiteOrigin,
  toSitemapDate,
} from './sitemapUtils.mjs'

const outDir = process.env.BUILD_OUT_DIR ?? process.env.SITEMAP_OUT_DIR ?? 'docs'
const basePath = normalizeBasePath(process.env.CAMP_SCOUT_BASE ?? '/')
const siteOrigin = resolveSiteOrigin({
  siteUrl: process.env.SITEMAP_SITE_URL,
  appUrl: process.env.APP_URL,
  basePath,
})

/** @type {import('./sitemapUtils.mjs').SitemapEntry[]} */
const staticEntries = [
  { pathname: '/', changefreq: 'weekly', priority: 1.0 },
  { pathname: '/campgrounds', changefreq: 'daily', priority: 0.9 },
  { pathname: '/support', changefreq: 'monthly', priority: 0.7 },
]

/** @type {import('./sitemapUtils.mjs').SitemapEntry[]} */
const campgroundEntries = campgrounds.map((campground) => ({
  pathname: `/campgrounds/${campground.id}`,
  lastmod: toSitemapDate(campground.lastVerifiedAt),
  changefreq: 'monthly',
  priority: 0.8,
}))

const entries = [...staticEntries, ...campgroundEntries]
const sitemapXml = buildSitemapXml(entries, siteOrigin, basePath)
const sitemapUrl = buildAbsoluteUrl(siteOrigin, basePath, '/sitemap.xml')
const robotsTxt = buildRobotsTxt({
  sitemapUrl,
  disallow: ['/settings', '/donation-success', '/donation-cancel', '/api/'],
})

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'sitemap.xml'), sitemapXml, 'utf8')
writeFileSync(join(outDir, 'robots.txt'), robotsTxt, 'utf8')

console.log(`Generated sitemap with ${entries.length} URLs at ${join(outDir, 'sitemap.xml')}`)
console.log(`Generated robots.txt at ${join(outDir, 'robots.txt')}`)
