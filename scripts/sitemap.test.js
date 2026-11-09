import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { campgrounds } from '../src/data/campgrounds.js'

describe('generate-sitemap.mjs', () => {
  /** @type {string | undefined} */
  let tempDir

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  it('generates valid CampScout sitemap XML and robots.txt', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'campscout-sitemap-'))

    execFileSync('node', ['scripts/generate-sitemap.mjs'], {
      cwd: join(process.cwd()),
      env: {
        ...process.env,
        BUILD_OUT_DIR: tempDir,
        CAMP_SCOUT_BASE: '/',
        APP_URL: 'https://campscout.terapak.com',
      },
    })

    const sitemap = readFileSync(join(tempDir, 'sitemap.xml'), 'utf8')
    const robots = readFileSync(join(tempDir, 'robots.txt'), 'utf8')

    expect(sitemap).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/)
    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    expect(sitemap).toContain('<loc>https://campscout.terapak.com/</loc>')
    expect(sitemap).toContain('<loc>https://campscout.terapak.com/campgrounds</loc>')
    expect(sitemap).not.toContain('/retrieval')
    expect(sitemap).toContain('<loc>https://campscout.terapak.com/support</loc>')

    for (const campground of campgrounds) {
      expect(sitemap).toContain(
        `<loc>https://campscout.terapak.com/campgrounds/${campground.id}</loc>`
      )
    }

    expect(sitemap).not.toContain('/settings')
    expect(sitemap).not.toContain('/donation-success')
    expect(sitemap).not.toContain('/donation-cancel')

    expect(robots).toContain('User-agent: *')
    expect(robots).toContain('Sitemap: https://campscout.terapak.com/sitemap.xml')
    expect(robots).toContain('Disallow: /settings')
    expect(robots).toContain('Disallow: /api/')
  })

  it('generates GitHub Pages sitemap URLs when base path is set', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'campscout-sitemap-gh-'))

    execFileSync('node', ['scripts/generate-sitemap.mjs'], {
      cwd: join(process.cwd()),
      env: {
        ...process.env,
        BUILD_OUT_DIR: tempDir,
        CAMP_SCOUT_BASE: '/camp-scout-ai/',
      },
    })

    const sitemap = readFileSync(join(tempDir, 'sitemap.xml'), 'utf8')
    const robots = readFileSync(join(tempDir, 'robots.txt'), 'utf8')

    expect(sitemap).toContain(
      '<loc>https://sterapak.github.io/camp-scout-ai/campgrounds</loc>'
    )
    expect(robots).toContain('Sitemap: https://sterapak.github.io/camp-scout-ai/sitemap.xml')
  })
})

describe('generate-terapak-sitemap.mjs', () => {
  /** @type {string | undefined} */
  let tempDir

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  it('generates valid Terapak sitemap XML and robots.txt', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'terapak-sitemap-'))

    execFileSync('node', ['scripts/generate-terapak-sitemap.mjs'], {
      cwd: join(process.cwd()),
      env: {
        ...process.env,
        TERAPAK_SITEMAP_OUT_DIR: tempDir,
        TERAPAK_SITE_URL: 'https://terapak.com',
      },
    })

    const sitemap = readFileSync(join(tempDir, 'sitemap.xml'), 'utf8')
    const robots = readFileSync(join(tempDir, 'robots.txt'), 'utf8')

    expect(sitemap).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/)
    expect(sitemap).toContain('<loc>https://terapak.com/</loc>')
    expect(sitemap).toContain('<loc>https://terapak.com/projects</loc>')
    expect(sitemap).toContain('<loc>https://terapak.com/about</loc>')
    expect(robots).toContain('Sitemap: https://terapak.com/sitemap.xml')
  })
})
