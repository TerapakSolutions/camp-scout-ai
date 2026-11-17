/**
 * In-memory AI usage store for metrics, dashboards, and monitoring.
 */

import { recordBudgetUsage, __resetBudgetForTests } from '../db/budgetRepository.js'
import { estimateRequestCost } from './aiCostCalculator.js'

/** @typedef {{
 *   timestamp: string,
 *   endpoint: string,
 *   requestId: string,
 *   correlationId: string,
 *   model: string,
 *   provider: string,
 *   promptTokenEstimate: number,
 *   completionTokens: number,
 *   latencyMs: number,
 *   clientIp: string,
 *   authenticatedUser: string,
 *   responseStatus: number,
 *   estimatedCostUsd: number,
 *   cacheHit?: boolean,
 * }} AiRequestRecord */

const MAX_SLOWEST_REQUESTS = 20
const MAX_IP_TRACKING = 100

// Bound the retained records so a long-lived machine can't OOM. Retention
// covers today's UTC budget window (with margin); a hard ceiling guards
// against a burst inside that window. Aggregate counters (totalRequests,
// costs, …) are unaffected — only the raw record list is trimmed.
const RECORD_RETENTION_MS = 25 * 60 * 60 * 1000
const MAX_RECORDS = 10_000

/** @type {AiRequestRecord[]} */
const allRecords = []

/**
 * Drops records outside the retention window (records are appended in
 * timestamp order, so stale ones are always at the front).
 * @param {number} [nowMs]
 */
function pruneOldRecords(nowMs = Date.now()) {
  const cutoff = nowMs - RECORD_RETENTION_MS
  let removeCount = 0
  while (
    removeCount < allRecords.length &&
    new Date(allRecords[removeCount].timestamp).getTime() < cutoff
  ) {
    removeCount += 1
  }
  if (removeCount > 0) {
    allRecords.splice(0, removeCount)
  }
  if (allRecords.length > MAX_RECORDS) {
    allRecords.splice(0, allRecords.length - MAX_RECORDS)
  }
}

/** @type {Map<string, number>} */
const endpointCounts = new Map()

/** @type {Map<string, number>} */
const providerCounts = new Map()

/** @type {Map<number, number>} */
const statusCodeCounts = new Map()

/** @type {Map<string, number>} */
const ipCounts = new Map()

let totalRequests = 0
let failedRequests = 0
let successfulRequests = 0
let cacheHits = 0
let cacheMisses = 0
let fakeProviderRequests = 0
let openAiProviderRequests = 0
let totalInputTokens = 0
let totalOutputTokens = 0
let totalEstimatedCostUsd = 0
let totalLatencyMs = 0

/** @type {AiRequestRecord[]} */
let slowestRequests = []

/**
 * Returns today's date key in UTC.
 * @param {Date} [now]
 * @returns {string}
 */
export function getTodayKey(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

/**
 * Returns the current hour key in UTC.
 * @param {Date} [now]
 * @returns {string}
 */
export function getHourKey(now = new Date()) {
  return now.toISOString().slice(0, 13)
}

/**
 * Records an AI request in the usage store.
 * @param {AiRequestRecord} record
 */
export function recordAiRequest(record) {
  allRecords.push(record)
  pruneOldRecords()
  // Durable budget accounting (best-effort — a DB hiccup must never break
  // request handling). The in-memory aggregates below power the dashboard;
  // the SQLite buckets survive restarts and drive the spend cap.
  try {
    recordBudgetUsage({
      inputTokens: record.promptTokenEstimate,
      outputTokens: record.completionTokens,
      costUsd: record.estimatedCostUsd,
    })
  } catch (error) {
    process.stderr.write(
      `[ai-budget] failed to persist usage: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
  }
  totalRequests += 1

  if (record.responseStatus >= 200 && record.responseStatus < 400) {
    successfulRequests += 1
  } else {
    failedRequests += 1
  }

  endpointCounts.set(record.endpoint, (endpointCounts.get(record.endpoint) ?? 0) + 1)
  providerCounts.set(record.provider, (providerCounts.get(record.provider) ?? 0) + 1)
  statusCodeCounts.set(record.responseStatus, (statusCodeCounts.get(record.responseStatus) ?? 0) + 1)

  if (record.provider === 'fake') {
    fakeProviderRequests += 1
  } else if (record.provider === 'openai') {
    openAiProviderRequests += 1
  }

  totalInputTokens += record.promptTokenEstimate
  totalOutputTokens += record.completionTokens
  totalEstimatedCostUsd += record.estimatedCostUsd
  totalLatencyMs += record.latencyMs

  if (record.cacheHit === true) {
    cacheHits += 1
  } else if (record.cacheHit === false) {
    cacheMisses += 1
  }

  ipCounts.set(record.clientIp, (ipCounts.get(record.clientIp) ?? 0) + 1)

  slowestRequests = [...slowestRequests, record]
    .sort((a, b) => b.latencyMs - a.latencyMs)
    .slice(0, MAX_SLOWEST_REQUESTS)
}

/**
 * Records a cache hit without a full AI request.
 */
export function recordCacheHit() {
  cacheHits += 1
}

/**
 * Records a cache miss without a full AI request.
 */
export function recordCacheMiss() {
  cacheMisses += 1
}

/**
 * @param {Date} [now]
 * @returns {AiRequestRecord[]}
 */
export function getRecordsForToday(now = new Date()) {
  const todayKey = getTodayKey(now)
  return allRecords.filter((record) => record.timestamp.startsWith(todayKey))
}

/**
 * @param {Date} [now]
 * @returns {AiRequestRecord[]}
 */
export function getRecordsForCurrentHour(now = new Date()) {
  const hourKey = getHourKey(now)
  return allRecords.filter((record) => record.timestamp.startsWith(hourKey))
}

/**
 * @param {number} [limit]
 * @returns {AiRequestRecord[]}
 */
export function getRecentRecords(limit = 50) {
  return allRecords.slice(-limit).reverse()
}

/**
 * @returns {{
 *   totalRequests: number,
 *   requestsToday: number,
 *   estimatedInputTokens: number,
 *   estimatedOutputTokens: number,
 *   estimatedOpenAiCostUsd: number,
 *   averageRequestSizeTokens: number,
 *   averageResponseTimeMs: number,
 *   requestsByEndpoint: Record<string, number>,
 *   requestsByProvider: Record<string, number>,
 *   failedRequests: number,
 *   successfulRequests: number,
 *   cacheHits: number,
 *   cacheMisses: number,
 *   fakeProviderRequests: number,
 *   openAiProviderRequests: number,
 * }}
 */
export function getUsageSummary(now = new Date()) {
  const todayRecords = getRecordsForToday(now)
  const todayInputTokens = todayRecords.reduce((sum, r) => sum + r.promptTokenEstimate, 0)
  const todayOutputTokens = todayRecords.reduce((sum, r) => sum + r.completionTokens, 0)
  const todayCost = todayRecords.reduce((sum, r) => sum + r.estimatedCostUsd, 0)
  const todayLatency = todayRecords.reduce((sum, r) => sum + r.latencyMs, 0)

  const avgRequestSize = totalRequests > 0
    ? (totalInputTokens + totalOutputTokens) / totalRequests
    : 0
  const avgResponseTime = totalRequests > 0 ? totalLatencyMs / totalRequests : 0

  return {
    totalRequests,
    requestsToday: todayRecords.length,
    estimatedInputTokens: totalInputTokens,
    estimatedOutputTokens: totalOutputTokens,
    estimatedOpenAiCostUsd: totalEstimatedCostUsd,
    averageRequestSizeTokens: Math.round(avgRequestSize * 100) / 100,
    averageResponseTimeMs: Math.round(avgResponseTime * 100) / 100,
    requestsByEndpoint: Object.fromEntries(endpointCounts),
    requestsByProvider: Object.fromEntries(providerCounts),
    failedRequests,
    successfulRequests,
    cacheHits,
    cacheMisses,
    fakeProviderRequests,
    openAiProviderRequests,
    todayInputTokens,
    todayOutputTokens,
    todayEstimatedCostUsd: todayCost,
    todayAverageResponseTimeMs: todayRecords.length > 0
      ? Math.round((todayLatency / todayRecords.length) * 100) / 100
      : 0,
  }
}

/**
 * @param {Date} [now]
 * @returns {{
 *   requestsPerMinute: number,
 *   responses401: number,
 *   responses429: number,
 *   responses502: number,
 *   responses503: number,
 *   averageLatencyMs: number,
 *   slowestRequests: Array<{ endpoint: string, requestId: string, latencyMs: number, timestamp: string }>,
 *   busiestIps: Array<{ ip: string, count: number }>,
 * }}
 */
export function getEndpointMonitoring(now = new Date()) {
  const hourRecords = getRecordsForCurrentHour(now)
  const minutesInHour = Math.max(1, hourRecords.length > 0 ? 60 : 1)

  const responses401 = statusCodeCounts.get(401) ?? 0
  const responses429 = statusCodeCounts.get(429) ?? 0
  const responses502 = statusCodeCounts.get(502) ?? 0
  const responses503 = statusCodeCounts.get(503) ?? 0

  const hourLatency = hourRecords.reduce((sum, r) => sum + r.latencyMs, 0)

  const busiestIps = [...ipCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_IP_TRACKING)
    .map(([ip, count]) => ({ ip, count }))

  return {
    requestsPerMinute: Math.round((hourRecords.length / minutesInHour) * 100) / 100,
    responses401,
    responses429,
    responses502,
    responses503,
    averageLatencyMs: hourRecords.length > 0
      ? Math.round((hourLatency / hourRecords.length) * 100) / 100
      : 0,
    slowestRequests: slowestRequests.map((r) => ({
      endpoint: r.endpoint,
      requestId: r.requestId,
      correlationId: r.correlationId,
      latencyMs: r.latencyMs,
      timestamp: r.timestamp,
      responseStatus: r.responseStatus,
    })),
    busiestIps,
  }
}

/**
 * Computes daily and hourly budget usage totals.
 * @param {Date} [now]
 * @returns {{
 *   daily: { requests: number, inputTokens: number, outputTokens: number, estimatedCostUsd: number },
 *   hourly: { requests: number, inputTokens: number, outputTokens: number, estimatedCostUsd: number },
 * }}
 */
export function getBudgetUsage(now = new Date()) {
  const dailyRecords = getRecordsForToday(now)
  const hourlyRecords = getRecordsForCurrentHour(now)

  const sumRecords = (records) => ({
    requests: records.length,
    inputTokens: records.reduce((sum, r) => sum + r.promptTokenEstimate, 0),
    outputTokens: records.reduce((sum, r) => sum + r.completionTokens, 0),
    estimatedCostUsd: records.reduce((sum, r) => sum + r.estimatedCostUsd, 0),
  })

  return {
    daily: sumRecords(dailyRecords),
    hourly: sumRecords(hourlyRecords),
  }
}

/**
 * Creates a request record from handler context.
 * @param {{
 *   endpoint: string,
 *   requestId: string,
 *   correlationId: string,
 *   model?: string,
 *   provider: string,
 *   promptTokenEstimate?: number,
 *   completionTokens?: number,
 *   latencyMs: number,
 *   clientIp: string,
 *   authenticatedUser?: string,
 *   responseStatus: number,
 *   cacheHit?: boolean,
 * }} params
 * @returns {AiRequestRecord}
 */
export function buildRequestRecord(params) {
  const inputTokens = params.promptTokenEstimate ?? 0
  const outputTokens = params.completionTokens ?? 0
  const now = new Date()

  return {
    timestamp: now.toISOString(),
    endpoint: params.endpoint,
    requestId: params.requestId,
    correlationId: params.correlationId,
    model: params.model ?? 'unknown',
    provider: params.provider,
    promptTokenEstimate: inputTokens,
    completionTokens: outputTokens,
    latencyMs: params.latencyMs,
    clientIp: params.clientIp,
    authenticatedUser: params.authenticatedUser ?? 'anonymous',
    responseStatus: params.responseStatus,
    estimatedCostUsd: params.provider === 'openai'
      // Priced by the model that served it (no model → the configured active model).
      ? estimateRequestCost(inputTokens, outputTokens, params.model, now)
      : 0,
    cacheHit: params.cacheHit,
  }
}

/**
 * Clears all usage state (for tests).
 */
export function resetAiUsageStore() {
  try {
    __resetBudgetForTests()
  } catch {
    // DB not available in this context — in-memory reset below is enough.
  }
  allRecords.length = 0
  endpointCounts.clear()
  providerCounts.clear()
  statusCodeCounts.clear()
  ipCounts.clear()
  slowestRequests = []
  totalRequests = 0
  failedRequests = 0
  successfulRequests = 0
  cacheHits = 0
  cacheMisses = 0
  fakeProviderRequests = 0
  openAiProviderRequests = 0
  totalInputTokens = 0
  totalOutputTokens = 0
  totalEstimatedCostUsd = 0
  totalLatencyMs = 0
}

/**
 * @returns {AiRequestRecord[]}
 */
export function getAllRecords() {
  return [...allRecords]
}
