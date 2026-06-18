/**
 * HIBP k-Anonymity password leak check (api.md §1.1).
 *
 * Uses the Have I Been Pwned k-Anonymity API so the full SHA-1 hash
 * is never sent to the remote server — only the first 5 hex chars.
 *
 * https://haveibeenpwned.com/API/v3#SearchingPwnedPasswordsByRange
 */

const HIBP_API = 'https://api.pwnedpasswords.com/range/'

/**
 * Check whether a password appears in known data breaches.
 * Returns true if the password was NOT found (safe), false if leaked.
 */
export async function isPasswordNotLeaked(password: string): Promise<boolean> {
  try {
    // SHA-1 hash the password
    const enc = new TextEncoder()
    const digest = await crypto.subtle.digest('SHA-1', enc.encode(password))
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()

    const prefix = hex.slice(0, 5)
    const suffix = hex.slice(5)

    const res = await fetch(`${HIBP_API}${prefix}`, {
      headers: { 'User-Agent': 'TransCircle' },
      signal: AbortSignal.timeout(3000),
    })

    if (!res.ok) {
      // API unavailable — allow the password through (fail open)
      return true
    }

    const body = await res.text()
    for (const line of body.split('\n')) {
      const [hashSuffix] = line.split(':')
      if (hashSuffix === suffix) {
        return false // password found in breaches
      }
    }

    return true // not found
  } catch {
    // Network error — fail open
    return true
  }
}
