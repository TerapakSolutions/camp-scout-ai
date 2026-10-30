/** @jest-environment node */
import type { Db } from '../db/index.js'
import { __resetWatcherStatusForTests, getWatcherStatus, startWatchScheduler } from './scheduler.js'

// Minimal stand-ins for the one query runOneTick makes first (select all watches).
const emptyDb = { select: () => ({ from: () => ({ all: () => [] }) }) } as unknown as Db
const throwingDb = {
  select: () => {
    throw new Error('SQLITE_BUSY')
  },
} as unknown as Db

const waitFor = async (cond: () => boolean, ms = 1000) => {
  const until = Date.now() + ms
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 5))
}

describe('watcher status (for /health/ready)', () => {
  let stop: (() => void) | null = null
  beforeEach(() => __resetWatcherStatusForTests())
  afterEach(() => {
    stop?.()
    stop = null
    __resetWatcherStatusForTests()
  })

  it('is null until the scheduler starts', () => {
    expect(getWatcherStatus()).toBeNull()
  })

  it('records start, tick and poll interval, then each tick that completes', async () => {
    const before = Date.now()
    stop = startWatchScheduler(emptyDb, { tickMs: 10, defaultPollIntervalSeconds: 300 }).stop
    const started = getWatcherStatus()
    expect(started).toMatchObject({ tickMs: 10, pollIntervalMs: 300_000, lastTickOkAt: null })
    expect(started!.startedAt).toBeGreaterThanOrEqual(before)

    await waitFor(() => getWatcherStatus()?.lastTickOkAt != null)
    expect(getWatcherStatus()!.lastTickOkAt).toBeGreaterThanOrEqual(started!.startedAt)
  })

  it('does NOT count a tick that throws as a good tick', async () => {
    let errors = 0
    stop = startWatchScheduler(throwingDb, {
      tickMs: 10,
      logger: (msg) => {
        if (msg === 'watch_tick_error') errors += 1
      },
    }).stop
    await waitFor(() => errors >= 2)
    expect(errors).toBeGreaterThanOrEqual(2)
    expect(getWatcherStatus()!.lastTickOkAt).toBeNull()
  })
})

// Prod runs under tsx: server/production.mjs (ESM) and askRoute.ts (loaded as CJS) each got their OWN
// instance of scheduler.ts, so /health/ready read `not_started` while the watcher was running
// (observed 2026-10-30 against a local production server). Two isolated module copies reproduce it.
describe('watcher status across module instances', () => {
  it('a scheduler started through one module copy is visible through another', () => {
    let a: typeof import('./scheduler.js') | undefined
    let b: typeof import('./scheduler.js') | undefined
    jest.isolateModules(() => {
      a = require('./scheduler.js')
    })
    jest.isolateModules(() => {
      b = require('./scheduler.js')
    })
    expect(a).not.toBe(b)
    a!.__resetWatcherStatusForTests()
    const handle = a!.startWatchScheduler(emptyDb, { tickMs: 60_000 })
    try {
      expect(b!.getWatcherStatus()).not.toBeNull()
    } finally {
      handle.stop()
      a!.__resetWatcherStatusForTests()
    }
  })
})
