import React, { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { FiArrowLeft, FiExternalLink, FiMapPin } from 'react-icons/fi'
import { postSummary, SummaryApiError } from '../api/summaryClient.js'
import { isApiAvailable } from '../api/apiAuth.js'
import { isWatchable, parseRecGovCampgroundId } from '../utils/recgov.js'
import { flybookConfigForCampground } from '../data/flybookCampgrounds.js'
import { fetchCampgroundPhoto, type CampgroundPhoto } from '../api/campgroundMediaClient.js'
import WatchCreateForm from '../components/WatchCreateForm.js'
import AvailabilityNotice from '../components/AvailabilityNotice'
import CampgroundAiSummary from '../components/CampgroundAiSummary'
import CampgroundImage from '../components/CampgroundImage'
import { getCampgroundById, getPrimaryImage, getBrandPlaceholder } from '../data/campgroundData'
import { loadImportedCampgrounds, type DisplayCampground } from '../data/mergedCampgrounds'
import { getKnowledgeCampgroundIds } from '../data/knowledge/documents.js'
import { useAuth } from '../contexts/AuthContext'
import SignInPrompt from '../components/SignInPrompt'
import { applyPageSeo, SITE_NAME } from '../utils/seo'

import type { Citation, UniqueSourceReference, AnswerConfidenceLevel, SummarySectionContent } from '../shared/types/api.js'
import type { KnowledgeSnapshot } from '../server/rag/knowledgeSnapshot.js'

type SummaryPageState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; sections: SummarySectionContent; citations: Citation[]; sources: UniqueSourceReference[]; confidence: AnswerConfidenceLevel; generatedAt?: string; knowledgeSnapshot?: KnowledgeSnapshot }
  | { status: 'unavailable'; message: string }
  | { status: 'insufficient_context'; message: string }
  | { status: 'error'; errorMessage: string }

export default function CampgroundDetailPage() {
  const { id } = useParams()
  // Signed out, this page is public: it must not call the session/token-gated
  // APIs (summary, photo, Recreation.gov list, watches) — it shows sign-in prompts.
  const { isAuthenticated } = useAuth()
  const staticCampground = getCampgroundById(id)
  const [importedCampground, setImportedCampground] = useState<DisplayCampground | null>(null)
  const [resolving, setResolving] = useState(!staticCampground)
  const campground = staticCampground ?? importedCampground
  // Non-recgov (Flybook) campgrounds are watchable via their mapped account id.
  const flybookWatch = campground ? flybookConfigForCampground(campground.id) : null
  const hasKnowledge = getKnowledgeCampgroundIds().includes(id ?? '')

  // Fall back to the Recreation.gov-imported set for campgrounds not curated.
  useEffect(() => {
    if (staticCampground || !isAuthenticated) {
      setImportedCampground(null)
      setResolving(false)
      return undefined
    }
    let cancelled = false
    setResolving(true)
    loadImportedCampgrounds().then((list) => {
      if (cancelled) return
      setImportedCampground(list.find((c) => c.id === id) ?? null)
      setResolving(false)
    })
    return () => {
      cancelled = true
    }
  }, [id, staticCampground, isAuthenticated])
  // Start in 'loading': we attempt a summary for curated campgrounds AND any
  // Recreation.gov campground (the server generates one from RIDB facility data
  // when there's no curated knowledge). The effect below downgrades to
  // 'unavailable' only when neither source can produce one.
  const [summaryState, setSummaryState] = useState<SummaryPageState>(
    { status: 'loading' } as SummaryPageState,
  )
  const [showWatch, setShowWatch] = useState(false)
  const [watchCreated, setWatchCreated] = useState(false)
  const [officialPhoto, setOfficialPhoto] = useState<CampgroundPhoto | null>(null)
  // Set when a CURATED image URL fails to load. Curated urls rot — as of
  // 2026-07-19 five of nine 404'd/403'd (NPS, two Forest Service, EID) — and the
  // official-photo fallback below previously only ran when a curated image was
  // ABSENT. A present-but-broken url therefore rendered "image not available"
  // forever. Presence was checked; validity was not.
  const [curatedImageFailed, setCuratedImageFailed] = useState(false)

  // Reset per campground. Without this, one broken curated image would suppress
  // the curated image on every campground visited afterwards. Keyed on id (not the
  // object) so it does not re-fire on unrelated re-renders, and kept separate from
  // the fetch effect below, which depends on curatedImageFailed and would loop.
  useEffect(() => {
    setCuratedImageFailed(false)
  }, [campground?.id])

  // When there's no curated image, try the official Recreation.gov photo (RIDB).
  // Only recreation.gov campgrounds have a facility id to resolve.
  useEffect(() => {
    setOfficialPhoto(null)
    if (!campground || !isAuthenticated) return undefined
    // Fetch when there is no curated image, OR when the curated one just failed.
    if (getPrimaryImage(campground) && !curatedImageFailed) return undefined
    const facilityId = parseRecGovCampgroundId(campground.reservationUrl)
    if (!facilityId || !isApiAvailable()) return undefined

    let cancelled = false
    fetchCampgroundPhoto(facilityId).then((photo) => {
      if (!cancelled) setOfficialPhoto(photo)
    })
    return () => {
      cancelled = true
    }
  }, [campground, curatedImageFailed, isAuthenticated])

  useEffect(() => {
    // Wait until the imported-campground lookup settles so we can read its
    // reservation URL (needed to tell whether it's a Recreation.gov facility).
    if (resolving || !campground || !isAuthenticated) {
      return undefined
    }

    // Summarizable when curated, OR when it's a Recreation.gov campground (the
    // server will try RIDB). Otherwise there is genuinely no source → honest state.
    const recGovFacilityId = parseRecGovCampgroundId(campground.reservationUrl)
    const canSummarize = hasKnowledge || Boolean(recGovFacilityId)
    if (!canSummarize) {
      setSummaryState({
        status: 'unavailable',
        message: 'An AI summary is not available for this campground.',
      } as SummaryPageState)
      return undefined
    }

    let cancelled = false

    async function loadSummary() {
      setSummaryState({ status: 'loading' })

      try {
        const result = await postSummary({ campgroundId: campground.id })

        if (cancelled) {
          return
        }

        if (result.status === 'insufficient_context') {
          setSummaryState({
            status: 'insufficient_context',
            message: result.message,
          })
          return
        }

        setSummaryState({
          status: 'success',
          sections: result.sections,
          citations: result.citations,
          sources: result.sources,
          confidence: result.confidence,
          generatedAt: result.generatedAt,
          knowledgeSnapshot: result.knowledgeSnapshot,
        })
      } catch (error) {
        if (cancelled) {
          return
        }

        const errorMessage =
          error instanceof SummaryApiError
            ? error.message
            : 'Summary generation failed. Please try again.'
        setSummaryState({ status: 'error', errorMessage })
      }
    }

    loadSummary()

    return () => {
      cancelled = true
    }
  }, [campground, hasKnowledge, resolving, isAuthenticated])

  // Per-page head tags. An unknown id is noindex (also while still resolving).
  useEffect(() => {
    if (campground) {
      applyPageSeo({
        title: `${campground.name}, ${campground.region} — ${SITE_NAME}`,
        description: `${campground.name} in ${campground.region}: amenities, rules, dog policy and official reservation links.`,
        path: `/campgrounds/${campground.id}`,
      })
    } else {
      applyPageSeo({ title: `Campground not found — ${SITE_NAME}`, noindex: true })
    }
  }, [campground])

  if (!campground) {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <Link to="/campgrounds" className="inline-flex items-center text-sm text-green-700 hover:text-green-900">
          <FiArrowLeft className="mr-1" />
          Back to campgrounds
        </Link>
        <p className="text-gray-600">{resolving ? 'Loading…' : 'Campground not found.'}</p>
        {/* Signed out, imported Rec.gov campgrounds are not loaded, so this id may still exist. */}
        {!resolving && !isAuthenticated && (
          <SignInPrompt action="see campgrounds imported from Recreation.gov" />
        )}
      </div>
    )
  }

  const curatedImage = getPrimaryImage(campground)
  const primaryImage = curatedImageFailed ? officialPhoto : (curatedImage ?? officialPhoto)
  const brandPlaceholder = getBrandPlaceholder(campground)

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <Link to="/campgrounds" className="inline-flex items-center text-sm text-green-700 hover:text-green-900">
        <FiArrowLeft className="mr-1" />
        Back to campgrounds
      </Link>

      <header className="space-y-2">
        <h2 className="text-3xl font-semibold text-gray-900">{campground.name}</h2>
        <p className="inline-flex items-center text-gray-600">
          <FiMapPin className="mr-1" />
          {campground.region}
        </p>
      </header>

      <AvailabilityNotice />

      {(!hasKnowledge || !isAuthenticated) && (
        <CampgroundImage
          key={primaryImage?.url ?? 'none'}
          image={primaryImage}
          campgroundName={campground.name}
          brand={brandPlaceholder}
          onLoadError={() => setCuratedImageFailed(true)}
        />
      )}

      {!isAuthenticated ? (
        <section className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm space-y-2">
          <h3 className="text-lg font-medium text-gray-900">AI summary</h3>
          <SignInPrompt action="see the AI summary" />
        </section>
      ) : (
      <CampgroundAiSummary
        status={summaryState.status}
        sections={'sections' in summaryState ? summaryState.sections : undefined}
        citations={'citations' in summaryState ? summaryState.citations : undefined}
        sources={'sources' in summaryState ? summaryState.sources : undefined}
        confidence={'confidence' in summaryState ? summaryState.confidence : undefined}
        generatedAt={'generatedAt' in summaryState ? summaryState.generatedAt : undefined}
        knowledgeSnapshot={'knowledgeSnapshot' in summaryState ? summaryState.knowledgeSnapshot : undefined}
        message={'message' in summaryState ? summaryState.message : undefined}
        errorMessage={'errorMessage' in summaryState ? summaryState.errorMessage : undefined}
        imageSlot={
          hasKnowledge ? (
            <CampgroundImage
          key={primaryImage?.url ?? 'none'}
          image={primaryImage}
          campgroundName={campground.name}
          brand={brandPlaceholder}
          onLoadError={() => setCuratedImageFailed(true)}
        />
          ) : undefined
        }
      />
      )}

      <section className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm space-y-4">
        <h3 className="text-lg font-medium text-gray-900">About</h3>
        <p className="text-gray-700">
          {campground.notes || 'Recreation.gov campground. See the official page for full details.'}
        </p>
        {campground.lastVerifiedAt && (
          <p className="text-xs text-gray-500">Last verified: {campground.lastVerifiedAt}</p>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm space-y-3">
        <h3 className="text-lg font-medium text-gray-900">Official Sources</h3>
        <div className="flex flex-col sm:flex-row gap-3">
          <a
            href={campground.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-800"
          >
            View official info
            <FiExternalLink size={14} />
          </a>
          <a
            href={campground.reservationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-green-700 px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-50"
          >
            Reservation portal
            <FiExternalLink size={14} />
          </a>
        </div>
      </section>

      {!isAuthenticated && (isWatchable(campground.reservationUrl) || flybookWatch) && (
        <section className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm space-y-3">
          <h3 className="text-lg font-medium text-gray-900">Watch for cancellations</h3>
          <SignInPrompt action="watch this campground for cancellations" />
        </section>
      )}

      {isAuthenticated && isApiAvailable() && (isWatchable(campground.reservationUrl) || flybookWatch) && (
        <section className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm space-y-3">
          <h3 className="text-lg font-medium text-gray-900">Watch for cancellations</h3>
          {watchCreated ? (
            <p className="text-sm text-green-700">
              Watch created — you&apos;ll get a push alert if a spot frees up.{' '}
              <Link to="/watches" className="underline">Manage watches</Link>
            </p>
          ) : showWatch ? (
            <WatchCreateForm
              prefillName={campground.name}
              {...(flybookWatch
                ? { platform: 'flybook', facilityId: flybookWatch.facilityId }
                : { prefillUrl: campground.reservationUrl })}
              onCreated={() => {
                setWatchCreated(true)
                setShowWatch(false)
              }}
            />
          ) : (
            <>
              <p className="text-sm text-gray-600">
                Fully booked? Get an instant alert the moment someone cancels.
              </p>
              <button
                onClick={() => setShowWatch(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-800"
              >
                🔔 Watch this campground
              </button>
            </>
          )}
        </section>
      )}

      {campground.amenities.length > 0 && (
        <section className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm space-y-3">
          <h3 className="text-lg font-medium text-gray-900">Amenities</h3>
          <ul className="list-disc list-inside text-gray-700 space-y-1">
            {campground.amenities.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      {campground.rules.length > 0 && (
        <section className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm space-y-3">
          <h3 className="text-lg font-medium text-gray-900">Rules</h3>
          <ul className="list-disc list-inside text-gray-700 space-y-1">
            {campground.rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </section>
      )}

      {campground.dogPolicy && (
        <section className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm space-y-3">
          <h3 className="text-lg font-medium text-gray-900">Dog Policy</h3>
          <p className="text-gray-700">{campground.dogPolicy}</p>
        </section>
      )}

      {campground.tags.length > 0 && (
        <section className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm space-y-3">
          <h3 className="text-lg font-medium text-gray-900">Tags</h3>
          <div className="flex flex-wrap gap-2">
            {campground.tags.map((t) => (
              <span
                key={t}
                className="rounded-full bg-green-50 px-3 py-1 text-sm font-medium text-green-800"
              >
                {t}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
