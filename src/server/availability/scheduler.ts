/**
 * Watch scheduler. Runs INSIDE the existing always-on server process (the Fly
 * machine is single/always-on because SQLite is single-writer, so an in-process
 * loop is the right fit — no second machine can open the volume). Every tick it:
 *   1. finds active watches due for a poll,
 *   2. fetches each needed (facility, month) ONCE — shared across watches —
 *      through a polite serial loop (spacing + jitter + backoff),
 *   3. diffs fresh vs. the stored snapshot per watch,
 *   4. dispatches alerts, and updates each watch's poll status.
 *
 * `runOneTick` is exported (and pure w.r.t. injected deps) so tests drive it
 * directly with a fake fetch + in-memory DB. Guard with WATCHER_ENABLED in the
 * caller (server/production.mjs).
 */
import { createHash, randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'

import type { Db } from '../db/index.js'
import { availabilitySnapshots, watches, type WatchRow } from '../db/schema.js'
import { fetchMonthAvailability as fetchRecGovMonth } from './recGovAdapter.js'
import { fetchMonthAvailability as fetchRcMonth } from './reserveCaliforniaAdapter.js'
import { fetchMonthAvailability as fetchFlybookMonth } from './flybookAdapter.js'
import { diffAvailability } from './diffEngine.js'
import type { FetchAvailabilityResult, NormalizedAvailability, SiteFilters } from './types.js'

/** Availability fetcher per platform (both share the same result shape). */
function fetchMonthFor(
  platform: string,
  facilityId: string,
  monthKey: string,
  fetchImpl?: typeof fetch,
): Promise<FetchAvailabilityResult> {
  const opts = { fetchImpl }
  if (platform === 'reservecalifornia') return fetchRcMonth(facilityId, monthKey, opts)
  if (platform === 'flybook') return fetchFlybookMonth(facilityId, monthKey, opts)
  return fetchRecGovMonth(facilityId, monthKey, opts)
}
import { dispatchMatches, type DispatchDeps } from '../notifications/notifyDispatcher.js'

export interface SchedulerOptions {
  tickMs?: number
  defaultPollIntervalSeconds?: number
  fetchSpacingMs?: number
  fetchImpl?: typeof fetch
  now?: () => Date
  dispatchDeps?: DispatchDeps
  /** Backstop: max SMS-sending watches per tick (guards against any fan-out bug). */
  maxSmsPerTick?: number
  logger?: (msg: string, extra?: Record<string, unknown>) => void
}

export interface TickSummary {
  watchesPolled: number
  fetches: number
  fetchErrors: number
  alertsSent: number
}

const DEFAULT_TICK_MS = 30_000
const DEFAULT_POLL_INTERVAL_SECONDS = 300
const DEFAULT_FETCH_SPACING_MS = 2_500
const DEFAULT_MAX_SMS_PER_TICK = 10

function hashPayload(payload: string): string {
  return createHash('sha256').update(payload).digest('hex')
}

function monthKeysBetween(startDate: string, endDate: string): string[] {
  const out: string[] = []
  let y = Number(startDate.slice(0, 4))
  let m = Number(startDate.slice(5, 7))
  const endY = Number(endDate.slice(0, 4))
  const endM = Number(endDate.slice(5, 7))
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out
}

function parseFilters(raw: string | null): SiteFilters | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as SiteFilters
  } catch {
    return null
  }
}

function isDue(watch: WatchRow, now: Date, defaultInterval: number): boolean {
  if (watch.status !== 'active') return false
  if (!watch.lastPolledAt) return true
  const interval = (watch.pollIntervalSeconds ?? defaultInterval) * 1000
  return now.getTime() - new Date(watch.lastPolledAt).getTime() >= interval
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const snapshotKey = (platform: string, facilityId: string, monthKey: string) =>
  `${platform}:${facilityId}:${monthKey}`

const SUPPORTED_PLATFORMS = new Set(['recgov', 'reservecalifornia', 'flybook'])

/** Human-readable poll status from the failing HTTP status (0 = network). */
function pollErrorMessage(status: number | undefined): string {
  if (status === 404) return 'unavailable: campground not found (404)'
  if (status === 403) return 'error: blocked by provider (403)'
  if (status && status >= 400) return `error: provider ${status}`
  return 'error: network unreachable'
}

/** One scheduler pass. Deterministic w.r.t. injected deps for tests. */
export async function runOneTick(
  db: Db,
  options: SchedulerOptions = {},
): Promise<TickSummary> {
  const now = options.now ?? (() => new Date())
  const defaultInterval =
    options.defaultPollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS
  const spacing = options.fetchSpacingMs ?? DEFAULT_FETCH_SPACING_MS
  const maxSmsPerTick =
    options.maxSmsPerTick ??
    (Number(process.env.WATCH_MAX_SMS_PER_TICK) || DEFAULT_MAX_SMS_PER_TICK)
  const log = options.logger ?? (() => {})
  const summary: TickSummary = { watchesPolled: 0, fetches: 0, fetchErrors: 0, alertsSent: 0 }

  const nowDate = now()
  const today = nowDate.toISOString().slice(0, 10)

  const allWatches = db.select().from(watches).all()

  // Auto-expire watches whose window has passed.
  for (const w of allWatches) {
    if (w.status === 'active' && w.endDate < today) {
      db.update(watches).set({ status: 'expired' }).where(eq(watches.id, w.id)).run()
    }
  }

  const due = allWatches.filter(
    (w) => w.endDate >= today && isDue(w, nowDate, defaultInterval),
  )
  if (due.length === 0) return summary

  // Recreation.gov + ReserveCalifornia (per-platform adapters).
  const dueWatchable = due.filter((w) => SUPPORTED_PLATFORMS.has(w.platform))

  // Collect the unique (platform, facility, month) fetches across all due watches.
  const needed = new Map<string, { platform: string; facilityId: string; monthKey: string }>()
  for (const w of dueWatchable) {
    for (const monthKey of monthKeysBetween(w.startDate, w.endDate)) {
      // Skip months already fully in the past.
      if (monthKey < today.slice(0, 7)) continue
      needed.set(snapshotKey(w.platform, w.facilityId, monthKey), {
        platform: w.platform,
        facilityId: w.facilityId,
        monthKey,
      })
    }
  }

  // Polite serial fetch. results: key -> { prev, fresh } (fresh null on error).
  const results = new Map<
    string,
    {
      prev: NormalizedAvailability | null
      fresh: NormalizedAvailability | null
      status?: number
    }
  >()
  let first = true
  for (const { platform, facilityId, monthKey } of needed.values()) {
    if (!first) await sleep(spacing + Math.floor(Math.random() * spacing * 0.4))
    first = false

    const key = snapshotKey(platform, facilityId, monthKey)
    const prevRow = db
      .select()
      .from(availabilitySnapshots)
      .where(eq(availabilitySnapshots.snapshotKey, key))
      .get()
    const prev: NormalizedAvailability | null = prevRow
      ? (JSON.parse(prevRow.payload) as NormalizedAvailability)
      : null

    summary.fetches += 1
    const res = await fetchMonthFor(platform, facilityId, monthKey, options.fetchImpl)
    if (!res.ok || !res.availability) {
      summary.fetchErrors += 1
      log('watch_fetch_error', { platform, facilityId, monthKey, status: res.status, error: res.error })
      results.set(key, { prev, fresh: null, status: res.status })
      // Simple backoff: extra pause after an error so we don't hammer.
      await sleep(spacing)
      continue
    }

    const payload = JSON.stringify(res.availability)
    const payloadHash = hashPayload(payload)
    db.insert(availabilitySnapshots)
      .values({ snapshotKey: key, platform, facilityId, monthKey, payload, payloadHash })
      .onConflictDoUpdate({
        target: availabilitySnapshots.snapshotKey,
        set: {
          payload,
          payloadHash,
          fetchedAt: new Date().toISOString().replace('Z', 'Z'),
        },
      })
      .run()
    results.set(key, { prev, fresh: res.availability })
  }

  // Diff + dispatch per watch.
  for (const w of dueWatchable) {
    summary.watchesPolled += 1
    let hadError = false
    let errorStatus: number | undefined
    const filters = parseFilters(w.siteFilters)

    for (const monthKey of monthKeysBetween(w.startDate, w.endDate)) {
      if (monthKey < today.slice(0, 7)) continue
      const r = results.get(snapshotKey(w.platform, w.facilityId, monthKey))
      if (!r || r.fresh === null) {
        hadError = true
        if (r?.status) errorStatus = r.status
        continue
      }
      const matches = diffAvailability(r.prev, r.fresh, {
        startDate: w.startDate < today ? today : w.startDate,
        endDate: w.endDate,
        minNights: w.minNights,
        filters,
      })
      if (matches.length > 0 && summary.alertsSent < maxSmsPerTick) {
        const disp = await dispatchMatches(db, w, matches, options.dispatchDeps)
        summary.alertsSent += disp.sent
        if (disp.sent > 0) log('watch_alerts_sent', { watchId: w.id, count: disp.sent })
      } else if (matches.length > 0) {
        log('watch_sms_cap_reached', { watchId: w.id, cap: maxSmsPerTick })
      }
    }

    db.update(watches)
      .set({
        lastPolledAt: nowDate.toISOString(),
        lastPollStatus: hadError ? pollErrorMessage(errorStatus) : 'ok',
      })
      .where(eq(watches.id, w.id))
      .run()
  }

  return summary
}

/**
 * Liveness of the in-process loop, read by `/health/ready` (src/server/health/readiness.ts).
 * Null until startWatchScheduler runs. `lastTickOkAt` moves only when a tick COMPLETES without
 * throwing: per-fetch provider errors are caught inside runOneTick and don't count against it, but
 * a tick that throws (e.g. the DB) does.
 */
export interface WatcherRuntimeStatus {
  startedAt: number
  tickMs: number
  pollIntervalMs: number
  lastTickOkAt: number | null
}

// Held on globalThis, NOT in a module variable: under tsx, server/production.mjs (ESM) and askRoute.ts
// (loaded as CJS — package.json has no "type") each get their OWN instance of this module, so a
// module-level variable set by the scheduler's caller was invisible to /health/ready, which read
// `not_started` while the watcher ran (observed 2026-10-30). Symbol.for is process-wide.
const STATUS_KEY = Symbol.for('campscout.watcherStatus')
type StatusHolder = { [STATUS_KEY]?: WatcherRuntimeStatus | null }
const holder = globalThis as unknown as StatusHolder

export function getWatcherStatus(): WatcherRuntimeStatus | null {
  const status = holder[STATUS_KEY]
  return status ? { ...status } : null
}

/** Test helper: forget any started scheduler. */
export function __resetWatcherStatusForTests(): void {
  holder[STATUS_KEY] = null
}

/** Start the recurring scheduler. Returns a stop handle. */
export function startWatchScheduler(
  db: Db,
  options: SchedulerOptions = {},
): { stop: () => void } {
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS
  const log = options.logger ?? (() => {})
  let running = false
  const status: WatcherRuntimeStatus = {
    startedAt: Date.now(),
    tickMs,
    pollIntervalMs:
      (options.defaultPollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000,
    lastTickOkAt: null,
  }
  holder[STATUS_KEY] = status

  const timer = setInterval(() => {
    if (running) return // no overlapping ticks (SQLite single-writer)
    running = true
    void runOneTick(db, options)
      .then((s) => {
        status.lastTickOkAt = Date.now()
        if (s.watchesPolled > 0) log('watch_tick', { ...s })
      })
      .catch((err) => log('watch_tick_error', { error: String(err) }))
      .finally(() => {
        running = false
      })
  }, tickMs)
  if (typeof timer.unref === 'function') timer.unref()

  log('watch_scheduler_started', { tickMs })
  return {
    stop: () => clearInterval(timer),
  }
}
