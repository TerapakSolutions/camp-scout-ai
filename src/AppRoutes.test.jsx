import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import AppRoutes from './AppRoutes'
import { AuthProvider } from './contexts/AuthContext'

jest.mock('./api/summaryClient', () => ({
  postSummary: jest.fn(() => new Promise(() => {})),
  SummaryApiError: class SummaryApiError extends Error {},
}))
jest.mock('./api/askClient', () => ({
  postAsk: jest.fn(),
  AskApiError: class AskApiError extends Error {},
}))
jest.mock('./api/watchClient', () => ({
  listWatches: jest.fn(() => Promise.resolve([])),
  createWatch: jest.fn(),
  updateWatch: jest.fn(),
  deleteWatch: jest.fn(),
  listAlerts: jest.fn(() => Promise.resolve([])),
  clearAlerts: jest.fn(),
  getContactSettings: jest.fn(() => Promise.resolve(null)),
  updateContactSettings: jest.fn(),
  WatchApiError: class WatchApiError extends Error {},
}))
jest.mock('./api/campgroundMediaClient', () => ({
  fetchCampgroundPhoto: jest.fn(() => Promise.resolve(null)),
  fetchRecgovCampgrounds: jest.fn(() => Promise.resolve([])),
  geocodeZip: jest.fn(() => Promise.resolve(null)),
  fetchMonthlyClimate: jest.fn(() => Promise.resolve({ elevationFt: 0, months: [] })),
}))

import { postSummary } from './api/summaryClient'
import { postAsk } from './api/askClient'
import * as watchClient from './api/watchClient'
import {
  fetchCampgroundPhoto,
  fetchRecgovCampgrounds,
  geocodeZip,
  fetchMonthlyClimate,
} from './api/campgroundMediaClient'

const ORIGIN = 'https://campscout.terapak.com'
// Recreation.gov campground with no curated image: signed in, it fetches the
// official photo AND an AI summary, and is watchable — so it exercises every gated call.
const GOLD_BLUFFS = 'redwood-gold-bluffs-beach'

function signIn() {
  window.__CAMP_SCOUT_RUNTIME__ = {
    apiToken: 'test-token',
    user: { email: 'camper@example.com', name: 'Camper' },
  }
}

function signOut() {
  // A real signed-out visit: the server still serves the runtime object, without token or user.
  window.__CAMP_SCOUT_RUNTIME__ = { apiToken: null, user: null }
}

function renderAt(path) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  )
}

const robotsMeta = () => document.head.querySelector('meta[name="robots"]')
const canonicalHref = () =>
  document.head.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null
const descriptionMeta = () =>
  document.head.querySelector('meta[name="description"]')?.getAttribute('content') ?? null

function expectNoBackendCalls() {
  expect(postSummary).not.toHaveBeenCalled()
  expect(postAsk).not.toHaveBeenCalled()
  Object.values(watchClient).forEach((fn) => {
    if (typeof fn === 'function' && 'mock' in fn) expect(fn).not.toHaveBeenCalled()
  })
  expect(fetchCampgroundPhoto).not.toHaveBeenCalled()
  expect(fetchRecgovCampgrounds).not.toHaveBeenCalled()
  expect(geocodeZip).not.toHaveBeenCalled()
  expect(fetchMonthlyClimate).not.toHaveBeenCalled()
  // Catch-all for call sites that bypass the mocked clients.
  const apiCalls = global.fetch.mock.calls.filter(([url]) => String(url).includes('/api/'))
  expect(apiCalls).toEqual([])
}

beforeEach(() => {
  jest.clearAllMocks()
  global.fetch = jest.fn(() => Promise.reject(new Error('network disabled in tests')))
  document.head.innerHTML = '<meta name="description" content="static default" />'
  document.title = 'Camp Scout AI'
})

afterEach(() => {
  delete window.__CAMP_SCOUT_RUNTIME__
  delete global.fetch
})

describe('AppRoutes — signed out', () => {
  beforeEach(signOut)

  it('shows a campground detail page, not the sign-in gate', async () => {
    renderAt(`/campgrounds/${GOLD_BLUFFS}`)

    expect(
      screen.getByRole('heading', { name: 'Gold Bluffs Beach Campground (Redwood NP)' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Sign in with Google')).not.toBeInTheDocument()
  })

  it('makes no ask/summary/watch/media calls on the detail page and offers sign-in instead', async () => {
    renderAt(`/campgrounds/${GOLD_BLUFFS}`)

    expect(await screen.findByText(/Sign in to see the AI summary/i)).toBeInTheDocument()
    expect(screen.getByText(/Sign in to watch this campground/i)).toBeInTheDocument()
    // Let any effects that would fire a request settle.
    await act(async () => {
      await Promise.resolve()
    })
    expectNoBackendCalls()
  })

  it('browses the static campground list with no backend calls and no error', async () => {
    renderAt('/campgrounds')

    expect(screen.getByRole('heading', { name: 'Browse Campgrounds' })).toBeInTheDocument()
    expect(screen.getByText('Gold Bluffs Beach Campground (Redwood NP)')).toBeInTheDocument()
    expect(screen.queryByText(/loading more/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText(/Sign in to filter by distance/i)).toBeInTheDocument()
    await act(async () => {
      await Promise.resolve()
    })
    expectNoBackendCalls()
  })

  it('shows the support page', () => {
    renderAt('/support')
    expect(screen.getByRole('heading', { name: 'Support' })).toBeInTheDocument()
  })

  // A signed-out visitor can donate (Support page), so Stripe must return them to a
  // page they can see, not the sign-in screen. Never indexed.
  it.each([
    ['/donation-success', /Thank you for your support/i],
    ['/donation-cancel', /Donation canceled/i],
  ])('shows %s signed out, marked noindex', (path, heading) => {
    renderAt(path)
    expect(screen.queryByText('Sign in with Google')).toBeNull()
    expect(screen.getAllByRole('heading', { name: heading }).length).toBeGreaterThan(0)
    expect(robotsMeta()).toHaveAttribute('content', 'noindex')
    expect(canonicalHref()).toBeNull()
  })

  it.each(['/settings', '/watches', '/retrieval'])(
    'gates %s and marks it noindex',
    (path) => {
      renderAt(path)
      expect(screen.getByText('Sign in with Google')).toBeInTheDocument()
      expect(robotsMeta()).toHaveAttribute('content', 'noindex')
      expect(canonicalHref()).toBeNull()
    },
  )

  it.each(['/some-new-route', '/campgrounds/a/b', '/support-x', '/campgroundsx', '/donation-successx'])(
    'gates an unlisted route %s by default',
    (path) => {
      renderAt(path)
      expect(screen.getByText('Sign in with Google')).toBeInTheDocument()
      expect(robotsMeta()).toHaveAttribute('content', 'noindex')
    },
  )

  it('shows not found and noindex for an unknown campground id', async () => {
    renderAt('/campgrounds/no-such-campground')

    expect(await screen.findByText('Campground not found.')).toBeInTheDocument()
    expect(robotsMeta()).toHaveAttribute('content', 'noindex')
    expect(canonicalHref()).toBeNull()
    expect(fetchRecgovCampgrounds).not.toHaveBeenCalled()
  })

  it('offers sign-in on an unknown id: it may be an imported Rec.gov campground', async () => {
    renderAt('/campgrounds/no-such-campground')

    expect(await screen.findByText('Campground not found.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Sign in to see campgrounds imported from Recreation\.gov/ })).toBeInTheDocument()
  })
})

describe('AppRoutes — per-page head tags', () => {
  beforeEach(signOut)

  it('detail page: title and description use name and region; absolute canonical', () => {
    renderAt(`/campgrounds/${GOLD_BLUFFS}`)

    expect(document.title).toContain('Gold Bluffs Beach Campground (Redwood NP)')
    expect(document.title).toContain('Humboldt County')
    expect(descriptionMeta()).toContain('Gold Bluffs Beach Campground (Redwood NP)')
    expect(descriptionMeta()).toContain('Humboldt County')
    expect(canonicalHref()).toBe(`${ORIGIN}/campgrounds/${GOLD_BLUFFS}`)
    expect(robotsMeta()).toBeNull()
    // Upserts the existing description rather than adding a second one.
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1)
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1)
  })

  it('campgrounds list: canonical ignores filter query strings', () => {
    renderAt('/campgrounds?region=Humboldt%20County')
    expect(canonicalHref()).toBe(`${ORIGIN}/campgrounds`)
    expect(document.title).toMatch(/campgrounds/i)
  })

  it('support page: own title and canonical', () => {
    renderAt('/support')
    expect(canonicalHref()).toBe(`${ORIGIN}/support`)
    expect(document.title).toMatch(/support/i)
  })

  it('gives each public page a distinct title, description and canonical', () => {
    const seen = []
    for (const path of ['/campgrounds', `/campgrounds/${GOLD_BLUFFS}`, '/campgrounds/yosemite-upper-pines', '/support']) {
      const { unmount } = renderAt(path)
      seen.push({ title: document.title, description: descriptionMeta(), canonical: canonicalHref() })
      unmount()
    }
    for (const key of ['title', 'description', 'canonical']) {
      expect(new Set(seen.map((s) => s[key])).size).toBe(seen.length)
    }
  })

  it('does not leak noindex from a gated route into a public page', () => {
    const gated = renderAt('/settings')
    expect(robotsMeta()).toHaveAttribute('content', 'noindex')
    gated.unmount()

    renderAt(`/campgrounds/${GOLD_BLUFFS}`)
    expect(robotsMeta()).toBeNull()
    expect(canonicalHref()).toBe(`${ORIGIN}/campgrounds/${GOLD_BLUFFS}`)
  })

  it('does not leak noindex from an unknown campground when navigating back to the list', async () => {
    const user = userEvent.setup()
    renderAt('/campgrounds/no-such-campground')
    expect(await screen.findByText('Campground not found.')).toBeInTheDocument()
    expect(robotsMeta()).toHaveAttribute('content', 'noindex')

    await user.click(screen.getByRole('link', { name: /Back to campgrounds/i }))

    expect(await screen.findByRole('heading', { name: 'Browse Campgrounds' })).toBeInTheDocument()
    expect(robotsMeta()).toBeNull()
    expect(canonicalHref()).toBe(`${ORIGIN}/campgrounds`)
  })
})

describe('AppRoutes — signed in (control: the gated calls DO fire)', () => {
  beforeEach(signIn)

  it('detail page fetches the AI summary and the official photo, and offers a watch', async () => {
    renderAt(`/campgrounds/${GOLD_BLUFFS}`)

    await waitFor(() => expect(postSummary).toHaveBeenCalledWith({ campgroundId: GOLD_BLUFFS }))
    await waitFor(() => expect(fetchCampgroundPhoto).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: /Watch this campground/i })).toBeInTheDocument()
    expect(screen.queryByText(/Sign in to see the AI summary/i)).not.toBeInTheDocument()
  })

  it('campgrounds list loads the Recreation.gov set', async () => {
    renderAt('/campgrounds')
    await waitFor(() => expect(fetchRecgovCampgrounds).toHaveBeenCalled())
    // Card thumbnails resolve official photos for Rec.gov campgrounds with no curated image.
    await waitFor(() => expect(fetchCampgroundPhoto).toHaveBeenCalled())
    expect(screen.getByLabelText('Near ZIP')).toBeInTheDocument()
  })

  it('settings route renders the app, not the gate, and stays noindex', () => {
    renderAt('/settings')
    expect(screen.queryByText('Sign in with Google')).not.toBeInTheDocument()
    expect(robotsMeta()).toHaveAttribute('content', 'noindex')
  })
})
