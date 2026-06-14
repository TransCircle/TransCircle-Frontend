/**
 * Business metrics counters per api.md §13.2.2.
 * Shared across route modules; exported singleton so all imports
 * share the same counters.
 */

export const metrics = {
  // ── HTTP counters (from Router.ts) ──
  httpTotal: 0,
  httpByStatus: {} as Record<string, number>,
  httpByPath: {} as Record<string, number>,
  httpByMethodPathStatus: {} as Record<string, number>,

  // ── Business metrics (api.md §13.2.2) ──
  authLoginTotal: {} as Record<string, number>,          // result → count
  authTokenRefreshTotal: {} as Record<string, number>,   // result → count
  authOauthCallbackTotal: {} as Record<string, number>,  // provider|status → count
  mfaVerifyTotal: {} as Record<string, number>,          // method|result → count
  passkeyReplayDetectedTotal: 0,
  rateLimitedTotal: {} as Record<string, number>,        // route|dimension → count
  imageUploadTotal: {} as Record<string, number>,        // result|mime → count
  contributionReviewLatencySeconds: [] as number[],      // sample array for histogram (max 10000 entries)
  httpRequestDurationSeconds: [] as number[],             // timing samples for api.md §13.2.2 (max 10000 entries)
  MAX_HISTOGRAM_SAMPLES: 10000,
}

/** Push a value into a histogram array, capping at MAX_HISTOGRAM_SAMPLES to prevent memory leak */
export function pushHistogramSample(arr: number[], value: number, max = 10000): void {
  if (arr.length >= max) {
    arr.shift()
  }
  arr.push(value)
}

export function resetMetrics(): void {
  metrics.httpTotal = 0
  metrics.httpByStatus = {}
  metrics.httpByPath = {}
  metrics.httpByMethodPathStatus = {}
  metrics.authLoginTotal = {}
  metrics.authTokenRefreshTotal = {}
  metrics.authOauthCallbackTotal = {}
  metrics.mfaVerifyTotal = {}
  metrics.passkeyReplayDetectedTotal = 0
  metrics.rateLimitedTotal = {}
  metrics.imageUploadTotal = {}
  metrics.contributionReviewLatencySeconds = []
  metrics.httpRequestDurationSeconds = []
}
