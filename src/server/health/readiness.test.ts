/** @jest-environment node */
import { evaluateReadiness, watcherStaleAfterMs, type WatcherStatus } from './readiness.js'

const T0 = Date.parse('2026-10-30T12:00:00Z')
// The prod scheduler's real numbers: tickMs 30s (DEFAULT_TICK_MS), poll 300s (fly.toml).
const watcher = (over: Partial<WatcherStatus> = {}): WatcherStatus => ({
  startedAt: T0,
  tickMs: 30_000,
  pollIntervalMs: 300_000,
  lastTickOkAt: T0 + 30_000,
  ...over,
})
const dbOk = () => {}
const dbThrows = () => {
  throw new Error('SQLITE_CANTOPEN: unable to open database file /data/campscout.sqlite')
}

describe('evaluateReadiness', () => {
  it('is ready when the DB answers and the watcher ticked recently', () => {
    const r = evaluateReadiness({
      checkDb: dbOk,
      watcherEnabled: true,
      watcherStatus: () => watcher(),
      now: () => T0 + 60_000,
    })
    expect(r.statusCode).toBe(200)
    expect(r.body).toEqual({ status: 'ready', failed: [], checks: { db: 'ok', watcher: 'ok' } })
  })

  it('is 503 naming the db when the DB check throws, without leaking the error text', () => {
    const r = evaluateReadiness({
      checkDb: dbThrows,
      watcherEnabled: true,
      watcherStatus: () => watcher(),
      now: () => T0 + 60_000,
    })
    expect(r.statusCode).toBe(503)
    expect(r.body.status).toBe('not_ready')
    expect(r.body.failed).toEqual(['db'])
    expect(r.body.checks.db).toBe('fail')
    expect(JSON.stringify(r.body)).not.toContain('/data/campscout.sqlite')
  })

  it('is 503 naming the watcher when its last good tick is older than the threshold', () => {
    const status = watcher({ lastTickOkAt: T0 })
    const r = evaluateReadiness({
      checkDb: dbOk,
      watcherEnabled: true,
      watcherStatus: () => status,
      now: () => T0 + watcherStaleAfterMs(status) + 1,
    })
    expect(r.statusCode).toBe(503)
    expect(r.body.failed).toEqual(['watcher'])
    expect(r.body.checks.watcher).toBe('stale')
  })

  it('is still ready exactly at the threshold (boundary)', () => {
    const status = watcher({ lastTickOkAt: T0 })
    const r = evaluateReadiness({
      checkDb: dbOk,
      watcherEnabled: true,
      watcherStatus: () => status,
      now: () => T0 + watcherStaleAfterMs(status),
    })
    expect(r.statusCode).toBe(200)
  })

  it('is ready just after boot, before the first tick has run', () => {
    const r = evaluateReadiness({
      checkDb: dbOk,
      watcherEnabled: true,
      watcherStatus: () => watcher({ lastTickOkAt: null }),
      now: () => T0 + 5_000,
    })
    expect(r.statusCode).toBe(200)
    expect(r.body.checks.watcher).toBe('ok')
  })

  it('is 503 when the watcher started but never completed a tick within the threshold', () => {
    const status = watcher({ lastTickOkAt: null })
    const r = evaluateReadiness({
      checkDb: dbOk,
      watcherEnabled: true,
      watcherStatus: () => status,
      now: () => T0 + watcherStaleAfterMs(status) + 1,
    })
    expect(r.statusCode).toBe(503)
    expect(r.body.failed).toEqual(['watcher'])
  })

  it('is 503 naming the watcher when it is enabled but never started', () => {
    const r = evaluateReadiness({
      checkDb: dbOk,
      watcherEnabled: true,
      watcherStatus: () => null,
      now: () => T0,
    })
    expect(r.statusCode).toBe(503)
    expect(r.body.failed).toEqual(['watcher'])
    expect(r.body.checks.watcher).toBe('not_started')
  })

  it('does not count a watcher that is not configured as a failure', () => {
    const r = evaluateReadiness({
      checkDb: dbOk,
      watcherEnabled: false,
      watcherStatus: () => null,
      now: () => T0,
    })
    expect(r.statusCode).toBe(200)
    expect(r.body).toEqual({
      status: 'ready',
      failed: [],
      checks: { db: 'ok', watcher: 'not_configured' },
    })
  })

  it('names both checks when both fail', () => {
    const r = evaluateReadiness({
      checkDb: dbThrows,
      watcherEnabled: true,
      watcherStatus: () => null,
      now: () => T0,
    })
    expect(r.statusCode).toBe(503)
    expect(r.body.failed).toEqual(['db', 'watcher'])
  })
})

describe('watcherStaleAfterMs', () => {
  it('is two poll intervals (600s with the prod 300s poll) when that exceeds ten ticks', () => {
    expect(watcherStaleAfterMs(watcher())).toBe(600_000)
  })

  it('never drops below ten ticks for a short poll interval', () => {
    expect(watcherStaleAfterMs(watcher({ pollIntervalMs: 10_000 }))).toBe(300_000)
  })
})
