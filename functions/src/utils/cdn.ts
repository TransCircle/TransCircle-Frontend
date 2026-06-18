/**
 * CDN cache purge utility per api.md §6.4 / §6.6.
 *
 * On hide/delete, we must purge the public contribution endpoints so CDN
 * doesn't serve stale content. This module provides a pluggable purge function
 * that logs when no CDN provider is configured.
 *
 * Surrogate-Key pattern: contrib_<id>, list_contributions
 */

let _surrogateEnabled = false

export function enableSurrogateKeys(): void {
  _surrogateEnabled = true
}

export function isSurrogateEnabled(): boolean {
  return _surrogateEnabled
}

/**
 * Purge a single contribution from CDN cache.
 * Per api.md §6.4:
 *   /v1/public/contributions/{id}
 *   /v1/public/contributions?* (all cursor pages)
 */
export async function purgeContributionCache(contributionId: string): Promise<void> {
  const cdnUrl = process.env.CDN_PURGE_URL
  const cdnToken = process.env.CDN_PURGE_TOKEN

  if (!cdnUrl || !cdnToken) {
    // No CDN configured — log and skip (safe for dev/sandbox)
    console.log(`[CDN] Would purge contribution ${contributionId} (no CDN configured)`)
    return
  }

  const urls = [
    `/v1/public/contributions/${contributionId}`,
    `/v1/public/contributions?*`,
  ]

  try {
    const res = await fetch(`${cdnUrl}/purge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cdnToken}`,
      },
      body: JSON.stringify({
        surrogateKeys: [`contrib_${contributionId}`, 'list_contributions'],
        urls,
      }),
    })
    if (!res.ok) {
      console.error(`[CDN] Purge failed: ${res.status} ${await res.text()}`)
    } else {
      console.log(`[CDN] Purged contribution ${contributionId}`)
    }
  } catch (err) {
    console.error('[CDN] Purge error:', err)
  }
}
