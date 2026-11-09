import React, { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { FiBell } from 'react-icons/fi'
import AvailabilityNotice from '../components/AvailabilityNotice'
import DonationCard from '../components/DonationCard'
import CampgroundFilters from '../components/CampgroundFilters'
import CampgroundList from '../components/CampgroundList'
import {
  filterCampgrounds,
  getAllAmenities,
  getAllTags,
} from '../data/campgroundData'
import {
  curatedCampgrounds,
  loadImportedCampgrounds,
  mergeCampgrounds,
  type DisplayCampground,
} from '../data/mergedCampgrounds'
import { geocodeZip, type ZipLocation } from '../api/campgroundMediaClient'
import { haversineMiles } from '../utils/geo'
import { useAuth } from '../contexts/AuthContext'
import SignInPrompt from '../components/SignInPrompt'
import { applyPageSeo, SITE_NAME } from '../utils/seo'

// Drive-time-ish presets (straight-line miles).
const RADIUS_OPTIONS = [
  { miles: 0, label: 'Any distance' },
  { miles: 50, label: '~1 hour (50 mi)' },
  { miles: 100, label: '~2 hours (100 mi)' },
  { miles: 150, label: '~3 hours (150 mi)' },
]

/** @param {URLSearchParams} searchParams @param {string} key */
function readMultiParam(searchParams, key) {
  return searchParams.getAll(key).filter(Boolean)
}

export default function CampgroundsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  // Signed out: curated list only. The Recreation.gov list and ZIP geocoding are
  // session-gated server-side, so they are not called (no 401s, no error shown).
  const { isAuthenticated } = useAuth()

  const [query, setQuery] = useState('')
  const [selectedRegions, setSelectedRegions] = useState(() => readMultiParam(searchParams, 'region'))
  const [selectedAmenities, setSelectedAmenities] = useState(() =>
    readMultiParam(searchParams, 'amenity')
  )
  const [selectedTags, setSelectedTags] = useState(() => readMultiParam(searchParams, 'tag'))
  const [imported, setImported] = useState<DisplayCampground[]>([])
  const [loadingImported, setLoadingImported] = useState(isAuthenticated)
  const [zip, setZip] = useState('')
  const [radiusMiles, setRadiusMiles] = useState(0)
  const [zipLoc, setZipLoc] = useState<ZipLocation | null>(null)
  const [zipError, setZipError] = useState<string | null>(null)

  async function applyZip() {
    setZipError(null)
    const trimmed = zip.trim()
    if (!/^\d{5}$/.test(trimmed)) {
      setZipLoc(null)
      setZipError('Enter a 5-digit ZIP code.')
      return
    }
    const loc = await geocodeZip(trimmed)
    if (!loc) {
      setZipLoc(null)
      setZipError("Couldn't find that ZIP.")
      return
    }
    setZipLoc(loc)
  }

  useEffect(() => {
    applyPageSeo({
      title: `Browse Northern California Campgrounds — ${SITE_NAME}`,
      description:
        'Browse Northern California campgrounds by region, amenity and tag, with official park sources and reservation links.',
      path: '/campgrounds',
    })
  }, [])

  useEffect(() => {
    if (!isAuthenticated) return undefined
    let cancelled = false
    loadImportedCampgrounds().then((list) => {
      if (cancelled) return
      setImported(list)
      setLoadingImported(false)
    })
    return () => {
      cancelled = true
    }
  }, [isAuthenticated])

  const allCampgrounds = useMemo(
    () => (imported.length ? mergeCampgrounds(imported) : curatedCampgrounds()),
    [imported],
  )

  const regions = useMemo(
    () => [...new Set(allCampgrounds.map((c) => c.region))].sort(),
    [allCampgrounds],
  )
  const amenityOptions = useMemo(() => getAllAmenities(), [])
  const tags = useMemo(() => getAllTags(), [])

  useEffect(() => {
    const params = new URLSearchParams()
    selectedRegions.forEach((region) => params.append('region', region))
    selectedAmenities.forEach((amenity) => params.append('amenity', amenity))
    selectedTags.forEach((tag) => params.append('tag', tag))

    const next = params.toString()
    const current = searchParams.toString()
    if (next !== current) {
      setSearchParams(params, { replace: true })
    }
  }, [selectedRegions, selectedAmenities, selectedTags, searchParams, setSearchParams])

  const results = useMemo(() => {
    const filtered = filterCampgrounds(allCampgrounds, {
      query,
      regions: selectedRegions,
      amenities: selectedAmenities,
      tags: selectedTags,
    }) as DisplayCampground[]
    // Distance filter: only when a ZIP is resolved AND a radius is chosen.
    if (!zipLoc || radiusMiles <= 0) return filtered
    return filtered
      .map((c) => {
        const dist =
          c.latitude != null && c.longitude != null
            ? haversineMiles(zipLoc.lat, zipLoc.lng, c.latitude, c.longitude)
            : Infinity
        return { c, dist }
      })
      .filter(({ dist }) => dist <= radiusMiles)
      .sort((a, b) => a.dist - b.dist)
      .map(({ c }) => c)
  }, [allCampgrounds, query, selectedRegions, selectedAmenities, selectedTags, zipLoc, radiusMiles])

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-gray-900">Browse Campgrounds</h2>
        <p className="mt-1 text-sm text-gray-600">
          Curated Northern California picks plus every California Recreation.gov campground.
        </p>
      </div>

      <div className="rounded-xl bg-gradient-to-r from-green-700 to-green-600 p-5 text-white shadow-sm sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <FiBell className="mt-0.5 shrink-0 text-green-100" size={24} />
            <div>
              <h3 className="text-lg font-semibold">Never miss a cancellation</h3>
              <p className="mt-1 max-w-2xl text-sm text-green-50">
                Fully booked? Set a watch on any campground and dates — we&apos;ll ping your phone
                the moment a spot frees up, with a tap-to-book link. Weekends-only if you like.
              </p>
            </div>
          </div>
          <Link
            to="/watches"
            className="shrink-0 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-green-800 shadow-sm hover:bg-green-50"
          >
            Set up a watch →
          </Link>
        </div>
      </div>

      <AvailabilityNotice />

      <CampgroundFilters
        query={query}
        selectedRegions={selectedRegions}
        selectedAmenities={selectedAmenities}
        selectedTags={selectedTags}
        regions={regions}
        amenityOptions={amenityOptions}
        tags={tags}
        onQueryChange={setQuery}
        onRegionsChange={setSelectedRegions}
        onAmenitiesChange={setSelectedAmenities}
        onTagsChange={setSelectedTags}
      />

      {!isAuthenticated ? (
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <SignInPrompt action="filter by distance from your ZIP code" />
        </div>
      ) : (
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="zip">
            Near ZIP
          </label>
          <input
            id="zip"
            inputMode="numeric"
            className="w-32 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
            value={zip}
            onChange={(e) => setZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void applyZip()
            }}
            placeholder="e.g. 95709"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="radius">
            Within
          </label>
          <select
            id="radius"
            className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
            value={radiusMiles}
            onChange={(e) => setRadiusMiles(Number(e.target.value))}
          >
            {RADIUS_OPTIONS.map((o) => (
              <option key={o.miles} value={o.miles}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => void applyZip()}
          className="rounded-md bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-800"
        >
          Apply
        </button>
        {(zipLoc || zipError) && (
          <button
            type="button"
            onClick={() => {
              setZip('')
              setZipLoc(null)
              setZipError(null)
              setRadiusMiles(0)
            }}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
          >
            Clear
          </button>
        )}
        <p className="w-full text-xs text-gray-500">
          {zipError ? (
            <span className="text-red-600">{zipError}</span>
          ) : zipLoc ? (
            radiusMiles > 0 ? (
              `Showing campgrounds within ${radiusMiles} mi of ${zipLoc.place} (straight-line). Distance filter applies to Recreation.gov campgrounds.`
            ) : (
              `${zipLoc.place} set — pick a distance to filter.`
            )
          ) : (
            'Filter by straight-line distance from a ZIP (a rough stand-in for drive time).'
          )}
        </p>
      </div>
      )}

      <p className="text-sm text-gray-500">
        Showing {results.length} campground{results.length !== 1 ? 's' : ''}
        {loadingImported ? ' · loading more…' : ''}
      </p>

      <CampgroundList campgrounds={results} />

      <DonationCard />
    </div>
  )
}
