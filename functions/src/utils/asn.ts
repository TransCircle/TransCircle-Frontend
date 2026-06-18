/**
 * ASN (Autonomous System Number) lookup utility — api.md §1.1
 *
 * Supports:
 * 1. Optional external API (ip-api.com) — set ASN_API_URL env var
 * 2. Falls back to null when not configured (rate limiting skipped)
 *
 * Caches results in-memory to avoid repeated API calls.
 */

interface AsnResult {
  asn: string        // e.g. "AS15169"
  org: string        // e.g. "Google LLC"
}

const cache = new Map<string, AsnResult>()
const CACHE_TTL_MS = 3600_000  // 1 hour

// Track calls for global conflict alerting
let globalConflictCount = 0
let globalConflictWindowStart = 0
let globalConflictAlerted = false

export interface ConflictAlert {
  triggered: boolean
  count: number
  windowStart: number
}

/**
 * Look up ASN for an IP address.
 * Returns null if ASN lookup is not configured or fails.
 */
export async function lookupAsn(ip: string): Promise<AsnResult | null> {
  const apiUrl = process.env.ASN_API_URL
  if (!apiUrl) return null  // Not configured — skip ASN rate limiting

  const cached = cache.get(ip)
  if (cached) return cached

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)
    const res = await fetch(`${apiUrl}/${ip}?fields=as,org`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    })
    clearTimeout(timeout)

    if (!res.ok) return null
    const data = await res.json() as { as?: string; org?: string }
    if (!data.as) return null

    const result: AsnResult = { asn: data.as, org: data.org || '' }
    cache.set(ip, result)
    setTimeout(() => cache.delete(ip), CACHE_TTL_MS)
    return result
  } catch {
    return null
  }
}

/**
 * Track global registration conflict responses.
 * api.md §1.1: 全局 5 分钟冲突响应率 > 1000 次 → 触发告警
 * Returns true if alert threshold has been crossed.
 */
export function trackGlobalConflict(): ConflictAlert {
  const now = Date.now()
  const windowMs = 300_000  // 5 minutes

  if (now - globalConflictWindowStart > windowMs) {
    // New window
    globalConflictCount = 1
    globalConflictWindowStart = now
    globalConflictAlerted = false
  } else {
    globalConflictCount++
  }

  const triggered = globalConflictCount > 1000 && !globalConflictAlerted
  if (triggered) globalConflictAlerted = true

  return {
    triggered,
    count: globalConflictCount,
    windowStart: globalConflictWindowStart,
  }
}

/**
 * Reset global conflict counter (used in tests).
 */
export function resetGlobalConflictCounter(): void {
  globalConflictCount = 0
  globalConflictWindowStart = 0
  globalConflictAlerted = false
}
