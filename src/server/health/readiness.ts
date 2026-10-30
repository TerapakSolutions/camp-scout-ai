/**
 * Readiness (`/health/ready`), as opposed to liveness (`/health`, which only proves the process
 * answers HTTP). Ready means:
 *   - db:      the SQLite database opens (incl. migrations) and answers a trivial query;
 *   - watcher: if the in-process availability watcher is enabled (WATCHER_ENABLED=true), it has
 *              completed a tick recently. Not enabled → `not_configured`, which is NOT a failure.
 *
 * Pure w.r.t. injected deps so it is unit tested without a server. The body names which check
 * failed and nothing else — never an error message, path, or user data.
 */

export interface WatcherStatus {
  /** When startWatchScheduler ran (epoch ms) — the baseline before the first tick lands. */
  startedAt: number
  tickMs: number
  /** The default per-watch poll interval: the cadence promised to every watch. */
  pollIntervalMs: number
  /** Last tick that completed WITHOUT throwing (epoch ms); null until the first one. */
  lastTickOkAt: number | null
}

export interface ReadinessDeps {
  /** Throws if the DB cannot be opened or queried. */
  checkDb: () => void
  watcherEnabled: boolean
  watcherStatus: () => WatcherStatus | null
  now?: () => number
}

export type DbCheck = 'ok' | 'fail'
export type WatcherCheck = 'ok' | 'stale' | 'not_started' | 'not_configured'

export interface ReadinessBody {
  status: 'ready' | 'not_ready'
  failed: Array<'db' | 'watcher'>
  checks: { db: DbCheck; watcher: WatcherCheck }
}

export interface ReadinessResult {
  statusCode: 200 | 503
  body: ReadinessBody
}

/**
 * How old the last good tick may be before the watcher counts as stuck.
 *
 * A tick is scheduled every `tickMs` (30s), but one tick fetches serially with 2.5–3.5s polite
 * spacing per (facility, month), and overlapping ticks are skipped — so a busy tick can legitimately
 * span several intervals. Two full poll intervals (600s with the prod 300s) means every watch has
 * missed its promised poll twice: clearly broken, not just busy. Floored at ten ticks for short
 * poll intervals. Deliberately generous: this app is ONE machine, so a false 503 here costs real
 * traffic (see fly.toml).
 */
export function watcherStaleAfterMs(status: WatcherStatus): number {
  return Math.max(2 * status.pollIntervalMs, 10 * status.tickMs)
}

function runDbCheck(checkDb: () => void): DbCheck {
  try {
    checkDb()
    return 'ok'
  } catch {
    return 'fail'
  }
}

function runWatcherCheck(deps: ReadinessDeps, nowMs: number): WatcherCheck {
  if (!deps.watcherEnabled) return 'not_configured'
  const status = deps.watcherStatus()
  if (!status) return 'not_started'
  const lastGood = status.lastTickOkAt ?? status.startedAt
  return nowMs - lastGood > watcherStaleAfterMs(status) ? 'stale' : 'ok'
}

export function evaluateReadiness(deps: ReadinessDeps): ReadinessResult {
  const nowMs = (deps.now ?? Date.now)()
  const db = runDbCheck(deps.checkDb)
  const watcher = runWatcherCheck(deps, nowMs)

  const failed: ReadinessBody['failed'] = []
  if (db !== 'ok') failed.push('db')
  if (watcher === 'stale' || watcher === 'not_started') failed.push('watcher')

  const ready = failed.length === 0
  return {
    statusCode: ready ? 200 : 503,
    body: { status: ready ? 'ready' : 'not_ready', failed, checks: { db, watcher } },
  }
}
